/**
 * Insight Trading — data proxy + grading server  (Phase 1 + Phase 2)
 * ---------------------------------------------------------------------------
 * Phase 1: holds your EODData API key SERVER-SIDE and edge-caches market data.
 * Phase 2: GRADES your signals SERVER-SIDE. The proprietary grading maths
 *          (edge / t-stat / tier / score) lives ONLY here now — the browser
 *          sends the day's price series to POST /grades and gets back the graded
 *          table, so the formula is no longer readable in the page source.
 *
 * The key is a Worker SECRET named EODDATA_KEY (set in the dashboard as an
 * encrypted variable), never written in this file.
 *
 * Endpoints:
 *   GET  /                     → health
 *   GET  /eod/<eoddata-path>   → key-injected, edge-cached market data proxy
 *   POST /grades               → { exch, dataDate, shares:[{ticker,series:[{d,c,v}]}] }
 *                                → { ok, date, A }  (A = the graded audit object)
 *                                cached per exch+dataDate so it computes once/day.
 *
 * PER-SHARE SERIES FROM THE STORE (v385) — GET /history/series/EXCH/TICKER
 * serves a share's daily bars straight from D1 (the depth crawler's pantry):
 * microseconds instead of an EODData round-trip. The app tries this first and
 * silently falls back to the live routes while the pantry is still filling.
 *
 * US MARKET + DEPTH CRAWLER (v384) — adds a nightly NYSE ingest (gated to the
 * New York close, DST-aware, mirroring the Sydney logic) and a self-pacing
 * depth crawler: every cron firing quietly backfills a couple of OLDER trading
 * days (ASX to ~300 trading days, NYSE to ~220) so the signal report card gets
 * deep history without manual loads. Cursor-based (meta bf_cursor_*), advances
 * only on successful fetches, paced to stay far inside D1 free-tier quotas.
 *
 * AUTO-TRADE BRIDGE QUEUE (v382) — the app's auto-pilot queues its practice
 * picks here; the desktop bridge pulls them for its DRY-RUN preview. Dormant
 * until the BRIDGE_KEY secret exists (invented + set by Tony in the dashboard,
 * never written in this file). Reuses the MARKET_DB (D1) binding.
 *   POST /bridge/push          → app-side (ACCESS_KEY gate): {day, orders:[…]}
 *                                idempotent upsert into bridge_queue by order id
 *   GET  /bridge/pull?day=…    → bridge-side (X-Bridge-Key): today's queued orders
 *                                (&all=1 to include done ones)
 *   POST /bridge/ack           → bridge-side (X-Bridge-Key): {ids:[…]} mark done
 *
 * NEWS FEED (v386) — real headlines for the SHORTLIST only. The app registers
 * the shares it actually cares about (holdings + watchlist + today's picks);
 * a few of the stalest are polled on each cron firing from free per-ticker
 * feeds, classified, de-duplicated and stored in D1. Never a whole-market
 * crawl — ~40 tickers a day, each at most once a day.
 * DORMANT until the plain variable NEWS_ON is set to 1 in the dashboard.
 *   POST /news/watch           → app-side (ACCESS_KEY gate): {exch,hold,watch,picks}
 *   GET  /news/for?exch&ticker → one share's stored headlines
 *   GET  /news/days?exch&days  → compact [ticker,day,weight,count] rows for the
 *                                report cards, so "had news" stops being a guess
 *   GET  /news/status          → what's armed, what's stored, when it last ran
 *   GET  /admin/news/{poll,watch,peek,reclass}?key=…  → hand-run, seed, eyeball,
 *                                and re-grade what was captured under older rules
 * v387: a headline is only stored if it actually NAMES the company (by ticker or
 * by a distinctive word from its registered name), so a sector story about a
 * rival can no longer set a "had news" flag.
 * v388: POST /grades now feeds the Signal card's 📢/🔇 split from the news
 * store — the grading engine's announcement socket (_annPS) had been empty
 * since it shipped, so those buttons never had data. Coverage is claimed only
 * for shortlisted tickers; everything else remains honestly "unknown". Also
 * /admin/news/poll accepts &force=1 to bypass the 20-hour re-poll gap.
 */

const ALLOWED_ORIGINS = [
  'https://teecee1313.github.io',   // customer app + beta (GitHub Pages)
  'http://localhost:8788',
  'http://127.0.0.1:8788',
];
const ALLOWED_PREFIXES = ['symbol/list/', 'quote/list/', 'technical/list/'];   // w392: technical too, so the app need not use a public relay for a keyed URL
// w392: the ASX announcements token used to be written into index.html, which
// anyone can download. It lives here instead. Whether it turns out to be a
// token issued to Tony or the one the ASX website itself uses, a credential in
// a published file is a credential you have given away.
const ASX_ANN_TOKEN = '83ff96335c2d45a094df02a206a39ff4';
// v389: was 6h. The app's list URLs carry no date, so ONE cache entry per colo
// straddled the close and served yesterday's prices for hours after new EOD
// landed. 30 min keeps the edge doing its job without hiding a fresh close.
const CACHE_SECONDS = 30 * 60;            // market data: 30 min
const GRADE_CACHE_SECONDS = 20 * 60 * 60; // graded table: once per trading day
const _GC_ORIGIN = 'https://insight-grades.cache'; // w421: pantry-grade cache keys are synthetic — a FIXED origin lets scheduled() warm the same keys fetch() serves (url.origin would differ per hostname and does not exist in a cron)

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, X-Insight-Access, X-Bridge-Key, X-Insight-Admin, X-Insight-Train, X-Insight-Device',
    // w526: X-Insight-Device was added by app v748 for the trial-key device
    // slots. A custom header not named here fails CORS PREFLIGHT, so the
    // browser blocks the request before it is ever sent — the app showed
    // 'Failed to fetch' on every server call while the same worker answered
    // plain page loads perfectly. Any NEW request header must be added here.
    'Vary': 'Origin',
  };
}
function json(obj, status, origin, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin), ...(extra || {}) },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCESS GATE (v380) — a shared password enforced SERVER-SIDE.
// The password lives ONLY as a Worker SECRET named ACCESS_KEY (set in the
// dashboard exactly like EODDATA_KEY, never written in this file). While that
// secret is UNSET the gate is dormant and everything behaves exactly as before,
// so deploying this Worker changes nothing until you add the secret. Once it's
// set, /eod/* and /grades refuse any request whose X-Insight-Access header does
// not match — the app shows a lock screen and sends that header on every call.
// The health endpoint stays public and reports whether the gate is armed.
// ═══════════════════════════════════════════════════════════════════════════
function _ctEq(a, b) { // constant-time-ish compare so the password can't be guessed by timing
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let d = 0; for (let i = 0; i < ea.length; i++) d |= ea[i] ^ eb[i];
  return d === 0;
}
// ═══════════════════════════════════════════════════════════════════════════
// w524 · TRIAL KEYS — per-person codes with expiry, revoke and device slots.
// The master ACCESS_KEY secret is unchanged and unlimited: existing testers
// notice nothing. A trial key is a row in D1, so expiry enforces itself and a
// revoke takes effect on the next request — neither was possible with the old
// per-customer codes baked into the HTML (see the 27 Jul leak: a shipped file
// can never take a code back).
async function _akInit(env){
  if(!env.MARKET_DB) return false;
  if(_akInit._done) return true;
  await env.MARKET_DB.prepare(
    'CREATE TABLE IF NOT EXISTS access_keys (code TEXT PRIMARY KEY, label TEXT, created TEXT, expires TEXT, revoked INTEGER DEFAULT 0, max_devices INTEGER DEFAULT 2, devices TEXT DEFAULT "", last_seen TEXT, last_city TEXT, hits INTEGER DEFAULT 0)'
  ).run();
  _akInit._done = true; return true;
}
function _akNewCode(){
  // no 0/O/1/I/5/S — these get read aloud and typed on phones
  const AB='ABCDEFGHJKLMNPQRTUVWXYZ23468'; let out='TRIAL-';
  const r=new Uint8Array(8); crypto.getRandomValues(r);
  for(let i=0;i<8;i++){ out += AB[r[i] % AB.length]; if(i===3) out+='-'; }
  return out;
}
// Checks a typed code. Returns null when it isn't a live trial key, else a
// verdict object. Device slots are consumed on FIRST SIGHT of a device id:
// a shared code spends the sharer's own second slot, which is what makes
// casual sharing self-limiting without punishing an honest phone+laptop.
async function _akCheck(env, code, devId, city){
  if(!env.MARKET_DB || !code) return null;
  try{
    await _akInit(env);
    const row = await env.MARKET_DB.prepare('SELECT * FROM access_keys WHERE code=?').bind(String(code).trim().toUpperCase()).first();
    if(!row) return null;
    if(row.revoked) return { ok:false, reason:'revoked' };
    const now = new Date();
    if(row.expires && new Date(row.expires) < now) return { ok:false, reason:'expired', expires:row.expires };
    let devs = String(row.devices||'').split(',').filter(Boolean);
    const d = String(devId||'').slice(0,40);
    if(d && !devs.includes(d)){
      const cap = +row.max_devices || 2;
      if(devs.length >= cap) return { ok:false, reason:'devices', cap };
      devs.push(d);
    }
    await env.MARKET_DB.prepare('UPDATE access_keys SET devices=?, last_seen=?, last_city=?, hits=hits+1 WHERE code=?')
      .bind(devs.join(','), now.toISOString(), String(city||'').slice(0,40), row.code).run();
    return { ok:true, label:row.label, expires:row.expires };
  }catch(e){ return null; }
}
async function gateStatus(request, env) {
  // w413: TRIM BOTH SIDES. A secret pasted into the dashboard very often carries
  // a trailing space or newline, and a phone keyboard can add one to what the
  // tester types — both invisible, and both made a CORRECT password fail
  // forever with no way to see why (Tony, 30 Jul: right word, refused on the
  // phone, accepted nowhere). Whitespace at either end is never meaningful in a
  // password anyone types by hand, so it cannot be a legitimate part of the key.
  const key = String((env && env.ACCESS_KEY) || '').trim();
  if (!key) return { configured: false, ok: true };           // dormant until the secret exists
  const sent = String(request.headers.get('X-Insight-Access') || '').trim();
  if(_ctEq(sent, key)) return { configured: true, ok: true, master: true };
  // not the master password — it may still be a live trial code.
  const v = await _akCheck(env, sent,
    request.headers.get('X-Insight-Device') || '',
    (request.cf && request.cf.city) || '');
  if(v && v.ok) return { configured: true, ok: true, trial: true, label: v.label, expires: v.expires };
  return { configured: true, ok: false, why: (v && v.reason) || 'bad' };
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTO-TRADE BRIDGE QUEUE (v382). The whole feature is DORMANT until the
// BRIDGE_KEY secret exists — pasting this Worker changes nothing until then.
// The app pushes with the normal ACCESS_KEY gate; ONLY the desktop bridge
// (holding BRIDGE_KEY) can pull/ack. Orders here are INTENTIONS for a DRY-RUN
// preview — nothing in this Worker places, or can place, a trade anywhere.
// ═══════════════════════════════════════════════════════════════════════════
// w508 — durable second layer under the colo cache. caches.default is
// per-datacentre and freely evicted, so a phone landing on a cold colo used
// to trigger a full stored-year recompute (minutes, sometimes past the app's
// 150s patience — the "stuck checking signals" loop). Computed days now also
// persist in meta under ccache| keys, so ANY colo answers instantly and then
// heals its own cache. Keys are the cache URL minus origin; 14-day cleanup
// rides along with each write.
function _d1cKey(u) { return 'ccache|' + String(u).replace(/^https?:\/\/[^/]+/, '').slice(0, 380); }
async function _d1cGet(env, u) { try { const r = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind(_d1cKey(u)).first(); return (r && r.v) || null; } catch (e) { return null; } }
function _d1cPut(env, ctx, u, body) { try { if (!body || body.length > 900000) return; const now = new Date().toISOString(); ctx.waitUntil(env.MARKET_DB.batch([ env.MARKET_DB.prepare('INSERT INTO meta (k,v,updated) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated=excluded.updated').bind(_d1cKey(u), body, now), env.MARKET_DB.prepare("DELETE FROM meta WHERE k LIKE 'ccache|%' AND updated < datetime('now','-14 day')") ])); } catch (e) {} }
async function _connEnsure(env) { try { await env.MARKET_DB.prepare("CREATE TABLE IF NOT EXISTS broker_connect (id INTEGER PRIMARY KEY AUTOINCREMENT, cust TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'requested', portal_url TEXT, st_user_id TEXT, st_user_secret TEXT, accounts TEXT, account_id TEXT, note TEXT, created TEXT, updated TEXT)").run(); } catch (e) {} }
function bridgeAuth(request, env, url) {
  if (!env.BRIDGE_KEY) return { status: 503, body: { error: 'bridge not configured (set the BRIDGE_KEY secret)' } };
  // w392: header only. A key in a query string lands in request logs, browser
  // history and any Referer a linked page emits — for no benefit at all.
  const sent = request.headers.get('X-Bridge-Key') || '';
  if (!_ctEq(sent, String(env.BRIDGE_KEY))) return { status: 401, body: { error: 'bad bridge key' } };
  return null;
}
function _sanOrder(o) {
  if (!o || typeof o !== 'object') return null;
  const id = String(o.id || '').trim().slice(0, 64); if (!id) return null;
  const action = String(o.action || 'BUY').toUpperCase(); if (action !== 'BUY' && action !== 'SELL') return null;
  const ticker = String(o.ticker || '').toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 12); if (!ticker) return null;
  const qty = Math.floor(+o.qty || 0); if (!(qty > 0 && qty <= 10000000)) return null;
  const num = (x) => { const n = +x; return isFinite(n) && n > 0 ? n : null; };
  return {
    id, action, ticker, qty,
    exchange: String(o.exchange || 'ASX').slice(0, 8),
    order_type: String(o.order_type || 'LIMIT').toUpperCase() === 'MARKET' ? 'MARKET' : 'LIMIT',
    limit: num(o.limit), target: num(o.target), stop: num(o.stop),
    note: String(o.note || '').slice(0, 160),
  };
}
const _BQ_INSERT = "INSERT INTO bridge_queue (id,day,exch,payload,status,created) VALUES (?,?,?,?,'new',?) ON CONFLICT(id) DO NOTHING";
const _BQ_PULL_NEW = "SELECT id,day,exch,payload,status,created FROM bridge_queue WHERE day=? AND status='new' ORDER BY created,id";
const _BQ_PULL_ALL = "SELECT id,day,exch,payload,status,created FROM bridge_queue WHERE day=? ORDER BY created,id";
const _BQ_ACK = "UPDATE bridge_queue SET status='done', acked=? WHERE id=?";

// ═══════════════════════════════════════════════════════════════════════════
// GRADING ENGINE — faithful port of the in-browser maths (index.html).
// Verified byte-identical by /root/verify_grading_parity.js. Keep in sync with
// /root/insight-server/grading_engine.js (the canonical, tested copy).
// ═══════════════════════════════════════════════════════════════════════════
const _AUD = { HOLD:5, DAYS:250, MINROWS:70, LIQ_FLOOR:50000, SEQ_LOOK:3, BO_LOOK:250, VR_LOOK:60, FLAT_MAX:0.40, STALE_DAYS:10,   // w418: a share whose price sits unchanged most days contributes no information and enormous variance — it drowns real edges   // w415: fixed lookbacks — breakout = 1-year high, vol record = 3-month high   // v389: DAYS 140→250 — the Signal card now grades over up to a YEAR, matching the client-side cards (v443). Shares with shallower history grade over what exists, as always.
  CMB_KEYS:['bo','inf','inst','cx','vr','blk'], SEQ_A:['inf','inst','vr','blk'], SEQ_B:['bo','cx'] };
// ANNOUNCEMENT SOURCE (v388). This socket sat EMPTY (= null) from the day the
// grading engine shipped, which meant the Signal card's 📢 news-driven / 🔇
// quiet buttons graded nothing — every fire fell into "unknown". It is now
// built per-request from the news store: material headlines (weight ≥ 0.5)
// become the confirmed-announcement record, and ONLY tickers actually on the
// news shortlist claim coverage — everything else stays honestly "unknown".
const _ANN_MIN_WEIGHT = 0.5;
async function _annFromStore(env, exch) {
  if (!env || !env.MARKET_DB || !_newsOn(env)) return null;
  try {
    if (!(await _newsEnsure(env))) return null;
    const cov = await env.MARKET_DB.prepare('SELECT ticker FROM news_watch WHERE exch=?').bind(exch).all();
    const covered = new Set(((cov && cov.results) || []).map(r => r.ticker));
    if (!covered.size) return null;
    const rows = await env.MARKET_DB.prepare('SELECT ticker,d FROM news WHERE exch=? AND weight>=? LIMIT 40000').bind(exch, _ANN_MIN_WEIGHT).all();
    const days = new Set();
    let start = null;
    for (const r of ((rows && rows.results) || [])) {
      days.add(r.ticker + '|' + r.d);
      if (!start || r.d < start) start = r.d;
    }
    return {
      start,
      covered: covered.size,
      info(ticker, d0, d1) {
        const t = String(ticker || '').toUpperCase();
        if (!covered.has(t)) return { covered: false, hit: false };
        // any material headline on a calendar day in [d0 .. d1] (fire day or
        // the two trading days before — the exact promise in the app's tooltip)
        // w392: d0 and d1 are CALLER-SUPPLIED dates and this loop ran the whole
        // span between them — '0001-01-01' to '9999-12-31' cost 2.6 seconds of
        // CPU per record from a few kilobytes of request. The window the app's
        // tooltip actually promises is the fire day and the two before it, so
        // ten iterations is generous and anything beyond it was never meant.
        const a = new Date(d0 + 'T12:00:00Z'), b = new Date(d1 + 'T12:00:00Z');
        if (!(a <= b)) return { covered: true, hit: false };
        let _steps = 0;
        for (let d = new Date(a); d <= b && _steps < 10; d.setUTCDate(d.getUTCDate() + 1), _steps++) {
          if (days.has(t + '|' + d.toISOString().slice(0, 10))) return { covered: true, hit: true };
        }
        return { covered: true, hit: false };
      },
    };
  } catch (e) { return null; }
}
function _auditNewCtx(allShares, hold, annPS, liqFloor, days){
  /* w419: an optional per-request turnover floor. The pantry-grading route
     lets the caller ask for $250k or $1m; anything absent, non-numeric or
     below the engine's own $50k floor falls back to _AUD.LIQ_FLOOR, so
     every existing caller (and the golden-reference audit, which lifts
     these functions verbatim) behaves exactly as before. */
  const defs={ bo:{name:'🚀 Breakout',dir:1}, inf:{name:'🕵️ Informed?',dir:1}, inst:{name:'🏦 Big money?',dir:1} /* w544: finishes the w530 one-language rename */, cx:{name:'⤴ MA cross',dir:1}, di:{name:'📉 Quiet selling?',dir:-1}, vr:{name:'🥇 Vol record',dir:0}, blk:{name:'🔷 Block day',dir:0} };
  const annAgg={}; Object.keys(defs).forEach(k=>annAgg[k]={news:{n:0,up:0,sum:0},quiet:{n:0,up:0,sum:0},unk:0});
  const shares=(Array.isArray(allShares)?allShares:[]).filter(s=>Array.isArray(s.series)&&s.series.length>=_AUD.MINROWS);
  // v383: the outcome window (5 / 10 / 30 trading days) rides on the CONTEXT, never
  // on the shared _AUD constant — concurrent requests with different holds are safe.
  const h=(hold===10||hold===30)?hold:_AUD.HOLD;
  // w418: the newest bar anywhere in the payload — the yardstick for staleness.
  let _newest='';
  for(const sh of shares){ const sr=sh.series; if(sr&&sr.length){ const d=sr[sr.length-1].d; if(d>_newest)_newest=d; } }
  const _lf=(isFinite(+liqFloor)&&+liqFloor>_AUD.LIQ_FLOOR)?Math.floor(+liqFloor):_AUD.LIQ_FLOOR;
  // w473 — the grading lookback rides on the CONTEXT now, the same way `hold`
  // was moved off the shared constant in v383 and for the same reason. It
  // defaults to _AUD.DAYS, so every existing caller — including the live app's
  // Signal Report Card path — behaves exactly as before. Only a caller that
  // asks for a different number gets one.
  const _dy=(isFinite(+days)&&+days>0)?Math.floor(+days):_AUD.DAYS;
  return {hold:h,days:_dy,liq:_lf,defs,annAgg,annPS:annPS||null,tailScan:false,today:[],M:{},base:{n:0,up:0,sum:0},day:{},recs:[],covered:0,liqSkipped:0,flatSkipped:0,staleSkipped:0,newest:_newest,from:null,to:null,shares};
}
function _auditRunAll(X){ for(let i=0;i<X.shares.length;i++)_auditOneShare(X.shares[i],X); return X; }
function _auditOneShare(s,X){
  const HOLD=X.hold||_AUD.HOLD, DAYS=X.days||_AUD.DAYS, MINROWS=_AUD.MINROWS, LIQ_FLOOR=(X.liq>=_AUD.LIQ_FLOOR?X.liq:_AUD.LIQ_FLOOR), SEQ_LOOK=_AUD.SEQ_LOOK;
  const _CMB_KEYS=_AUD.CMB_KEYS, SEQ_A=_AUD.SEQ_A, SEQ_B=_AUD.SEQ_B;
  const r=s.series, n=r.length;
  if(n<MINROWS)return;
  { let vs=0,vn=0; for(let q=Math.max(0,n-90);q<n;q++){ const $t=(r[q].v||0)*(r[q].c||0); if($t>0){vs+=$t;vn++;} }
    if(!(vn>0&&(vs/vn)>=LIQ_FLOOR)){ X.liqSkipped++; return; } }
  // w418 — TWO more tradeability gates, same principle as the turnover floor:
  // only grade shares where a percentage return actually means something.
  // (1) STALE: a share whose last bar is well behind the market's newest bar
  //     has stopped trading; its flat tail is not evidence of anything.
  if(X.newest && r[n-1].d){
    const _a=new Date(r[n-1].d+'T12:00:00Z'), _b=new Date(X.newest+'T12:00:00Z');
    if(isFinite(_a)&&isFinite(_b)&&((_b-_a)/86400000)>_AUD.STALE_DAYS){ X.staleSkipped++; return; }
  }
  // (2) FLAT: if the close is unchanged on more than FLAT_MAX of the last 90
  //     sessions, the share mostly sits still and then jumps a whole tick —
  //     contributing a mass of exact zeros plus rare huge outliers. That is
  //     variance without information, and it drowns real edges.
  { let flat=0,cnt=0;
    for(let q=Math.max(1,n-90);q<n;q++){ const a=r[q].c, b=r[q-1].c; if(a>0&&b>0){ cnt++; if(a===b)flat++; } }
    if(cnt>=30&&(flat/cnt)>_AUD.FLAT_MAX){ X.flatSkipped++; return; } }
  X.covered++;
  const cumV=new Array(n), cumVn=new Array(n), cumC=new Array(n), maxC=new Array(n), maxV=new Array(n);
  let cv=0, cvn=0, cc=0;
  // w415 (audit A4): maxC/maxV used to be the running max since the START of
  // whatever series was handed in — so the same predicate meant "highest ever
  // seen" and quietly changed meaning whenever the stored history grew (1yr →
  // 3yr) or shrank (an era slice). Breakouts became structurally rarer on the
  // live card mid-ledger, and era slices over-fired both flags. They are now
  // FIXED windows: a one-year price high and a three-month volume record.
  // O(n) rolling maxima via monotonic deques — no CPU cost worth measuring.
  const _roll=(get,win)=>{ const out=new Array(n), dq=[];
    for(let i=0;i<n;i++){
      out[i]=dq.length?get(dq[0]):0;                       // max over PRIOR bars only
      while(dq.length&&get(dq[dq.length-1])<=get(i))dq.pop();
      dq.push(i);
      while(dq.length&&dq[0]<=i-win)dq.shift();
    }
    return out; };
  const _mcW=_roll(i=>r[i].c||0,_AUD.BO_LOOK), _mvW=_roll(i=>r[i].v||0,_AUD.VR_LOOK);
  for(let i=0;i<n;i++){
    cv+=(r[i].v||0); if((r[i].v||0)>0)cvn++; cumV[i]=cv; cumVn[i]=cvn; cumC[i]=cc+(r[i].c||0); cc=cumC[i];
    maxC[i]=_mcW[i]; maxV[i]=_mvW[i];
  }
  const avgPrev=(i,len)=>{ const a=Math.max(0,i-len); if(i-a<=0)return 0; const cnt=(cumVn[i-1]||0)-(a>0?(cumVn[a-1]||0):0); if(cnt<=0)return 0; return (cumV[i-1]-(a>0?cumV[a-1]:0))/cnt; };
  const ma=(i,len)=>{ const a=i-len+1; if(a<0)return 0; return (cumC[i]-(a>0?cumC[a-1]:0))/len; };
  const lo=Math.max(60,n-2-HOLD-DAYS), hi=n-2-HOLD;
  const mid=lo+Math.floor((hi-lo)/2);
  const prevF=[]; const lastFired={};
  const _tailTo=(X.tailScan===true)?n:hi;   // w484: only walk the tail when asked
  for(let i=Math.max(60,lo-SEQ_LOOK);i<_tailTo;i++){
    const c0=r[i].c, cP=r[i-1].c, vol=r[i].v||0;
    // w484 — the forward bars may not exist on the newest days. Reading them
    // straight off the array would throw; reading them conditionally lets the
    // same loop run to the end of the series.
    const c1=(i+1<n)?r[i+1].c:0, cH=(i+1+HOLD<n)?r[i+1+HOLD].c:0;
    const a90=avgPrev(i,90);
    // flags need only today and the history behind it; the outcome needs the
    // forward bars. Splitting the two is what lets the tail be scanned at all.
    const validF=(c0>0&&cP>0&&a90>0);
    const valid=(validF&&c1>0&&cH>0);
    let f=null, out=0, chg=0;
    if(validF){
      chg=((c0-cP)/cP)*100;
      const ratio=vol/a90;
      if(valid){ out=((cH-c1)/c1)*100; out=Math.max(-35,Math.min(35,out)); }
      f={ inf: chg>0&&chg<8&&vol>5000&&ratio>1.8, inst: chg>0&&vol>30000&&ratio>1.5, di: chg<0&&chg>-25&&vol>5000&&ratio>1.8, bo: c0>maxC[i]*1.0005&&ratio>1.5&&maxC[i]>0, vr: vol>10000&&maxV[i]>0&&vol>=maxV[i]*1.05, blk: ratio>2, cx: (i>=50)&&ma(i,20)>ma(i,50)&&ma(i-1,20)<=ma(i-1,50) };
    }
    // w484 — i<hi is now EXPLICIT. The loop used to stop at hi, so the bound did
    // this job implicitly; extending it for the tail let i===hi through, and that
    // day still has both forward bars, so it silently added one graded firing per
    // share and moved every score. Caught by asserting grading is byte-identical
    // with the tail on and off — the whole reason that assertion exists.
    if(valid && i>=lo && i<hi){
      const dk=r[i].d;
      const D=X.day[dk]||(X.day[dk]={n:0,sum:0,bu:0,bn:0});
      D.n++; D.sum+=out; D.bn++; if(chg>0)D.bu++;
      X.base.n++; if(out>0)X.base.up++; X.base.sum+=out;
      if(X.from===null)X.from=r[lo].d; X.to=r[hi-1].d;
      const half=(i>=mid)?'b':'a';
      const fired=_CMB_KEYS.filter(k=>f[k]);
      const ks=[];
      for(const k in f){ if(f[k])ks.push(k); }
      if(f.vr){ if(chg>0)ks.push('vr+'); else if(chg<0)ks.push('vr-'); }
      if(f.blk){ if(chg>0)ks.push('blk+'); else if(chg<0)ks.push('blk-'); }
      for(let x=0;x<fired.length;x++)for(let y=x+1;y<fired.length;y++){
        ks.push(fired[x]+'+'+fired[y]);
        for(let z=y+1;z<fired.length;z++)ks.push(fired[x]+'+'+fired[y]+'+'+fired[z]);
      }
      for(const bk of SEQ_B){ if(f[bk]){ for(const ak of SEQ_A){ if(prevF.some(st=>st&&st.has(ak)))ks.push(ak+'>'+bk); } } }
      const ksd=ks.filter(k=>{ const lf=lastFired[k]; if(lf!=null&&(i-lf)<HOLD)return false; lastFired[k]=i; return true; });
      if(ksd.length){
        let annSt=null;
        if(X.annPS){ annSt=X.annPS.info(s.ticker, r[Math.max(0,i-2)].d, r[i].d); }
        X.recs.push({ks:ksd,out,d:dk,half,ann:annSt,ticker:s.ticker}); // w433: ticker added — purely additive, existing consumers (M[] aggregation) never read it
      }
    }
    // w484 — the tail: days too new to have an outcome, recorded separately so
    // the daily picker can see what fired TODAY. X.recs is untouched, so every
    // score, edge and tier on the report card is exactly what it was before.
    if(X.tailScan===true && validF && i>=hi){
      const ksT=[]; for(const k in f){ if(f[k])ksT.push(k); }
      if(f.vr){ if(chg>0)ksT.push('vr+'); else if(chg<0)ksT.push('vr-'); }
      if(f.blk){ if(chg>0)ksT.push('blk+'); else if(chg<0)ksT.push('blk-'); }
      const firedT=_CMB_KEYS.filter(k=>f[k]);
      for(let x=0;x<firedT.length;x++)for(let y=x+1;y<firedT.length;y++){
        ksT.push(firedT[x]+'+'+firedT[y]);
        for(let z=y+1;z<firedT.length;z++)ksT.push(firedT[x]+'+'+firedT[y]+'+'+firedT[z]);
      }
      for(const bk of SEQ_B){ if(f[bk]){ for(const ak of SEQ_A){ if(prevF.some(st=>st&&st.has(ak)))ksT.push(ak+'>'+bk); } } }
      if(ksT.length)(X.today||(X.today=[])).push({ks:ksT,d:r[i].d,ticker:s.ticker});
    }
    prevF.push(validF?new Set(_CMB_KEYS.filter(k=>f[k])):null);
    if(prevF.length>SEQ_LOOK)prevF.shift();
  }
}
// w416 (audit A5): strength across DAYS. Takes {day: [n,sum]} and returns the
// t-statistic of the per-day mean excess. Fewer than 3 days is not evidence of
// anything, so it returns 0 rather than a large number from two observations.
function _clusterT(dayMap){
  const means=[];
  for(const d in dayMap){ const a=dayMap[d]; if(a&&a[0]>0)means.push(a[1]/a[0]); }
  const D=means.length;
  if(D<3)return {t:0,days:D};
  let m=0; for(const x of means)m+=x; m/=D;
  let v=0; for(const x of means)v+=(x-m)*(x-m); v/=(D-1);   // sample variance
  if(!(v>0))return {t:0,days:D};
  return {t:m/Math.sqrt(v/D),days:D};
}
function _auditFinalize(X){
  const HOLD=X.hold||_AUD.HOLD, DAYS=X.days||_AUD.DAYS, LIQ_FLOOR=(X.liq>=_AUD.LIQ_FLOOR?X.liq:_AUD.LIQ_FLOOR);
  const defs=X.defs, M=X.M, day=X.day, recs=X.recs, base=X.base, annAgg=X.annAgg;
  const met=k=>M[k]||(M[k]={n:0,up:0,upEx:0,sumOut:0,outs:[],excSum:0,excSq:0,dk:{},ha:{n:0,sum:0},hb:{n:0,sum:0},ron:{n:0,sum:0},roff:{n:0,sum:0}});
  for(const dk in day){ const D=day[dk]; D.mean=D.n?D.sum/D.n:0; D.riskOn=(D.bn?(D.bu/D.bn):0)>0.5; }
  for(const rec of recs){
    const D=day[rec.d]||{mean:0,riskOn:false};
    const exc=rec.out-D.mean;
    for(const k of rec.ks){
      const m=met(k);
      m.n++; if(rec.out>0)m.up++; m.sumOut+=rec.out; m.outs.push(rec.out);
      // w414 (audit A6): "% higher" counts RAW up-moves, but the edge is
      // measured against the day's market. This counts the fires that
      // actually BEAT that market — the win rate the edge belongs to.
      if(exc>0)m.upEx++;
      { const a=m.dk[rec.d]||(m.dk[rec.d]=[0,0]); a[0]++; a[1]+=exc; }  // w416: per-DAY
      m.excSum+=exc; m.excSq+=exc*exc;
      const h=(rec.half==='a')?m.ha:m.hb; h.n++; h.sum+=exc;
      const g=D.riskOn?m.ron:m.roff; g.n++; g.sum+=exc;
      if(defs[k]){ const na=annAgg[k], annSt=rec.ann; if(annSt&&annSt.covered){ const gg=annSt.hit?na.news:na.quiet; gg.n++; if(rec.out>0)gg.up++; gg.sum+=rec.out; } else na.unk++; }
    }
  }
  const DIRNEG={di:1,'vr-':1,'blk-':1};
  for(const k in M){ const m=M[k];
    m.avg=m.sumOut/m.n; m.edge=m.excSum/m.n;
    const varE=Math.max(0,(m.excSq/m.n)-(m.edge*m.edge));
    // w416: the per-fire t is kept for transparency, but the DAY-CLUSTERED one
    // is what decides the tier — fires on the same day are not independent.
    m.tFire=(m.n>1&&varE>0)?(m.edge/Math.sqrt(varE/m.n)):0;
    { const c=_clusterT(m.dk); m.tstat=c.t; m.tDays=c.days; }
    m.dk=null;
    const so=m.outs.slice().sort((a,b)=>a-b);
    m.median=so.length?(so.length%2?so[(so.length-1)/2]:(so[so.length/2-1]+so[so.length/2])/2):0;
    let ws=0,wn=0,ls=0,ln2=0;
    for(const o of m.outs){ if(o>0){ws+=o;wn++;} else if(o<0){ls+=o;ln2++;} }
    m.avgWin=wn?ws/wn:0; m.avgLoss=ln2?ls/ln2:0;
    m.outs=null;
    const haAvg=m.ha.n?m.ha.sum/m.ha.n:null, hbAvg=m.hb.n?m.hb.sum/m.hb.n:null;
    m.haAvg=haAvg; m.hbAvg=hbAvg;
    m.held=(m.ha.n>=5&&m.hb.n>=5)?(DIRNEG[k]?(haAvg<0&&hbAvg<0):(haAvg>0&&hbAvg>0)):null;
    const at=DIRNEG[k]?-m.tstat:m.tstat;
    m.tier=(m.n>=50&&at>=2)?'solid':((m.n>=30&&at>=1)?'promising':'early');
    m.dirNeg=!!DIRNEG[k];
  }
  return {defs,M,base,covered:X.covered,liqSkipped:X.liqSkipped,flatSkipped:X.flatSkipped||0,staleSkipped:X.staleSkipped||0,liqFloor:LIQ_FLOOR,hold:HOLD,days:DAYS,from:X.from,to:X.to,ann:annAgg,annStart:(X.annPS?X.annPS.start:null),annCovered:(X.annPS?X.annPS.covered:0)};
}
// w432 — era-aware score cap (Tony's order, this session). Called AFTER
// A.eras is attached (eras only exist post-hoc, from a separate store read
// — see _gradeWarm/the /grades route). Demotes SOLID -> PROMISING when a
// line fails SOLID's own real bar (t>=2) in BOTH older eras. Never touches
// PROMISING/TOO-EARLY lines, never hides the raw numbers, never runs when
// no era data exists for this window (10d today) — it just does nothing,
// same fail-open honesty as every other optional feature in this worker.
function _applyEraCap(A){
  if(!A||!A.M||!A.eras)return A;
  const e2=A.eras.eras&&A.eras.eras[2], e3=A.eras.eras&&A.eras.eras[3];
  if(!e2||!e3)return A; // no era study for this window yet (e.g. 10d) — honest no-op
  const SOLID_T=2; // the REAL live bar (_auditFinalize's own at>=2), not the 2.5 the docs claim
  for(const k in A.M){
    const m=A.M[k];
    if(m.tier!=='solid')continue; // only ever demotes, never touches non-solid lines
    const k2=e2.perKey&&e2.perKey[k], k3=e3.perKey&&e3.perKey[k];
    if(!k2||!k3)continue; // this specific line never fired enough in one of the eras to have a reading — no verdict, no cap
    const at2=m.dirNeg?-k2.t:k2.t;   // w530: was A.dirNegSafe(k) — that helper was never defined, so this silently used the RAW t. For a warning (di/vr-/blk-) a working era has a strongly NEGATIVE t, which failed the >=2 bar and wrongly demoted a robust warning SOLID→PROMISING (and stamped a backwards eraCap reason). m.dirNeg is set on every M[k] by _auditFinalize before this runs.
    const at3=m.dirNeg?-k3.t:k3.t;
    const fail2=!(at2>=SOLID_T), fail3=!(at3>=SOLID_T);
    if(fail2&&fail3){
      m.tier='promising';
      m.eraCapped=true; // client can show WHY, honestly, rather than a silent demotion
      m.eraCap={era2:{t:k2.t,n:k2.n},era3:{t:k3.t,n:k3.n},bar:SOLID_T};
    }
  }
  return A;
}
function _cardScore10(m){
  if(!m||!m.n)return 0;
  const e=(m.dirNeg?-m.edge:m.edge);
  if(!(e>0))return Math.max(0,+(0.5+e*0.5).toFixed(1));
  const band=(m.tier==='solid')?[7,10]:(m.tier==='promising')?[4,7]:[0.5,4];
  const frac=Math.min(1,e/3);
  return +(band[0]+(band[1]-band[0])*frac).toFixed(1);
}
function gradeShares(shares, hold, annPS, liqFloor){ return _auditFinalize(_auditRunAll(_auditNewCtx(shares, hold, annPS, liqFloor))); }
// w433 — "best evidence" walk-through: every day in the replay window, which
// shares had the STRONGEST proven signal firing that day (SOLID beats
// PROMISING, then by measured edge)? Bearish/warning signals (di, vr-, blk-)
// are excluded — those predict a FALL, so they are not "evidence" in the
// sense of something to be excited about. Unproven ('early' tier) signals
// are excluded too, matching the auto-pilot fix from earlier tonight — same
// principle, same project. Same in-sample methodology as every other
// backtest here: M[key].tier/edge are the FULL-WINDOW aggregate for that
// signal type, not a walk-forward reconstruction — consistent with how the
// era study, accum-score and streak backtests already work, not a new
// standard invented for this one feature.
// w435 — a REAL, sourced ASX ETF/ETP exclusion list (ASX ETFs June 2020 official
// snapshot, ~180 tickers across Vanguard/iShares/BetaShares/SPDR/VanEck/ETFS
// families, plus HVLU and HNDQ individually confirmed since they launched after
// that snapshot). Honest limit: the ASX now lists 370+ funds; this list is not
// exhaustive of every fund launched since 2020, but covers the large, liquid,
// established families most likely to actually clear this backtest'''s $250k
// turnover floor in the first place. Tony'''s own question: does the evidence
// backtest'''s edge hold up on individual companies, or was it leaning on funds?
const _ETF_EXCLUDE = new Set(['A200','AAA','ACDC','AGVT','AGX1','ASIA','AUDS','AUMF','AUST','BBOZ','BBUS','BEAR','BILL','BNDS','BNKS','BOND','CETF','CNEW','CORE','CRED','CURE','DIV','DJRE','DMKT','DRUG','EEU','EIGA','EINC','EMKT','EMMG','ESGI','ESTX','ETF','ETHI','ETPMAG','ETPMPD','ETPMPM','ETPMPT','EX20','F100','FAIR','FEMX','FLOT','FOOD','FUEL','GDX','GEAR','GGUS','GLIN','GOLD','GOVT','GRNV','GROW','HACK','HBRD','HEUR','HJPN','HNDQ','HVLU','HVST','IAA','IAF','IEM','IEU','IFRA','IGB','IHCB','IHD','IHEB','IHHY','IHOO','IHVV','IHWL','IIND','IJH','IJP','IJR','IKO','ILB','ILC','IMPQ','INCM','INES','INIF','IOO','IOZ','ISEC','ISO','IVE','IVV','IWLD','IXI','IXJ','IZZ','KSM','MGE','MHG','MICH','MNRS','MOAT','MOGL','MONY','MVA','MVB','MVE','MVOL','MVR','MVS','MVW','NDIA','NDQ','OOO','OZF','OZR','PAXX','PIXX','PLUS','PMGOLD','POU','QAG','QAU','QCB','QFN','QHAL','QLTY','QMIX','QOZ','QPON','QRE','QUAL','QUS','RARI','RBTZ','RCB','RDV','REIT','RENT','RGB','RINC','ROBO','RSM','SFY','SLF','SMLL','SPY','SSO','STW','SWTZ','SYI','TECH','UBA','UBE','UBJ','UBP','UBU','UBW','UMAX','USD','VACF','VAE','VAF','VAP','VAS','VBLD','VBND','VCF','VDBA','VDCO','VDGR','VDHG','VEFI','VEQ','VESG','VEU','VGAD','VGB','VGE','VGMF','VGS','VHY','VIF','VISM','VLC','VMIN','VSO','VTS','VVLU','WCMQ','WDIV','WDMF','WEMG','WRLD','WVOL','WXHG','WXOZ','XARO','YANK','YMAX','ZUSD','ZYAU','ZYUS']);
// w436 — hybrid/preference-share and government-bond exclusion, RULE-based
// rather than a static list, per ASX's own official naming convention: a
// 3-character issuer code followed by a type letter (P=preference share,
// H=unsecured note, G=convertible note) then a series letter — e.g. CBAPK,
// NABPI, WBCPL, AN3PI. Confirmed against ASX's own "ASX codes and descriptors"
// page. Government bonds/treasury-index-bonds use a separate GSB/GSI prefix
// (e.g. GSBG27, GSIQ30), confirmed against ASX's own eAGB coupon-date list.
// Honest note: unlike the ETF list, this is a STRUCTURAL rule, not a lookup —
// it will automatically catch new hybrid issuances the static ETF list can't,
// but any structural rule carries a small, non-zero edge-case risk a curated
// list doesn't. Both are debt-like, interest-rate-sensitive instruments whose
// volume/price footprints mean something different from an ordinary company's.
const _HYBRID_BOND_RE = /^([A-Z0-9]{3}[PHG][A-Z]|GS[BI][A-Z]\d{2})$/;
// w529 — census-backed derivative detection (mirrors the app's v766 classifier,
// ticker-shape only since the server has no company names). A census of all 4,455
// pantry tickers proved: every 6-char ASX code is a warrant series (KO/JO/SO/WO/IO/
// MO/QO — 1,611 of them), a GSB/GSI government bond, or an ETPM metal ETC. No
// 6-char ordinary exists. ETPM stays allowed here (it is an ETF, and the price
// band excludes it from lanes anyway).
function _tickerDerivType(t){
  try{
    t=String(t||'').toUpperCase();
    if(/^ETPM/.test(t)) return null;
    if(/^(GSB|GSI)/.test(t)) return 'Bond';
    if(t.length>=4 && t.length<=6){
      const tail=t.slice(3);
      if(/^KO[A-Z]?$/.test(tail)) return 'Option';
      if(/O[A-G]?$/.test(tail)) return 'Option';
      if(/^R[A-C]?$/.test(tail)) return 'Option';
      if(/^P[A-Z]$/.test(tail)) return 'Preference';
      if(/^G[A-Z]?$/.test(tail)) return 'Bond';
      if(t.length===6) return 'Option';
    }
    return null;
  }catch(e){ return null; }
}
const _NONEQUITY_EXCLUDE = { has: function(t){ return _ETF_EXCLUDE.has(t) || _HYBRID_BOND_RE.test(t) || _tickerDerivType(t)!==null; } };
function _evidenceTopN(shares, hold, liqFloor, topN, excludeSet){
  const N=topN||7;
  const useShares=excludeSet?shares.filter(s=>!excludeSet.has(s.ticker)):shares; // w435: ETF/ETP exclusion, applied BEFORE the replay so excluded tickers never enter the universe at all, not just hidden from the output
  const X=_auditNewCtx(useShares, hold, null, liqFloor);
  _auditRunAll(X);
  const recs=X.recs; // must read BEFORE _auditFinalize — its return object does not carry recs forward
  const A=_auditFinalize(X);
  const M=A.M;
  const EXCLUDE={di:1,'vr-':1,'blk-':1,vr:1,blk:1}; // w433: di/vr-/blk- are bearish; vr/blk are the POOLED, undirected keys — this project's own report card treats those as never-trust-directly (the pooled number can look fine while masking a bad half), so only the vr+/blk+ splits (and every other inherently-directional single/combo) count as "evidence"
  const tierRank={solid:2,promising:1,early:0};
  const byDay={};
  for(const rec of recs){
    let best=null;
    for(const k of rec.ks){
      if(EXCLUDE[k])continue; // bearish, or pooled/undirected — never counts as "evidence" to be excited about
      const m=M[k]; if(!m||m.tier==='early')continue; // unproven never counts
      if(!best||tierRank[m.tier]>tierRank[best.tier]||(tierRank[m.tier]===tierRank[best.tier]&&m.edge>best.edge))
        best={key:k,tier:m.tier,edge:m.edge};
    }
    if(!best)continue;
    (byDay[rec.d]||(byDay[rec.d]=[])).push({ticker:rec.ticker,key:best.key,tier:best.tier,edge:best.edge,out:rec.out});
  }
  const fullList=[], dayMeans={};
  for(const d of Object.keys(byDay).sort()){
    const top=byDay[d].sort((a,b)=>(tierRank[b.tier]-tierRank[a.tier])||(b.edge-a.edge)).slice(0,N);
    let sum=0;
    for(const it of top){ fullList.push({date:d,ticker:it.ticker,key:it.key,tier:it.tier,edge:it.edge,out:it.out}); sum+=it.out; }
    if(top.length)dayMeans[d]=sum/top.length;
  }
  const dvals=Object.values(dayMeans), D=dvals.length;
  let mean=0; for(const v of dvals)mean+=v; mean=D?mean/D:0;
  let varr=0; if(D>1){ for(const v of dvals)varr+=(v-mean)*(v-mean); varr/=(D-1); }
  const tstat=(D>2&&varr>0)?(mean/Math.sqrt(varr/D)):0; // day-clustered, same discipline as _clusterT elsewhere — a 7-pick day is one observation, not seven
  const wins=fullList.filter(it=>it.out>0).length;
  const marketAvg=A.base.n?(A.base.sum/A.base.n):0;
  const byTickerMap={};
  for(const it of fullList){
    const t=byTickerMap[it.ticker]||(byTickerMap[it.ticker]={ticker:it.ticker,n:0,sum:0,wins:0});
    t.n++; t.sum+=it.out; if(it.out>0)t.wins++;
  }
  const byTicker=Object.values(byTickerMap).map(t=>({ticker:t.ticker,n:t.n,avgOut:+(t.sum/t.n).toFixed(2),winRate:+((t.wins/t.n)*100).toFixed(0)})).sort((a,b)=>b.n-a.n||b.avgOut-a.avgOut);
  return {
    hold, topN:N, daysWithPicks:D, totalPicks:fullList.length,
    aggregate:{ n:fullList.length, days:D, meanOut:+mean.toFixed(3), marketAvg:+marketAvg.toFixed(3), edge:+(mean-marketAvg).toFixed(3), tstat:+tstat.toFixed(2), hitRate:fullList.length?+((wins/fullList.length)*100).toFixed(1):0 },
    byTicker, fullList
  };
}

// w437 — Tony's dip-ladder backtest. Replay the last 6 weeks; use ONLY the
// first 2 weeks as an entry window, running the same best-evidence,
// top-N-per-day selection as _evidenceTopN (bearish/pooled/unproven signals
// excluded, same as every other evidence feature tonight) but restricted to
// those specific days. Each FIRST-seen candidate (later re-picks of the same
// ticker within the window are ignored) gets four independent, parallel
// entries — three limit dips plus one at market — each tracked through the
// full 6-week window with a trailing stop, an uncapped 5%-step profit
// ladder, and a one-time 50% scale-out at +20% (the app's own v384 default;
// the remaining half keeps riding the ladder rather than sitting flat).
// Ladder margin defaults to 0 since only a step size was specified — an
// honest assumption, not a silent guess (see the admin panel note).
//
// Grading runs on hold=5, matching Best Evidence Today's own convention, and
// runs on the WHOLE fetched history — the pick window just restricts which
// days' picks get extracted, not how those signals were graded. Same
// in-sample discipline as every other backtest here.
function _ladderLockPct(gainPct, step, margin){
  if(!(step>0)||!isFinite(gainPct))return 0;
  const r=Math.floor((gainPct-(margin>0?margin:0))/step)*step;
  return r>=step?r:0;
}
function _simulateLevel(series, pickIdx, entryEndIdx, windowEndIdx, levelPct, amountDollars, trailPct, ladderStep, ladderMargin, scaleTrigger, scalePct){
  const pickClose=series[pickIdx].c;
  const limitPrice=levelPct===0?null:+(pickClose*(1+levelPct/100)).toFixed(4);
  let fillIdx=null, fillPrice=null;
  if(levelPct===0){
    const nxt=series[pickIdx+1];
    if(pickIdx+1<=entryEndIdx&&nxt&&nxt.o>0){ fillIdx=pickIdx+1; fillPrice=nxt.o; }
  } else {
    for(let i=pickIdx+1;i<=entryEndIdx;i++){
      const day=series[i]; if(!day)break;
      if(day.o>0&&day.o<=limitPrice){ fillIdx=i; fillPrice=day.o; break; }
      if(day.lo>0&&day.lo<=limitPrice){ fillIdx=i; fillPrice=limitPrice; break; }
    }
  }
  if(fillIdx===null)return {level:levelPct, limitPrice, filled:false};
  const qty0=amountDollars/fillPrice;
  let peak=fillPrice, lock=0, beFloor=0, scaledOut=false, remainingQty=qty0, realizedCash=0;
  let scaleOutDay=null, scaleOutPrice=null, exitIdx=null, exitPrice=null, exitWhy=null;
  for(let i=fillIdx+1;i<=windowEndIdx;i++){
    const day=series[i]; if(!day)break;
    const trailStop=trailPct>0?peak*(1-trailPct/100):0;
    const ladderStop=lock>0?fillPrice*(1+lock/100):0;
    if(!scaledOut&&scaleTrigger>0){
      const stopNowBefore=Math.max(trailStop,ladderStop,beFloor);
      const targetPrice=fillPrice*(1+scaleTrigger/100);
      if(day.o>0&&day.o>=targetPrice){
        const sellQty=remainingQty*(scalePct/100); realizedCash+=sellQty*day.o; remainingQty-=sellQty;
        scaledOut=true; scaleOutDay=day.d; scaleOutPrice=day.o; beFloor=Math.max(stopNowBefore,fillPrice);
      } else if(day.hi>0&&day.hi>=targetPrice){
        const sellQty=remainingQty*(scalePct/100); realizedCash+=sellQty*targetPrice; remainingQty-=sellQty;
        scaledOut=true; scaleOutDay=day.d; scaleOutPrice=targetPrice; beFloor=Math.max(stopNowBefore,fillPrice);
      }
    }
    const stopCheck=Math.max(trailStop,ladderStop,beFloor);
    if(stopCheck>0){
      if(day.o>0&&day.o<=stopCheck){ exitIdx=i; exitPrice=day.o; exitWhy='stop'; break; }
      if(day.lo>0&&day.lo<=stopCheck){ exitIdx=i; exitPrice=stopCheck; exitWhy='stop'; break; }
    }
    if(day.c>0){
      if(day.c>peak)peak=day.c;
      const gain=100*(day.c/fillPrice-1);
      const nl=_ladderLockPct(gain,ladderStep,ladderMargin);
      if(nl>lock)lock=nl;
    }
  }
  if(exitIdx===null){ exitIdx=windowEndIdx; exitPrice=series[windowEndIdx].c; exitWhy='window-end'; }
  const finalSaleCash=remainingQty*exitPrice;
  const totalProceeds=realizedCash+finalSaleCash;
  const pl=totalProceeds-amountDollars;
  const plPct=(totalProceeds/amountDollars-1)*100;
  return {level:levelPct, limitPrice, filled:true, fillDate:series[fillIdx].d, fillPrice,
    scaledOut, scaleOutDay, scaleOutPrice, exitDate:series[exitIdx].d, exitPrice, exitWhy,
    invested:amountDollars, totalProceeds:+totalProceeds.toFixed(2), pl:+pl.toFixed(2), plPct:+plPct.toFixed(2)};
}
function _dipLadderBacktest(shares, params){
  const {entryWeeks=2, totalWeeks=6, topN=7, amountPerLevel=5000,
    trailPct=10, ladderStep=5, ladderMargin=0, scaleTrigger=20, scalePct=50,
    levels=[-10,-5,-2.5,0], liqFloor=250000} = params||{};
  const X=_auditNewCtx(shares, 5, null, liqFloor);
  _auditRunAll(X);
  const recs=X.recs;
  const A=_auditFinalize(X);
  const M=A.M;
  const EXCLUDE={di:1,'vr-':1,'blk-':1,vr:1,blk:1};
  const tierRank={solid:2,promising:1,early:0};
  const byDay={};
  for(const rec of recs){
    let best=null;
    for(const k of rec.ks){
      if(EXCLUDE[k])continue;
      const m=M[k]; if(!m||m.tier==='early')continue;
      if(!best||tierRank[m.tier]>tierRank[best.tier]||(tierRank[m.tier]===tierRank[best.tier]&&m.edge>best.edge))
        best={key:k,tier:m.tier,edge:m.edge};
    }
    if(!best)continue;
    (byDay[rec.d]||(byDay[rec.d]=[])).push({ticker:rec.ticker,key:best.key,tier:best.tier,edge:best.edge});
  }
  const allDates=new Set();
  for(const s of shares)for(const r of s.series)allDates.add(r.d);
  const calendar=[...allDates].sort();
  const nCal=calendar.length;
  if(nCal<totalWeeks*5+5)return {error:'not enough trading history for a '+totalWeeks+'-week window'};
  const windowEndDate=calendar[nCal-1];
  const entryDaysCount=entryWeeks*5, totalDaysCount=totalWeeks*5;
  const windowStartCalIdx=Math.max(0,nCal-totalDaysCount);
  const entryEndCalIdx=Math.min(nCal-1,windowStartCalIdx+entryDaysCount-1);
  const windowStartDate=calendar[windowStartCalIdx];
  const entryEndDate=calendar[entryEndCalIdx];
  const pickDays=calendar.slice(windowStartCalIdx, entryEndCalIdx+1);
  const seen=new Set();
  const candidates=[];
  for(const d of pickDays){
    const picks=(byDay[d]||[]).slice().sort((a,b)=>(tierRank[b.tier]-tierRank[a.tier])||(b.edge-a.edge)).slice(0,topN);
    for(const p of picks){
      if(seen.has(p.ticker))continue;
      seen.add(p.ticker);
      candidates.push({ticker:p.ticker, pickDate:d, key:p.key, tier:p.tier, edge:p.edge});
    }
  }
  const shareByTicker={}; for(const s of shares)shareByTicker[s.ticker]=s;
  const results=[];
  for(const cand of candidates){
    const sh=shareByTicker[cand.ticker]; if(!sh)continue;
    const series=sh.series;
    const dateIdx={}; for(let i=0;i<series.length;i++)dateIdx[series[i].d]=i;
    const pickIdx=dateIdx[cand.pickDate]; if(pickIdx==null)continue;
    const idxForDate=(targetDate)=>{
      if(dateIdx[targetDate]!=null)return dateIdx[targetDate];
      let lo=0,hi=series.length-1,ans=null;
      while(lo<=hi){ const mid=(lo+hi)>>1; if(series[mid].d<=targetDate){ans=mid;lo=mid+1;} else hi=mid-1; }
      return ans;
    };
    const entryEndIdx=idxForDate(entryEndDate);
    const windowEndIdx=idxForDate(windowEndDate);
    if(entryEndIdx==null||windowEndIdx==null||windowEndIdx<=pickIdx)continue;
    const levelResults=levels.map(lv=>_simulateLevel(series,pickIdx,entryEndIdx,windowEndIdx,lv,amountPerLevel,trailPct,ladderStep,ladderMargin,scaleTrigger,scalePct));
    results.push({ticker:cand.ticker,pickDate:cand.pickDate,evidenceKey:cand.key,tier:cand.tier,edge:cand.edge,levels:levelResults});
  }
  const perLevel={};
  for(const lv of levels)perLevel[lv]={filled:0,notFilled:0,invested:0,proceeds:0,wins:0};
  for(const r of results){
    for(const lr of r.levels){
      const agg=perLevel[lr.level];
      if(!lr.filled){agg.notFilled++;continue;}
      agg.filled++; agg.invested+=lr.invested; agg.proceeds+=lr.totalProceeds; if(lr.pl>0)agg.wins++;
    }
  }
  const perLevelSummary=levels.map(lv=>{
    const a=perLevel[lv];
    const pl=a.proceeds-a.invested;
    return {level:lv, candidates:results.length, filled:a.filled, notFilled:a.notFilled,
      invested:+a.invested.toFixed(2), proceeds:+a.proceeds.toFixed(2), pl:+pl.toFixed(2),
      plPct:a.invested>0?+((pl/a.invested)*100).toFixed(2):0,
      winRate:a.filled>0?+((a.wins/a.filled)*100).toFixed(1):0};
  });
  return { windowStartDate, entryEndDate, windowEndDate, candidateCount:results.length,
    params:{entryWeeks,totalWeeks,topN,amountPerLevel,trailPct,ladderStep,ladderMargin,scaleTrigger,scalePct,levels},
    perLevelSummary, candidates:results };
}

// w439 — Tony's follow-up: same test, but broader (12 months) and buying
// EVERY WEEK, not just once. Reuses _simulateLevel entirely unchanged; the
// only new logic is the orchestration. Instead of one 2-week pick-window
// followed by a fixed hold period, the whole backtest window is chopped
// into sequential ~1-week (5 trading day) blocks. Each block runs its own
// top-N evidence selection, deduped WITHIN that block only — the same
// ticker CAN be bought again in a later week if it fires again, since
// "buying every week" describes an ongoing, recurring process rather than
// a single entry event (stated here, not hidden). Every filled position
// rides its trailing stop/ladder/scale-out all the way to either being
// stopped out or the FULL window ending — there is no separate "hold
// period" concept here; whichever week a position enters in, the rest of
// the entire remaining window is its hold period.
function _dipLadderBacktestRecurring(shares, params){
  const {entryDays=5, totalWeeks=52, topN=7, amountPerLevel=5000,
    trailPct=10, ladderStep=5, ladderMargin=0, scaleTrigger=20, scalePct=50,
    levels=[-10,-5,-2.5,0], liqFloor=250000} = params||{};
  const X=_auditNewCtx(shares, 5, null, liqFloor);
  _auditRunAll(X);
  const recs=X.recs;
  const A=_auditFinalize(X);
  const M=A.M;
  const EXCLUDE={di:1,'vr-':1,'blk-':1,vr:1,blk:1};
  const tierRank={solid:2,promising:1,early:0};
  const byDay={};
  for(const rec of recs){
    let best=null;
    for(const k of rec.ks){
      if(EXCLUDE[k])continue;
      const m=M[k]; if(!m||m.tier==='early')continue;
      if(!best||tierRank[m.tier]>tierRank[best.tier]||(tierRank[m.tier]===tierRank[best.tier]&&m.edge>best.edge))
        best={key:k,tier:m.tier,edge:m.edge};
    }
    if(!best)continue;
    (byDay[rec.d]||(byDay[rec.d]=[])).push({ticker:rec.ticker,key:best.key,tier:best.tier,edge:best.edge});
  }
  const allDates=new Set();
  for(const s of shares)for(const r of s.series)allDates.add(r.d);
  const calendar=[...allDates].sort();
  const nCal=calendar.length;
  const totalDaysCount=totalWeeks*5;
  if(nCal<totalDaysCount+5)return {error:'not enough trading history for a '+totalWeeks+'-week window'};
  const windowStartCalIdx=Math.max(0,nCal-totalDaysCount);
  const windowEndCalIdx=nCal-1;
  const windowStartDate=calendar[windowStartCalIdx];
  const windowEndDate=calendar[windowEndCalIdx];

  const blocks=[];
  for(let i=windowStartCalIdx;i<=windowEndCalIdx;i+=entryDays){
    const blockEnd=Math.min(i+entryDays-1,windowEndCalIdx);
    blocks.push({startIdx:i,endIdx:blockEnd,startDate:calendar[i],endDate:calendar[blockEnd]});
  }

  const shareByTicker={}; for(const s of shares)shareByTicker[s.ticker]=s;
  const results=[];
  for(const block of blocks){
    const blockDays=calendar.slice(block.startIdx,block.endIdx+1);
    const seenThisBlock=new Set();
    for(const d of blockDays){
      const picks=(byDay[d]||[]).slice().sort((a,b)=>(tierRank[b.tier]-tierRank[a.tier])||(b.edge-a.edge)).slice(0,topN);
      for(const p of picks){
        if(seenThisBlock.has(p.ticker))continue;
        seenThisBlock.add(p.ticker);
        const sh=shareByTicker[p.ticker]; if(!sh)continue;
        const series=sh.series;
        const dateIdx={}; for(let i=0;i<series.length;i++)dateIdx[series[i].d]=i;
        const pickIdx=dateIdx[d]; if(pickIdx==null)continue;
        const idxForDate=(targetDate)=>{
          if(dateIdx[targetDate]!=null)return dateIdx[targetDate];
          let lo=0,hi=series.length-1,ans=null;
          while(lo<=hi){ const mid=(lo+hi)>>1; if(series[mid].d<=targetDate){ans=mid;lo=mid+1;} else hi=mid-1; }
          return ans;
        };
        const entryEndIdx=idxForDate(block.endDate);
        const windowEndIdx=idxForDate(windowEndDate);
        if(entryEndIdx==null||windowEndIdx==null||windowEndIdx<=pickIdx)continue;
        const levelResults=levels.map(lv=>_simulateLevel(series,pickIdx,entryEndIdx,windowEndIdx,lv,amountPerLevel,trailPct,ladderStep,ladderMargin,scaleTrigger,scalePct));
        results.push({ticker:p.ticker,pickDate:d,weekStart:block.startDate,evidenceKey:p.key,tier:p.tier,edge:p.edge,levels:levelResults});
      }
    }
  }

  const perLevel={};
  for(const lv of levels)perLevel[lv]={filled:0,notFilled:0,invested:0,proceeds:0,wins:0};
  for(const r of results){
    for(const lr of r.levels){
      const agg=perLevel[lr.level];
      if(!lr.filled){agg.notFilled++;continue;}
      agg.filled++; agg.invested+=lr.invested; agg.proceeds+=lr.totalProceeds; if(lr.pl>0)agg.wins++;
    }
  }
  const perLevelSummary=levels.map(lv=>{
    const a=perLevel[lv];
    const pl=a.proceeds-a.invested;
    return {level:lv, candidates:results.length, filled:a.filled, notFilled:a.notFilled,
      invested:+a.invested.toFixed(2), proceeds:+a.proceeds.toFixed(2), pl:+pl.toFixed(2),
      plPct:a.invested>0?+((pl/a.invested)*100).toFixed(2):0,
      winRate:a.filled>0?+((a.wins/a.filled)*100).toFixed(1):0};
  });

  const byTickerMap={};
  for(const r of results){
    const t=byTickerMap[r.ticker]||(byTickerMap[r.ticker]={ticker:r.ticker,timesPicked:0,invested:0,proceeds:0});
    t.timesPicked++;
    for(const lr of r.levels){ if(lr.filled){ t.invested+=lr.invested; t.proceeds+=lr.totalProceeds; } }
  }
  const byTicker=Object.values(byTickerMap).map(t=>({ticker:t.ticker,timesPicked:t.timesPicked,invested:+t.invested.toFixed(2),proceeds:+t.proceeds.toFixed(2),pl:+(t.proceeds-t.invested).toFixed(2)})).sort((a,b)=>b.timesPicked-a.timesPicked||b.pl-a.pl);

  return { windowStartDate, windowEndDate, blockCount:blocks.length, candidateCount:results.length,
    params:{entryDays,totalWeeks,topN,amountPerLevel,trailPct,ladderStep,ladderMargin,scaleTrigger,scalePct,levels},
    perLevelSummary, byTicker, candidates:results };
}

// w440 — Tony's follow-up: same weekly-recurring evidence-picking structure
// as _dipLadderBacktestRecurring, but a simpler exit mechanism (a fixed
// target% and fixed stop%, no trailing stop, no ladder, no scale-out) AND
// global dedupe across the WHOLE window — once a ticker is bought in any
// week, it is never bought again in a later week, unlike the previous
// recurring backtest which only deduped within a single week. "Don't buy
// the same share twice."
// ── w470: THE CORPORATE-ACTION GUARD ────────────────────────────────────────
// AEL was booked at +1038.78% on a trade that exited 2025-11-20 — the day
// Amplitude Energy's 11-for-1 consolidation began normal trading. Eleven times
// fewer shares at eleven times the price is not a gain; the real move was about
// +3.5%. That single fabricated trade was the entire margin of victory in both
// market-entry runs of the w469 comparison, and because the sim compounds, it
// also inflated every position size taken after it.
//
// The bars in the pantry are RAW — never adjusted for splits or consolidations
// — so the simulator read the arithmetic of a corporate action as a price move.
// Re-parsing the trade list to check the aggregates, which is what every audit
// in this project has done, cannot catch this: AEL reconciles to the penny and
// is still fiction. Arithmetic verification and data validity are different
// problems and only the first was ever being checked.
//
// Two conditions, BOTH required:
//   1. an overnight close-to-close move beyond roughly ±80%
//   2. that ratio (or its reciprocal) within 4% of a clean whole-number ratio
// Condition 1 alone would throw away real ASX small-cap news days — a genuine
// +90% session happens. Condition 2 is the discriminator: a consolidation lands
// on a clean ratio because it IS a ratio, while a real move lands wherever the
// buyers happen to stop.
// w472 — plain calendar-date arithmetic on 'YYYY-MM-DD' strings, so a guard
// window means the same thing on a share that trades every day and one that
// has been suspended for a year.
function _dMinusDays(d, days){
  const p = String(d || '').split('-');
  if (p.length !== 3) return d;
  const t = Date.UTC(+p[0], +p[1] - 1, +p[2]) - days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
const _CORP_RATIOS = [2, 2.5, 3, 4, 5, 6, 7, 8, 10, 11, 12, 15, 20, 25, 30, 40, 50, 100];
function _corpActionEvents(series){
  const out = [];
  if (!series || series.length < 2) return out;
  for (let i = 1; i < series.length; i++) {
    const prev = +series[i-1].c, cur = +series[i].c;
    if (!(prev > 0) || !(cur > 0)) continue;
    const r = cur / prev;
    if (r < 1.8 && r > 0.5555) continue;
    // w475 — the penny-tick guard. At the ASX price floor one tick IS a clean
    // ratio: $0.001 <-> $0.002 is exactly 2.0, and the deep audit showed this
    // one artefact manufacturing most of the 421 "corporate actions" and nearly
    // all 64 "bad ticks" (88E alone wore ~30 of them). Below half a cent the
    // 2x and 2.5x rungs carry no information, so the small rungs are ignored
    // there. Deliberately NOT a blanket exemption: a genuine large consolidation
    // on a sub-cent share (88E's real 22-for-1, ADD's 25-for-1, ATH at ~55x)
    // still clears 3x and is still caught — the audit's own findings are the
    // regression test for that.
    const test = r >= 1 ? r : 1 / r;
    if (Math.max(prev, cur) <= 0.005 && test < 3) continue;
    let factor = null;
    for (const f of _CORP_RATIOS) { if (Math.abs(test - f) / f <= 0.04) { factor = f; break; } }
    // w472 — a second, unconditional net. The clean-ratio test assumes the
    // consolidation ratio survives intact into the close-to-close figure, and
    // it usually does. But the share also trades that day, so an 11-for-1 on a
    // share that then falls 8% lands at 10.1 — between the rungs of the ladder
    // and matched by nothing. Beyond 5x in a single session there is no
    // innocent explanation on this market, clean ratio or not, so magnitude
    // alone is enough. The reported factor is the nearest rung, marked as an
    // estimate rather than a claim.
    let byMagnitude = false;
    if (factor === null && test >= 5) {
      byMagnitude = true;
      let best = _CORP_RATIOS[0];
      for (const f of _CORP_RATIOS) { if (Math.abs(test - f) < Math.abs(test - best)) best = f; }
      factor = best;
    }
    if (factor === null) continue;
    // Volume, WHEN IT IS THERE, is the confirmation: a consolidation divides the
    // share count, so volume moves the opposite way by roughly the same factor.
    // Volume moving the SAME way as price is a news day, not a corporate action.
    // A MISSING volume must never un-flag anything — this store's history has
    // been patchy before (see the v464 OHLC repair), so absence is not evidence.
    let confidence = 'suspected', volRatio = null;
    const pv = +series[i-1].v, cv = +series[i].v;
    if (pv > 0 && cv > 0) {
      volRatio = cv / pv;
      const expect = 1 / r;
      if (volRatio <= expect * 3 && volRatio >= expect / 3) confidence = 'confirmed';
      // w472 — the volume veto is now SCOPED. It was letting a rising volume
      // overturn a clean 11.0 ratio, which is how AEL slipped past the front
      // door and had to be caught by the overshoot backstop instead: on the
      // first day of normal trading after a consolidation, volume routinely
      // jumps. The veto earns its keep at a 2x ratio, where a genuine double
      // on heavy volume is an ordinary news day. At 4x and beyond it is
      // answering a question nobody asked — no ASX equity gains 300% in one
      // session by trading — so above that, the ratio decides on its own.
      else if (factor <= 3 && ((r > 1 && volRatio > 1.5) || (r < 1 && volRatio < 0.667))) confidence = 'news-like';
    }
    if (byMagnitude && confidence === 'news-like') confidence = 'suspected';
    out.push({ d: series[i].d, ratio: +r.toFixed(4), factor: factor, byMagnitude: byMagnitude,
      kind: (r >= 1 ? 'consolidation' : 'split'), confidence: confidence,
      volRatio: (volRatio === null ? null : +volRatio.toFixed(3)) });
  }
  return out;
}

// w470 — the second net. The bar-ratio test above reads CONSECUTIVE stored
// closes, so it misses an event that falls in a gap: a trading halt, a missing
// bar, or a share whose pre-event history was never stored at all (ASX history
// starts 2023-08-10). This one works on the finished trade instead.
//
// The insight that makes it sharp: the target is a LIMIT. A trade can only book
// meaningfully more than its target percentage by gapping through it on the exit
// morning — so the OVERSHOOT is the signal, measured against the target rather
// than against some arbitrary absolute return.
//   > 15 points past target/stop → flagged, still counted
//   > 50 points past            → held out, run reported BOTH ways
// Held out rather than deleted, because a genuine takeover bid lands at +60%
// overnight and is real money a live account would have banked. Auto-deleting
// every large move would bias the result downward — the same category of error
// as counting AEL, just pointing the other way. Only an integer-ratio match
// above justifies outright removal, because only that shows the return was
// arithmetically impossible rather than merely large.
function _exitOvershoot(t, targetPct, stopPct){
  if (t.exitWhy === 'target') return +(t.plPct - targetPct).toFixed(2);
  if (t.exitWhy === 'stop')   return +(-(t.plPct + stopPct)).toFixed(2);
  return 0;
}

// ── w476: THE BENCHMARK ─────────────────────────────────────────────────────
// Every result this project has produced is a return with nothing to stand
// against. "20.9% a year" is a triumph or an embarrassment depending entirely
// on what the same shares handed a person who did nothing, and until now that
// number has never been computed. The scan-edge study of 28 July was the
// warning: an apparent t=+4.7 winner failed once it was measured against the
// right benchmark rather than a convenient one.
//
// Three benchmarks, because no single one is honest on its own:
//
//   equalWeight — buy every share in the band on day one, equal money, hold to
//                 the end. The naive "just buy the lot" comparison.
//   monthlyRebal— the same, rebalanced monthly back to equal weight, which is
//                 what an index-like holding actually does and is usually the
//                 fairer bar (equal-weight buy-and-hold quietly becomes a
//                 momentum bet as winners take over the book).
//   randomEntry — the strategy's OWN shape with the evidence removed: the same
//                 number of trades, the same 20/15 exits, the same position
//                 cap, entered on RANDOM days in random in-band shares. This is
//                 the one that isolates the signal, because it holds trade
//                 count, holding rules and market period constant and varies
//                 only whether the picks were chosen for a reason.
//
// The random arm is seeded and run many times, and reports the distribution —
// a strategy that beats the median random draw but sits inside the middle of
// the spread has not demonstrated anything.
function _benchmarkBands(shares, params){
  const { totalWeeks=140, targetPct=20, stopPct=15, maxPositions=10,
    startingCapital=100000, excludeNonEquity=true, liqFloor=250000,
    randomRuns=200, tradesToMatch=0, seed=20260801,
    bands=[{label:'$0.15 \u2013 $1.75', min:0.15, max:1.75},
           {label:'$0.20 \u2013 $0.99', min:0.20, max:0.99}] } = params||{};
  const useShares = excludeNonEquity ? shares.filter(s=>!_NONEQUITY_EXCLUDE.has(s.ticker)) : shares;

  const allDates=new Set();
  for(const s of useShares)for(const r of s.series)allDates.add(r.d);
  const calendar=[...allDates].sort();
  const nCal=calendar.length;
  const totalDaysCount=totalWeeks*5;
  if(nCal<totalDaysCount+5)return {error:'not enough trading history for a '+totalWeeks+'-week window'};
  const startIdx=Math.max(0,nCal-totalDaysCount), endIdx=nCal-1;
  const startDate=calendar[startIdx], endDate=calendar[endIdx];

  // per-ticker date index, built once
  const byT={}, idx={};
  for(const s of useShares){ byT[s.ticker]=s; const m={}; for(let i=0;i<s.series.length;i++)m[s.series[i].d]=i; idx[s.ticker]=m; }
  const closeOn=(tk,d)=>{ const m=idx[tk]; if(!m)return null; const i=m[d]; if(i==null)return null; const c=+byT[tk].series[i].c; return c>0?c:null; };
  // last close at or before d (so a share that did not trade that day still values)
  const closeAtOrBefore=(tk,d)=>{
    const sh=byT[tk]; if(!sh)return null;
    let lo=0,hi=sh.series.length-1,ans=null;
    while(lo<=hi){ const mid=(lo+hi)>>1; if(sh.series[mid].d<=d){ans=mid;lo=mid+1;} else hi=mid-1; }
    if(ans==null)return null; const c=+sh.series[ans].c; return c>0?c:null;
  };

  // deterministic PRNG — a benchmark nobody can reproduce is not a benchmark
  let _s=seed>>>0;
  const rnd=()=>{ _s^=_s<<13; _s>>>=0; _s^=_s>>17; _s^=_s<<5; _s>>>=0; return _s/4294967296; };

  const out=[];
  for(const band of bands){
    // membership: priced inside the band on the first day of the window
    const members=[];
    for(const s of useShares){
      const c0=closeOn(s.ticker,startDate);
      if(c0==null)continue;
      if(!(c0>band.min&&c0<=band.max))continue;
      const cN=closeAtOrBefore(s.ticker,endDate);
      if(cN==null)continue;
      members.push({ticker:s.ticker,c0:c0,cN:cN,ret:(cN/c0-1)*100});
    }
    const n=members.length;
    const res={ band:band.label, members:n };
    if(!n){ out.push(Object.assign(res,{note:'no shares priced in this band at the window start'})); continue; }

    // 1. equal-weight buy and hold
    const ew=members.reduce((a,m)=>a+m.cN/m.c0,0)/n;
    res.equalWeightPct=+((ew-1)*100).toFixed(2);
    res.medianSharePct=+(members.map(m=>m.ret).sort((a,b)=>a-b)[Math.floor(n/2)]).toFixed(2);
    res.bestSharePct=+Math.max.apply(null,members.map(m=>m.ret)).toFixed(2);
    res.worstSharePct=+Math.min.apply(null,members.map(m=>m.ret)).toFixed(2);
    res.sharesUpPct=+((members.filter(m=>m.ret>0).length/n)*100).toFixed(1);

    // 2. monthly rebalance to equal weight
    { let v=1, prev=startDate;
      // w476 — step to each month end, THEN close the final stub. The first
      // draft stopped at the last whole 21-day step and silently dropped what
      // was left, under-reporting the benchmark by up to a month. Caught
      // because a market of identical doubling shares returned +92.4% here
      // against +95.1% for buy-and-hold on the same shares — with identical
      // paths, rebalancing cannot change anything, so the two must agree.
      const stops=[];
      for(let i=startIdx+21;i<=endIdx;i+=21) stops.push(calendar[i]);
      if(!stops.length||stops[stops.length-1]!==endDate) stops.push(endDate);
      for(const d of stops){
        let step=0,cnt=0;
        for(const m of members){ const a=closeAtOrBefore(m.ticker,prev), b=closeAtOrBefore(m.ticker,d); if(a>0&&b>0){ step+=b/a; cnt++; } }
        if(cnt){ v*=step/cnt; prev=d; }
      }
      res.monthlyRebalPct=+((v-1)*100).toFixed(2);
    }

    // 3. random entries wearing the strategy's own clothes
    const want=tradesToMatch>0?tradesToMatch:Math.max(10,Math.round(n*0.4));
    const runs=[];
    for(let run=0;run<randomRuns;run++){
      let acct=startingCapital;
      const open=[]; let taken=0, wins=0;
      const settle=(d)=>{ for(let i=open.length-1;i>=0;i--) if(open[i].exitDate<=d){ acct+=open[i].pl; open.splice(i,1); } };
      // random entry days spread across the window, in random in-band shares
      const days=[];
      for(let k=0;k<want*3;k++) days.push(startIdx+Math.floor(rnd()*(endIdx-startIdx-5)));
      days.sort((a,b)=>a-b);
      for(const di of days){
        if(taken>=want)break;
        const m=members[Math.floor(rnd()*n)];
        const d=calendar[di];
        settle(d);
        if(open.length>=maxPositions)continue;
        const sh=byT[m.ticker]; const im=idx[m.ticker][d]; if(im==null)continue;
        const sim=_simulateFixedTargetStop(sh.series, im, Math.min(im+1,sh.series.length-1), sh.series.length-1, 0, 1, targetPct, stopPct);
        if(!sim||!sim.filled)continue;
        const size=acct/maxPositions;
        const pl=size*(sim.plPct/100);
        open.push({exitDate:sim.exitDate,pl:pl});
        if(pl>0)wins++;
        taken++;
      }
      for(const o of open)acct+=o.pl;
      runs.push({ret:+(((acct/startingCapital)-1)*100), taken:taken, win:taken?(wins/taken)*100:0});
    }
    runs.sort((a,b)=>a.ret-b.ret);
    const q=(f)=>+runs[Math.min(runs.length-1,Math.floor(runs.length*f))].ret.toFixed(2);
    res.random={ runs:runs.length, tradesPerRun:+(runs.reduce((a,r)=>a+r.taken,0)/runs.length).toFixed(1),
      avgWinRate:+(runs.reduce((a,r)=>a+r.win,0)/runs.length).toFixed(1),
      p5:q(0.05), p25:q(0.25), median:q(0.50), p75:q(0.75), p95:q(0.95),
      mean:+((runs.reduce((a,r)=>a+r.ret,0)/runs.length)).toFixed(2) };
    out.push(res);
  }
  return { windowStartDate:startDate, windowEndDate:endDate, tradingDays:totalDaysCount,
    yearsApprox:+(totalDaysCount/252).toFixed(2),
    params:{totalWeeks,targetPct,stopPct,maxPositions,startingCapital,randomRuns,tradesToMatch,seed},
    universeAfterExclusion:useShares.length, bands:out };
}

// ── w474: THE DEEP DATA AUDIT ───────────────────────────────────────────────
// Tony: "check that there is no other corrupt or consolidations, deep dive
// audit the data before we finalise our decision." The backtest's own filter
// only ever inspects tickers that TRADE — a corrupted share that never fired a
// signal is invisible to it, and so is one whose corruption is subtler than a
// price jump. This walks every stored series above the floor and catalogues:
//   corp    — corporate-action-like jumps (the same detector the backtests
//             use, but reporting EVERY confidence level, vetoed ones included,
//             so the judgement is inspectable rather than silent)
//   ohlc    — impossible bars: low > high, close or open outside [low, high],
//             non-positive prices on a row that claims to have traded
//   gaps    — holes in a series: trading days on which the REST of the market
//             traded but this share has no bar. Long gaps are what turn a
//             two-month move into one "overnight" jump and defeat the
//             consecutive-close detector (how AEL needed the size backstop).
//   flat    — long runs of identical closes with volume: a price that never
//             moves is either a suspended share still being written, or a
//             stale-pointer bug like the one v455 fixed.
//   spikes  — one-day moves beyond ±60% that then REVERT next session: shape
//             of a bad tick, not of news (news re-prices; it does not undo).
// Read-only throughout — one pantry read, no writes, no external calls.
function _deepDataAudit(shares, opts){
  const o = opts || {};
  const gapMin = o.gapMin || 5;          // report gaps of 5+ market days
  const flatMin = o.flatMin || 15;       // report 15+ identical closes
  const maxPer = o.maxPer || 40;         // cap each list; counts stay exact
  // the market calendar: every date on which anything traded
  const cal = new Set();
  for (const sh of shares) for (const r of sh.series) cal.add(r.d);
  const calendar = [...cal].sort();
  const calIdx = {}; calendar.forEach((d, i) => { calIdx[d] = i; });
  const R = { universe: shares.length, calendarDays: calendar.length,
    from: calendar[0] || null, to: calendar[calendar.length - 1] || null,
    corp: [], ohlc: [], gaps: [], flat: [], spikes: [],
    counts: { corp: 0, ohlc: 0, gaps: 0, flat: 0, spikes: 0 } };
  for (const sh of shares) {
    const S = sh.series || [];
    // corporate actions — every event, every confidence
    for (const ev of _corpActionEvents(S)) {
      R.counts.corp++;
      if (R.corp.length < maxPer) R.corp.push({ ticker: sh.ticker, d: ev.d, ratio: ev.ratio,
        factor: ev.factor, kind: ev.kind, confidence: ev.confidence,
        byMagnitude: !!ev.byMagnitude, volRatio: ev.volRatio });
    }
    // impossible bars
    for (const r of S) {
      const bad =
        (r.lo > 0 && r.hi > 0 && r.lo > r.hi) ? 'low above high' :
        (r.c > 0 && r.hi > 0 && r.c > r.hi * 1.001) ? 'close above high' :
        (r.c > 0 && r.lo > 0 && r.c < r.lo * 0.999) ? 'close below low' :
        (r.o > 0 && r.hi > 0 && r.o > r.hi * 1.001) ? 'open above high' :
        (r.o > 0 && r.lo > 0 && r.o < r.lo * 0.999) ? 'open below low' :
        ((r.c <= 0 || r.o < 0 || r.hi < 0 || r.lo < 0) && (r.v > 0)) ? 'non-positive price with volume' : null;
      if (bad) { R.counts.ohlc++; if (R.ohlc.length < maxPer) R.ohlc.push({ ticker: sh.ticker, d: r.d, why: bad, o: r.o, hi: r.hi, lo: r.lo, c: r.c, v: r.v }); }
    }
    // gaps against the market calendar (interior only — a late listing or a
    // delisting is absence, not a hole)
    for (let i = 1; i < S.length; i++) {
      const a = calIdx[S[i-1].d], b = calIdx[S[i].d];
      if (a == null || b == null) continue;
      const missed = b - a - 1;
      if (missed >= gapMin) {
        R.counts.gaps++;
        if (R.gaps.length < maxPer) {
          const pc = +S[i-1].c, cc = +S[i].c;
          R.gaps.push({ ticker: sh.ticker, fromD: S[i-1].d, toD: S[i].d, marketDaysMissing: missed,
            closeBefore: pc, closeAfter: cc,
            moveAcrossGapPct: (pc > 0 && cc > 0) ? +(((cc / pc) - 1) * 100).toFixed(1) : null });
        }
      }
    }
    // flat runs with volume
    let run = 1;
    for (let i = 1; i <= S.length; i++) {
      if (i < S.length && S[i].c === S[i-1].c && S[i].c > 0) { run++; continue; }
      if (run >= flatMin) {
        const anyVol = S.slice(i - run, i).some(r => r.v > 0);
        if (anyVol) { R.counts.flat++; if (R.flat.length < maxPer) R.flat.push({ ticker: sh.ticker, fromD: S[i-run].d, toD: S[i-1].d, days: run, close: S[i-1].c }); }
      }
      run = 1;
    }
    // spike-and-revert (bad-tick shape)
    for (let i = 1; i < S.length - 1; i++) {
      const a = +S[i-1].c, b = +S[i].c, c = +S[i+1].c;
      if (!(a > 0 && b > 0 && c > 0)) continue;
      const up = b / a, back = c / b;
      if ((up > 1.6 && back < 0.7 && Math.abs(c / a - 1) < 0.15) ||
          (up < 0.625 && back > 1.43 && Math.abs(c / a - 1) < 0.15)) {
        R.counts.spikes++;
        if (R.spikes.length < maxPer) R.spikes.push({ ticker: sh.ticker, d: S[i].d, dayMovePct: +((up - 1) * 100).toFixed(1), nextDayPct: +((back - 1) * 100).toFixed(1), closes: [a, b, c] });
      }
    }
  }
  // the corp list is most useful sorted by size
  R.corp.sort((x, y) => (y.factor - x.factor) || (x.ticker < y.ticker ? -1 : 1));
  return R;
}

// w496 — THE PULLBACK ENTRY, as a measurable arm rather than a built feature.
//
// The idea: rather than chasing a signal on the day it fires, wait N sessions
// and buy only if the share has since fallen between minPct and maxPct below the
// signal close. A cheaper entry on a share the evidence already liked.
//
// The reason it needs testing rather than building: a share that falls 5-10% in
// the days AFTER an accumulation or breakout signal may be telling you the
// signal failed. This rule would systematically buy the ones where the thesis
// broke and skip the ones that worked — the opposite selection to the one the
// trailing-stop evidence favoured, where this band's return lives in shares that
// keep running. It might still win on price. Nobody knows, so it gets measured.
//
// Two numbers matter equally here. The per-trade return, and the TRIGGER RATE:
// if only a fifth of signals ever pull back into the window, the strategy trades
// a fifth as often, and a better average on far fewer trades may still compound
// to less. Both are reported.
function _findPullbackEntry(series, pickIdx, waitDays, minPct, maxPct, windowEndIdx){
  const pickClose = series[pickIdx] && series[pickIdx].c;
  if (!(pickClose > 0)) return { armed:false, why:'no close on the signal day' };
  const checkIdx = pickIdx + waitDays;
  if (checkIdx > windowEndIdx || !series[checkIdx]) return { armed:false, why:'window ended before the wait elapsed' };
  const day = series[checkIdx];
  const px = day.c;
  if (!(px > 0)) return { armed:false, why:'no close on the check day' };
  const fallPct = ((pickClose - px) / pickClose) * 100;
  // the band is inclusive at both ends; a 5.0% or 10.0% fall qualifies
  if (fallPct < minPct - 1e-9 || fallPct > maxPct + 1e-9)
    return { armed:false, fallPct:+fallPct.toFixed(2), why: fallPct < minPct ? 'not fallen enough' : 'fallen too far' };
  // fills at the NEXT session's open, matching every other entry in this engine:
  // the check uses a close, so the earliest honest fill is the following open.
  const fillIdx = checkIdx + 1;
  const nxt = series[fillIdx];
  if (fillIdx > windowEndIdx || !nxt || !(nxt.o > 0))
    return { armed:true, filled:false, fallPct:+fallPct.toFixed(2), why:'no session after the check day' };
  return { armed:true, filled:true, fillIdx, fillPrice:nxt.o,
    fallPct:+fallPct.toFixed(2), pickClose, checkDate:day.d };
}

function _simulateFixedTargetStop(series, pickIdx, entryEndIdx, windowEndIdx, levelPct, amountDollars, targetPct, stopPct, pull){
  const pickClose=series[pickIdx].c;
  const limitPrice=levelPct===0?null:+(pickClose*(1+levelPct/100)).toFixed(4);
  let fillIdx=null, fillPrice=null;
  // w496 — the pullback arm replaces the entry entirely; everything after the
  // fill (exits, costs, accounting) is untouched, so the comparison isolates
  // the entry rule and nothing else.
  if(pull&&pull.on){
    const pb=_findPullbackEntry(series, pickIdx, pull.waitDays, pull.minPct, pull.maxPct, windowEndIdx);
    if(!pb.armed||!pb.filled) return {level:levelPct, limitPrice:null, filled:false, pullback:pb};
    fillIdx=pb.fillIdx; fillPrice=pb.fillPrice;
  } else if(levelPct===0){
    const nxt=series[pickIdx+1];
    if(pickIdx+1<=entryEndIdx&&nxt&&nxt.o>0){ fillIdx=pickIdx+1; fillPrice=nxt.o; }
  } else {
    for(let i=pickIdx+1;i<=entryEndIdx;i++){
      const day=series[i]; if(!day)break;
      if(day.o>0&&day.o<=limitPrice){ fillIdx=i; fillPrice=day.o; break; }
      if(day.lo>0&&day.lo<=limitPrice){ fillIdx=i; fillPrice=limitPrice; break; }
    }
  }
  if(fillIdx===null)return {level:levelPct, limitPrice, filled:false};
  const targetPrice=fillPrice*(1+targetPct/100);
  const stopPrice=fillPrice*(1-stopPct/100);
  let exitIdx=null, exitPrice=null, exitWhy=null;
  for(let i=fillIdx+1;i<=windowEndIdx;i++){
    const day=series[i]; if(!day)break;
    if(stopPct>0){
      if(day.o>0&&day.o<=stopPrice){ exitIdx=i; exitPrice=day.o; exitWhy='stop'; break; }
      if(day.lo>0&&day.lo<=stopPrice){ exitIdx=i; exitPrice=stopPrice; exitWhy='stop'; break; }
    }
    if(targetPct>0){
      if(day.o>0&&day.o>=targetPrice){ exitIdx=i; exitPrice=day.o; exitWhy='target'; break; }
      if(day.hi>0&&day.hi>=targetPrice){ exitIdx=i; exitPrice=targetPrice; exitWhy='target'; break; }
    }
  }
  if(exitIdx===null){ exitIdx=windowEndIdx; exitPrice=series[windowEndIdx].c; exitWhy='window-end'; }
  const qty=amountDollars/fillPrice;
  const proceeds=qty*exitPrice;
  const pl=proceeds-amountDollars;
  const plPct=(proceeds/amountDollars-1)*100;
  return {level:levelPct, limitPrice, filled:true, fillDate:series[fillIdx].d, fillPrice,
    exitDate:series[exitIdx].d, exitPrice, exitWhy,
    // w481 — heldDays was only ever set by the TRAILING simulator, so the
    // head-to-head table printed "avg hold 0 days" against both fixed rules.
    // Returns were never affected; the column was reading a field this
    // function had simply never filled in.
    heldDays:exitIdx-fillIdx,
    invested:amountDollars, totalProceeds:+proceeds.toFixed(2), pl:+pl.toFixed(2), plPct:+plPct.toFixed(2)};
}
// w477 — THE TRAILING EXIT. The benchmark run made the case: in the $0.15-$1.75
// band the typical share drifted +16.9% over the window while the best went
// +4,071%. A +20% take-profit cannot ever hold that share — it sells it in the
// first week and books a win. The strategy picks better than random and then
// caps the exact tail that pays for everything.
//
// So: no take-profit at all. The stop starts trailPct below the fill and only
// ever RISES, ratcheting on each higher CLOSE — deliberately the same basis as
// the live app (peakClose, v352/v385), so a result here means something for the
// real thing rather than for a nicer simulation. The trigger is intraday: an
// open below the stop fills at the open (a gap is not a limit), otherwise a low
// through the stop fills at the stop.
//
// Entry is untouched — same limit, same fill rules — so this isolates the exit
// and nothing else.
function _simulateTrailingStop(series, pickIdx, entryEndIdx, windowEndIdx, levelPct, amountDollars, trailPct, pull, peakBasis){
  const pickClose=series[pickIdx].c;
  const limitPrice=levelPct===0?null:+(pickClose*(1+levelPct/100)).toFixed(4);
  let fillIdx=null, fillPrice=null;
  if(pull&&pull.on){
    const pb=_findPullbackEntry(series, pickIdx, pull.waitDays, pull.minPct, pull.maxPct, windowEndIdx);
    if(!pb.armed||!pb.filled) return {level:levelPct, limitPrice:null, filled:false, pullback:pb};
    fillIdx=pb.fillIdx; fillPrice=pb.fillPrice;
  } else if(levelPct===0){
    const nxt=series[pickIdx+1];
    if(pickIdx+1<=entryEndIdx&&nxt&&nxt.o>0){ fillIdx=pickIdx+1; fillPrice=nxt.o; }
  } else {
    for(let i=pickIdx+1;i<=entryEndIdx;i++){
      const day=series[i]; if(!day)break;
      if(day.o>0&&day.o<=limitPrice){ fillIdx=i; fillPrice=day.o; break; }
      if(day.lo>0&&day.lo<=limitPrice){ fillIdx=i; fillPrice=limitPrice; break; }
    }
  }
  if(fillIdx===null)return {level:levelPct, limitPrice, filled:false};
  const tp=(+trailPct>0)?+trailPct:0;
  let peak=fillPrice, stopPrice=fillPrice*(1-tp/100), peakDate=series[fillIdx].d;
  let exitIdx=null, exitPrice=null, exitWhy=null;
  for(let i=fillIdx+1;i<=windowEndIdx;i++){
    const day=series[i]; if(!day)break;
    if(tp>0){
      if(day.o>0&&day.o<=stopPrice){ exitIdx=i; exitPrice=day.o; exitWhy='trail'; break; }
      if(day.lo>0&&day.lo<=stopPrice){ exitIdx=i; exitPrice=stopPrice; exitWhy='trail'; break; }
    }
    // ratchet AFTER the day's trigger test \u2014 the stop that applies today is the
    // one set by yesterday's bar, which is how it works on a real account.
    // w538: 'high' ratchets on the day's HIGH instead of its close. The ratchet
    // still lands AFTER the trigger test, so today's high can only tighten
    // TOMORROW's stop \u2014 never the stop that today's low was judged against.
    // Without that ordering the simulation would need to know whether the high
    // printed before or after the low, which daily data cannot say.
    const _pk=(peakBasis==='high') ? ((day.hi>0)?day.hi:day.c) : day.c;
    if(_pk>peak){ peak=_pk; peakDate=day.d; stopPrice=peak*(1-tp/100); }
  }
  if(exitIdx===null){ exitIdx=windowEndIdx; exitPrice=series[windowEndIdx].c; exitWhy='window-end'; }
  const qty=amountDollars/fillPrice;
  const proceeds=qty*exitPrice;
  const pl=proceeds-amountDollars;
  const plPct=(proceeds/amountDollars-1)*100;
  return {level:levelPct, limitPrice, filled:true, fillDate:series[fillIdx].d, fillPrice,
    exitDate:series[exitIdx].d, exitPrice, exitWhy,
    peakPrice:+peak.toFixed(4), peakDate:peakDate,
    peakGainPct:+(((peak/fillPrice)-1)*100).toFixed(2),
    heldDays:exitIdx-fillIdx,
    invested:amountDollars, totalProceeds:+proceeds.toFixed(2), pl:+pl.toFixed(2), plPct:+plPct.toFixed(2)};
}
function _dipLadderBacktestFixedTS(shares, params){
  const {entryDays=5, totalWeeks=52, topN=7, amountPerLevel=5000,
    targetPct=10, stopPct=10,
    levels=[-10,-5,-2.5,0], liqFloor=250000} = params||{};
  const X=_auditNewCtx(shares, 5, null, liqFloor);
  _auditRunAll(X);
  const recs=X.recs;
  const A=_auditFinalize(X);
  const M=A.M;
  const EXCLUDE={di:1,'vr-':1,'blk-':1,vr:1,blk:1};
  const tierRank={solid:2,promising:1,early:0};
  const byDay={};
  for(const rec of recs){
    let best=null;
    for(const k of rec.ks){
      if(EXCLUDE[k])continue;
      const m=M[k]; if(!m||m.tier==='early')continue;
      if(!best||tierRank[m.tier]>tierRank[best.tier]||(tierRank[m.tier]===tierRank[best.tier]&&m.edge>best.edge))
        best={key:k,tier:m.tier,edge:m.edge};
    }
    if(!best)continue;
    (byDay[rec.d]||(byDay[rec.d]=[])).push({ticker:rec.ticker,key:best.key,tier:best.tier,edge:best.edge});
  }
  const allDates=new Set();
  for(const s of shares)for(const r of s.series)allDates.add(r.d);
  const calendar=[...allDates].sort();
  const nCal=calendar.length;
  const totalDaysCount=totalWeeks*5;
  if(nCal<totalDaysCount+5)return {error:'not enough trading history for a '+totalWeeks+'-week window'};
  const windowStartCalIdx=Math.max(0,nCal-totalDaysCount);
  const windowEndCalIdx=nCal-1;
  const windowStartDate=calendar[windowStartCalIdx];
  const windowEndDate=calendar[windowEndCalIdx];
  const blocks=[];
  for(let i=windowStartCalIdx;i<=windowEndCalIdx;i+=entryDays){
    const blockEnd=Math.min(i+entryDays-1,windowEndCalIdx);
    blocks.push({startIdx:i,endIdx:blockEnd,startDate:calendar[i],endDate:calendar[blockEnd]});
  }
  const shareByTicker={}; for(const s of shares)shareByTicker[s.ticker]=s;
  const results=[];
  const seenEver=new Set(); // GLOBAL dedupe across the whole window — "don't buy same share twice"
  for(const block of blocks){
    const blockDays=calendar.slice(block.startIdx,block.endIdx+1);
    for(const d of blockDays){
      const picks=(byDay[d]||[]).slice().sort((a,b)=>(tierRank[b.tier]-tierRank[a.tier])||(b.edge-a.edge)).slice(0,topN);
      for(const p of picks){
        if(seenEver.has(p.ticker))continue;
        seenEver.add(p.ticker);
        const sh=shareByTicker[p.ticker]; if(!sh)continue;
        const series=sh.series;
        const dateIdx={}; for(let i=0;i<series.length;i++)dateIdx[series[i].d]=i;
        const pickIdx=dateIdx[d]; if(pickIdx==null)continue;
        const idxForDate=(targetDate)=>{
          if(dateIdx[targetDate]!=null)return dateIdx[targetDate];
          let lo=0,hi=series.length-1,ans=null;
          while(lo<=hi){ const mid=(lo+hi)>>1; if(series[mid].d<=targetDate){ans=mid;lo=mid+1;} else hi=mid-1; }
          return ans;
        };
        const entryEndIdx=idxForDate(block.endDate);
        const windowEndIdx=idxForDate(windowEndDate);
        if(entryEndIdx==null||windowEndIdx==null||windowEndIdx<=pickIdx)continue;
        const levelResults=levels.map(lv=>_simulateFixedTargetStop(series,pickIdx,entryEndIdx,windowEndIdx,lv,amountPerLevel,targetPct,stopPct));
        results.push({ticker:p.ticker,pickDate:d,weekStart:block.startDate,evidenceKey:p.key,tier:p.tier,edge:p.edge,levels:levelResults});
      }
    }
  }
  const perLevel={};
  for(const lv of levels)perLevel[lv]={filled:0,notFilled:0,invested:0,proceeds:0,wins:0};
  for(const r of results){
    for(const lr of r.levels){
      const agg=perLevel[lr.level];
      if(!lr.filled){agg.notFilled++;continue;}
      agg.filled++; agg.invested+=lr.invested; agg.proceeds+=lr.totalProceeds; if(lr.pl>0)agg.wins++;
    }
  }
  const perLevelSummary=levels.map(lv=>{
    const a=perLevel[lv];
    const pl=a.proceeds-a.invested;
    return {level:lv, candidates:results.length, filled:a.filled, notFilled:a.notFilled,
      invested:+a.invested.toFixed(2), proceeds:+a.proceeds.toFixed(2), pl:+pl.toFixed(2),
      plPct:a.invested>0?+((pl/a.invested)*100).toFixed(2):0,
      winRate:a.filled>0?+((a.wins/a.filled)*100).toFixed(1):0};
  });
  return { windowStartDate, windowEndDate, blockCount:blocks.length, candidateCount:results.length,
    params:{entryDays,totalWeeks,topN,amountPerLevel,targetPct,stopPct,levels},
    perLevelSummary, candidates:results };
}
// w444 — Tony's fine-tune: same once-only, 4-level fixed target/stop rig,
// but the evidence filter now requires a computed _cardScore10 of at least
// minScore (default 7) rather than simply excluding 'early' tier. Since
// _cardScore10's own bands put 'solid' at [7,10] and 'promising' at [4,7],
// this is NOT the same as "tier==='solid' only" — it also lets through the
// rare, strong 'promising' line whose edge is big enough to score 7+ on its
// own terms, matching exactly how the app's own auto-pilot "min score"
// gate already works (applyBotBestPractice's own "min score 7"), rather
// than inventing a new standard for this one feature.
function _dipLadderBacktestFixedTSScored(shares, params){
  const {entryDays=5, totalWeeks=52, topN=7, amountPerLevel=5000,
    targetPct=10, stopPct=10, minScore=7,
    levels=[-10,-5,-2.5,0], liqFloor=250000} = params||{};
  const X=_auditNewCtx(shares, 5, null, liqFloor);
  _auditRunAll(X);
  const recs=X.recs;
  const A=_auditFinalize(X);
  const M=A.M;
  const EXCLUDE={di:1,'vr-':1,'blk-':1,vr:1,blk:1};
  const byDay={};
  for(const rec of recs){
    let best=null;
    for(const k of rec.ks){
      if(EXCLUDE[k])continue;
      const m=M[k]; if(!m)continue;
      const sc=_cardScore10(m);
      if(sc<minScore)continue; // the actual new gate — not simply "not early"
      if(!best||sc>best.score||(sc===best.score&&m.edge>best.edge))
        best={key:k,tier:m.tier,edge:m.edge,score:sc};
    }
    if(!best)continue;
    (byDay[rec.d]||(byDay[rec.d]=[])).push({ticker:rec.ticker,key:best.key,tier:best.tier,edge:best.edge,score:best.score});
  }
  const allDates=new Set();
  for(const s of shares)for(const r of s.series)allDates.add(r.d);
  const calendar=[...allDates].sort();
  const nCal=calendar.length;
  const totalDaysCount=totalWeeks*5;
  if(nCal<totalDaysCount+5)return {error:'not enough trading history for a '+totalWeeks+'-week window'};
  const windowStartCalIdx=Math.max(0,nCal-totalDaysCount);
  const windowEndCalIdx=nCal-1;
  const windowStartDate=calendar[windowStartCalIdx];
  const windowEndDate=calendar[windowEndCalIdx];
  const blocks=[];
  for(let i=windowStartCalIdx;i<=windowEndCalIdx;i+=entryDays){
    const blockEnd=Math.min(i+entryDays-1,windowEndCalIdx);
    blocks.push({startIdx:i,endIdx:blockEnd,startDate:calendar[i],endDate:calendar[blockEnd]});
  }
  const shareByTicker={}; for(const s of shares)shareByTicker[s.ticker]=s;
  const results=[];
  const seenEver=new Set(); // once-only across the whole window, still the established better choice
  for(const block of blocks){
    const blockDays=calendar.slice(block.startIdx,block.endIdx+1);
    for(const d of blockDays){
      const picks=(byDay[d]||[]).slice().sort((a,b)=>(b.score-a.score)||(b.edge-a.edge)).slice(0,topN);
      for(const p of picks){
        if(seenEver.has(p.ticker))continue;
        seenEver.add(p.ticker);
        const sh=shareByTicker[p.ticker]; if(!sh)continue;
        const series=sh.series;
        const dateIdx={}; for(let i=0;i<series.length;i++)dateIdx[series[i].d]=i;
        const pickIdx=dateIdx[d]; if(pickIdx==null)continue;
        const idxForDate=(targetDate)=>{
          if(dateIdx[targetDate]!=null)return dateIdx[targetDate];
          let lo=0,hi=series.length-1,ans=null;
          while(lo<=hi){ const mid=(lo+hi)>>1; if(series[mid].d<=targetDate){ans=mid;lo=mid+1;} else hi=mid-1; }
          return ans;
        };
        const entryEndIdx=idxForDate(block.endDate);
        const windowEndIdx=idxForDate(windowEndDate);
        if(entryEndIdx==null||windowEndIdx==null||windowEndIdx<=pickIdx)continue;
        const levelResults=levels.map(lv=>_simulateFixedTargetStop(series,pickIdx,entryEndIdx,windowEndIdx,lv,amountPerLevel,targetPct,stopPct));
        results.push({ticker:p.ticker,pickDate:d,weekStart:block.startDate,evidenceKey:p.key,tier:p.tier,edge:p.edge,score:p.score,levels:levelResults});
      }
    }
  }
  const perLevel={};
  for(const lv of levels)perLevel[lv]={filled:0,notFilled:0,invested:0,proceeds:0,wins:0};
  for(const r of results){
    for(const lr of r.levels){
      const agg=perLevel[lr.level];
      if(!lr.filled){agg.notFilled++;continue;}
      agg.filled++; agg.invested+=lr.invested; agg.proceeds+=lr.totalProceeds; if(lr.pl>0)agg.wins++;
    }
  }
  const perLevelSummary=levels.map(lv=>{
    const a=perLevel[lv];
    const pl=a.proceeds-a.invested;
    return {level:lv, candidates:results.length, filled:a.filled, notFilled:a.notFilled,
      invested:+a.invested.toFixed(2), proceeds:+a.proceeds.toFixed(2), pl:+pl.toFixed(2),
      plPct:a.invested>0?+((pl/a.invested)*100).toFixed(2):0,
      winRate:a.filled>0?+((a.wins/a.filled)*100).toFixed(1):0};
  });
  return { windowStartDate, windowEndDate, blockCount:blocks.length, candidateCount:results.length,
    params:{entryDays,totalWeeks,topN,amountPerLevel,targetPct,stopPct,minScore,levels},
    perLevelSummary, candidates:results };
}

// w445 — Tony's fair pushback: the concurrent-exposure figures assumed
// buying EVERY evidence pick with no limit, which overstates what capital
// is actually needed since a real account caps how many positions it holds
// at once (matching the app's own maxPositions setting) and simply skips
// new candidates once full. This enforces that cap directly: candidates are
// processed in chronological pick order, a position counts as open from its
// fill day up to (not including) its exit day, and once the open count
// already equals maxPositions, the next candidate is skipped entirely —
// not bought at any level. Uses a SINGLE buy level (matching a real
// auto-pilot's one-position-per-share behaviour, not 4 parallel orders),
// same score>=7 evidence filter and once-only-per-year dedupe as before.
// The capital this needs is no longer a statistical estimate — it's exactly
// maxPositions * amountPerLevel, a fixed, known number.
function _dipLadderBacktestCapped(shares, params){
  const {entryDays=5, totalWeeks=52, topN=4, amountPerLevel=5000,
    targetPct=10, stopPct=10, minScore=7, buyLevel=-5, maxPositions=8,
    liqFloor=250000} = params||{};
  const X=_auditNewCtx(shares, 5, null, liqFloor);
  _auditRunAll(X);
  const recs=X.recs;
  const A=_auditFinalize(X);
  const M=A.M;
  const EXCLUDE={di:1,'vr-':1,'blk-':1,vr:1,blk:1};
  const byDay={};
  for(const rec of recs){
    let best=null;
    for(const k of rec.ks){
      if(EXCLUDE[k])continue;
      const m=M[k]; if(!m)continue;
      const sc=_cardScore10(m);
      if(sc<minScore)continue;
      if(!best||sc>best.score||(sc===best.score&&m.edge>best.edge))
        best={key:k,tier:m.tier,edge:m.edge,score:sc};
    }
    if(!best)continue;
    (byDay[rec.d]||(byDay[rec.d]=[])).push({ticker:rec.ticker,key:best.key,tier:best.tier,edge:best.edge,score:best.score});
  }
  const allDates=new Set();
  for(const s of shares)for(const r of s.series)allDates.add(r.d);
  const calendar=[...allDates].sort();
  const nCal=calendar.length;
  const totalDaysCount=totalWeeks*5;
  if(nCal<totalDaysCount+5)return {error:'not enough trading history for a '+totalWeeks+'-week window'};
  const windowStartCalIdx=Math.max(0,nCal-totalDaysCount);
  const windowEndCalIdx=nCal-1;
  const windowStartDate=calendar[windowStartCalIdx];
  const windowEndDate=calendar[windowEndCalIdx];
  const blocks=[];
  for(let i=windowStartCalIdx;i<=windowEndCalIdx;i+=entryDays){
    const blockEnd=Math.min(i+entryDays-1,windowEndCalIdx);
    blocks.push({startIdx:i,endIdx:blockEnd,startDate:calendar[i],endDate:calendar[blockEnd]});
  }
  const shareByTicker={}; for(const s of shares)shareByTicker[s.ticker]=s;

  // Build the once-only, top-N-per-week candidate list first, in
  // chronological order — identical selection to the uncapped version, so
  // the ONLY difference from here on is whether the cap lets a pick through.
  const seenEver=new Set();
  const candidatesChrono=[];
  for(const block of blocks){
    const blockDays=calendar.slice(block.startIdx,block.endIdx+1);
    for(const d of blockDays){
      const picks=(byDay[d]||[]).slice().sort((a,b)=>(b.score-a.score)||(b.edge-a.edge)).slice(0,topN);
      for(const p of picks){
        if(seenEver.has(p.ticker))continue;
        seenEver.add(p.ticker);
        candidatesChrono.push({ticker:p.ticker,pickDate:d,weekStart:block.startDate,entryEndDate:block.endDate,evidenceKey:p.key,tier:p.tier,edge:p.edge,score:p.score});
      }
    }
  }

  const open=[]; // {fillDate, exitDate} of CONFIRMED, cap-admitted positions
  const results=[];

  // Phase 1 — simulate every offered candidate's entry/exit independently of
  // the cap. Whether/when an order fills is purely a function of price
  // action, not of how many other positions exist, so this must not be
  // gated by admission.
  const simmed=[];
  for(const cand of candidatesChrono){
    const sh=shareByTicker[cand.ticker];
    if(!sh){ simmed.push(Object.assign({},cand,{level:null,reason:'no-series'})); continue; }
    const series=sh.series;
    const dateIdx={}; for(let i=0;i<series.length;i++)dateIdx[series[i].d]=i;
    const pickIdx=dateIdx[cand.pickDate];
    const idxForDate=(targetDate)=>{
      if(dateIdx[targetDate]!=null)return dateIdx[targetDate];
      let lo=0,hi=series.length-1,ans=null;
      while(lo<=hi){ const mid=(lo+hi)>>1; if(series[mid].d<=targetDate){ans=mid;lo=mid+1;} else hi=mid-1; }
      return ans;
    };
    const entryEndIdx=idxForDate(cand.entryEndDate);
    const windowEndIdx=idxForDate(windowEndDate);
    if(pickIdx==null||entryEndIdx==null||windowEndIdx==null||windowEndIdx<=pickIdx){
      simmed.push(Object.assign({},cand,{level:{filled:false}}));
      continue;
    }
    const lr=_simulateFixedTargetStop(series,pickIdx,entryEndIdx,windowEndIdx,buyLevel,amountPerLevel,targetPct,stopPct);
    simmed.push(Object.assign({},cand,{level:lr}));
  }

  // Phase 2 — among candidates whose price action WOULD have filled them,
  // admit in actual fill-date order (not pick-date order): two candidates
  // picked days apart can both fill on the very same later day once their
  // entry windows overlap, so pick-date order alone is not a safe proxy for
  // "who actually needed a slot first." Ties broken by score, matching the
  // original selection priority.
  const wouldFill=simmed.filter(c=>c.level&&c.level.filled);
  const neverFilled=simmed.filter(c=>!(c.level&&c.level.filled));
  wouldFill.sort((a,b)=>(a.level.fillDate<b.level.fillDate?-1:(a.level.fillDate>b.level.fillDate?1:(b.score-a.score))));
  for(const cand of wouldFill){
    const openCount=open.filter(o=>o.fillDate<=cand.level.fillDate && o.exitDate>cand.level.fillDate).length;
    if(openCount>=maxPositions){ results.push(Object.assign({},cand,{skipped:true,openAtFill:openCount})); continue; }
    open.push({fillDate:cand.level.fillDate, exitDate:cand.level.exitDate});
    results.push(Object.assign({},cand,{skipped:false,openAtFill:openCount}));
  }
  for(const cand of neverFilled) results.push(Object.assign({},cand,{skipped:false,openAtFill:0}));

  const offered=results.length;
  const skippedForCap=results.filter(r=>r.skipped).length;
  const taken=results.filter(r=>!r.skipped);
  const filled=taken.filter(r=>r.level&&r.level.filled);
  const invested=filled.reduce((s,r)=>s+r.level.invested,0);
  const proceeds=filled.reduce((s,r)=>s+r.level.totalProceeds,0);
  const wins=filled.filter(r=>r.level.pl>0).length;
  const pl=proceeds-invested;
  const holdDaysArr=filled.map(r=>{
    const a=new Date(r.level.fillDate+'T00:00:00Z'), b=new Date(r.level.exitDate+'T00:00:00Z');
    return Math.round((b-a)/86400000);
  }).sort((a,b)=>a-b);
  const avgHoldDays=holdDaysArr.length?+(holdDaysArr.reduce((s,v)=>s+v,0)/holdDaysArr.length).toFixed(1):0;
  const medianHoldDays=holdDaysArr.length?holdDaysArr[Math.floor(holdDaysArr.length/2)]:0;
  const summary={
    offered, skippedForCap, taken:taken.length, filled:filled.length, notFilled:taken.length-filled.length,
    invested:+invested.toFixed(2), proceeds:+proceeds.toFixed(2), pl:+pl.toFixed(2),
    plPct:invested>0?+((pl/invested)*100).toFixed(2):0,
    winRate:filled.length>0?+((wins/filled.length)*100).toFixed(1):0,
    avgHoldDays, medianHoldDays
  };
  return { windowStartDate, windowEndDate, blockCount:blocks.length,
    params:{entryDays,totalWeeks,topN,amountPerLevel,targetPct,stopPct,minScore,buyLevel,maxPositions},
    fixedCapitalRequired:maxPositions*amountPerLevel,
    summary, candidates:results };
}

// w457 — Tony asked to run 15/15 over the ~2.7-year window starting with
// $50,000 and COMPOUNDING, rather than a fixed dollar amount per trade.
// This is a genuinely different simulation from everything else built this
// session: each new position is sized as (current account value) /
// maxPositions AT THE MOMENT IT FILLS, not a fixed $X — so a position
// opened after a string of wins is bigger than one opened after losses,
// same as real compounding. "Current account value" is tracked as
// starting capital + realized P&L from every position that has ALREADY
// closed by that point (open positions are carried at cost, not marked to
// market, to avoid needing a daily price for every open position — this is
// standard book-value accounting, not a simplification that changes the
// answer). Candidates are processed in fill-date order so the cap and the
// account value are both always current as of the actual moment each new
// position would open. Verified against a hand-calculated scenario before
// use (see the test suite) — traced through by hand to a specific expected
// final value and matched to the cent.
function _dipLadderCompounding(shares, params){
  const {entryDays=5, totalWeeks=140, topN=4, minScore=7, buyLevel=-5,
    targetPct=15, stopPct=15, maxPositions=8, startingCapital=50000,
    excludeNonEquity=true, liqFloor=250000} = params||{};
  const useShares = excludeNonEquity ? shares.filter(s=>!_NONEQUITY_EXCLUDE.has(s.ticker)) : shares;
  const X=_auditNewCtx(useShares, 5, null, liqFloor);
  _auditRunAll(X);
  const recs=X.recs;
  const A=_auditFinalize(X);
  const M=A.M;
  const EXCLUDE={di:1,'vr-':1,'blk-':1,vr:1,blk:1};
  const byDay={};
  for(const rec of recs){
    let best=null;
    for(const k of rec.ks){
      if(EXCLUDE[k])continue;
      const m=M[k]; if(!m)continue;
      const sc=_cardScore10(m);
      if(sc<minScore)continue;
      if(!best||sc>best.score||(sc===best.score&&m.edge>best.edge))
        best={key:k,tier:m.tier,edge:m.edge,score:sc};
    }
    if(!best)continue;
    (byDay[rec.d]||(byDay[rec.d]=[])).push({ticker:rec.ticker,key:best.key,tier:best.tier,edge:best.edge,score:best.score});
  }
  const allDates=new Set();
  for(const s of useShares)for(const r of s.series)allDates.add(r.d);
  const calendar=[...allDates].sort();
  const nCal=calendar.length;
  const totalDaysCount=totalWeeks*5;
  if(nCal<totalDaysCount+5)return {error:'not enough trading history for a '+totalWeeks+'-week window'};
  const windowStartCalIdx=Math.max(0,nCal-totalDaysCount);
  const windowEndCalIdx=nCal-1;
  const windowStartDate=calendar[windowStartCalIdx];
  const windowEndDate=calendar[windowEndCalIdx];
  const blocks=[];
  for(let i=windowStartCalIdx;i<=windowEndCalIdx;i+=entryDays){
    const blockEnd=Math.min(i+entryDays-1,windowEndCalIdx);
    blocks.push({startIdx:i,endIdx:blockEnd,startDate:calendar[i],endDate:calendar[blockEnd]});
  }
  const shareByTicker={}; for(const s of useShares)shareByTicker[s.ticker]=s;

  // Build the once-only candidate list and simulate each with a $1
  // placeholder — %-based fill/exit logic doesn't depend on dollar amount,
  // so this gets the fillDate/exitDate/plPct cheaply, once, up front.
  const seenEver=new Set();
  const simmed=[];
  for(const block of blocks){
    const blockDays=calendar.slice(block.startIdx,block.endIdx+1);
    for(const d of blockDays){
      const picks=(byDay[d]||[]).slice().sort((a,b)=>(b.score-a.score)||(b.edge-a.edge)).slice(0,topN);
      for(const p of picks){
        if(seenEver.has(p.ticker))continue;
        seenEver.add(p.ticker);
        const sh=shareByTicker[p.ticker]; if(!sh)continue;
        const series=sh.series;
        const dateIdx={}; for(let i=0;i<series.length;i++)dateIdx[series[i].d]=i;
        const pickIdx=dateIdx[d]; if(pickIdx==null)continue;
        const idxForDate=(targetDate)=>{
          if(dateIdx[targetDate]!=null)return dateIdx[targetDate];
          let lo=0,hi=series.length-1,ans=null;
          while(lo<=hi){ const mid=(lo+hi)>>1; if(series[mid].d<=targetDate){ans=mid;lo=mid+1;} else hi=mid-1; }
          return ans;
        };
        const entryEndIdx=idxForDate(block.endDate);
        const windowEndIdx=idxForDate(windowEndDate);
        if(entryEndIdx==null||windowEndIdx==null||windowEndIdx<=pickIdx)continue;
        const lr=_simulateFixedTargetStop(series,pickIdx,entryEndIdx,windowEndIdx,buyLevel,1,targetPct,stopPct);
        simmed.push({ticker:p.ticker,pickDate:d,evidenceKey:p.key,tier:p.tier,edge:p.edge,score:p.score,level:lr});
      }
    }
  }

  const wouldFill=simmed.filter(c=>c.level&&c.level.filled);
  wouldFill.sort((a,b)=>(a.level.fillDate<b.level.fillDate?-1:(a.level.fillDate>b.level.fillDate?1:(b.score-a.score))));

  let accountValue=startingCapital;
  const open=[]; // {fillDate, exitDate, size, dollarPL}
  const trades=[]; // admitted trades, in fill order
  const skipped=[]; // candidates turned away because the cap was full

  const settleThrough=(cutoffDate)=>{
    // settle every open position whose exit has happened ON OR BEFORE cutoffDate
    for(let i=open.length-1;i>=0;i--){
      if(open[i].exitDate<=cutoffDate){ accountValue+=open[i].dollarPL; open.splice(i,1); }
    }
  };

  for(const cand of wouldFill){
    settleThrough(cand.level.fillDate);
    const openCount=open.length; // everything still in `open` is, by construction, open as of this fillDate
    if(openCount>=maxPositions){ skipped.push(Object.assign({},cand,{openAtFill:openCount})); continue; }
    const size=accountValue/maxPositions;
    const dollarPL=size*(cand.level.plPct/100);
    open.push({fillDate:cand.level.fillDate, exitDate:cand.level.exitDate, size, dollarPL});
    trades.push({ticker:cand.ticker, pickDate:cand.pickDate, evidenceKey:cand.evidenceKey, tier:cand.tier, score:cand.score,
      fillDate:cand.level.fillDate, fillPrice:cand.level.fillPrice, exitDate:cand.level.exitDate, exitPrice:cand.level.exitPrice,
      exitWhy:cand.level.exitWhy, plPct:cand.level.plPct, accountValueAtEntry:+accountValue.toFixed(2),
      positionSize:+size.toFixed(2), dollarPL:+dollarPL.toFixed(2), openAtFill:openCount});
  }
  // settle everything still open at the very end of the window
  open.sort((a,b)=>(a.exitDate<b.exitDate?-1:(a.exitDate>b.exitDate?1:0)));
  for(const pos of open) accountValue+=pos.dollarPL;

  const wins=trades.filter(t=>t.dollarPL>0).length;
  return { windowStartDate, windowEndDate,
    params:{entryDays,totalWeeks,topN,minScore,buyLevel,targetPct,stopPct,maxPositions,startingCapital},
    excludeNonEquity, universeAfterExclusion:useShares.length,
    offered:wouldFill.length, skippedForCap:skipped.length, taken:trades.length,
    startingCapital, finalAccountValue:+accountValue.toFixed(2),
    totalReturnPct:+(((accountValue/startingCapital)-1)*100).toFixed(2),
    winRate:trades.length>0?+((wins/trades.length)*100).toFixed(1):0,
    trades, skipped };
}

// w465 — Tony's next question after the 10-year backfill hit an EODData 401
// (parked, an account-side issue, not something this worker can fix): the
// SAME agreed 15/15 rule, same -5% dip, same everything, run separately over
// FIVE share-price bands (<=$0.20, $0.20-$0.99, $1-$1.99, $2-$5, >$5) across
// the same ~2.7-year window that already works. This answers a different
// question from every prior variant: not "does a different filter change
// the picture" but "does the SAME strategy behave differently depending on
// what price tier the shares happen to be in" — plausible given how
// differently low-priced shares already behave elsewhere in this app (the
// scan engine's own 'thin-stock large move' and lowPx checks exist for
// exactly this reason).
//
// Mechanically this is five INDEPENDENT $50,000 compounding runs, each
// restricted to its own band — not one run with results tagged afterward —
// because "if this were your whole strategy, restricted to just this price
// range" is the fair, apples-to-apples version of the question, matching
// how every other variant (score threshold, Watch Score, dip level) was
// tested tonight as its own full run rather than a post-hoc slice.
//
// The band that decides eligibility is the PICK-DAY reference close — the
// same price the -5% dip limit is computed from — not the eventual fill
// price, since the question is "what tier was this share in when it became
// a candidate," and a genuine dip rarely moves it far enough to cross a
// band boundary. Candidates are excluded from the correct band's byDay
// pool BEFORE the top-4-by-score selection runs, not filtered afterward —
// so each band's top 4 are the top 4 among shares that were actually in
// that band that day, the same discipline used for the ETF exclusion (which
// also filters the universe before grading, not the output after).
function _dipLadderCompoundingByPriceBand(shares, params){
  const {entryDays=5, totalWeeks=140, topN=4, minScore=7, buyLevel=-5,
    targetPct=15, stopPct=15, maxPositions=8, startingCapital=50000,
    excludeNonEquity=true, liqFloor=250000, gradeDays=0,
    exitMode='fixed', trailPct=0, peakBasis='close', feePerSide=0, slipPct=0,   // w538: peakBasis 'close' (shipped) | 'high'
    entryMode='dip', pullWaitDays=5, pullMinPct=5, pullMaxPct=10,
    bands=[
      {label:'\u2264 $0.20',        min:0,    max:0.20},
      {label:'$0.20 \u2013 $0.99',  min:0.20, max:0.99},
      {label:'$1.00 \u2013 $1.99',  min:0.99, max:1.99},
      {label:'$2.00 \u2013 $5.00',  min:1.99, max:5.00},
      {label:'> $5.00',            min:5.00, max:Infinity}
    ]} = params||{};
  const useShares = excludeNonEquity ? shares.filter(s=>!_NONEQUITY_EXCLUDE.has(s.ticker)) : shares;
  // w496 — the pullback arm. entryMode:'pullback' waits pullWaitDays sessions
  // after the signal and buys at the next open ONLY if the share has fallen
  // between pullMinPct and pullMaxPct below the signal close.
  const PULL = (entryMode==='pullback')
    // w496 fix — `+0 || 5` is 5, so a 0% floor silently became 5% and a sweep
    // that included 0 returned nonsense: the WIDER 0-25% window found fewer
    // trades than the narrower 5-10% one, which is impossible for a real band.
    // Zero is a legitimate value here; only undefined should fall back.
    ? {on:true,
       waitDays:Math.max(1, (pullWaitDays==null?5:+pullWaitDays)||5),
       minPct: (pullMinPct==null||!isFinite(+pullMinPct)) ? 5 : +pullMinPct,
       maxPct: (pullMaxPct==null||!isFinite(+pullMaxPct)) ? 10 : +pullMaxPct}
    : {on:false};
  let pullSeen=0, pullFilled=0, pullShallow=0, pullDeep=0;
  // w473 — gradeDays. The engine only RECORDS a signal firing inside its
  // grading lookback (_AUD.DAYS, 250 trading days), so with the default the
  // simulator can print a 2.7-year "window" while every pick it makes falls in
  // the last twelve months — which is exactly what the earlier runs did. Asking
  // for a longer lookback is the only way to trade the older history.
  const X=_auditNewCtx(useShares, 5, null, liqFloor, gradeDays>0?gradeDays:0);
  _auditRunAll(X);
  const recs=X.recs;
  const A=_auditFinalize(X);
  const M=A.M;
  const EXCLUDE={di:1,'vr-':1,'blk-':1,vr:1,blk:1};

  // Built ONCE, shared by every band below — grading, the calendar, and the
  // per-ticker date index never depend on which band is being tested.
  const shareByTicker={}; for(const s of useShares)shareByTicker[s.ticker]=s;
  const dateIdxCache={};
  // w470 — corporate-action events per ticker, computed once and shared by every
  // band. 'news-like' events (volume moved the same way as price) are dropped
  // here: those are real moves, not arithmetic.
  const corpCache={};
  const corpFor=(ticker)=>{
    if(corpCache[ticker]!==undefined)return corpCache[ticker];
    const sh=shareByTicker[ticker];
    const ev=sh?_corpActionEvents(sh.series).filter(e=>e.confidence!=='news-like'):[];
    corpCache[ticker]=ev; return ev;
  };
  const idxOf=(ticker,d)=>{
    let di=dateIdxCache[ticker];
    if(!di){ const sh=shareByTicker[ticker]; if(!sh)return null;
      di={}; for(let i=0;i<sh.series.length;i++)di[sh.series[i].d]=i; dateIdxCache[ticker]=di; }
    return (di[d]!=null)?di[d]:null;
  };

  const allDates=new Set();
  for(const s of useShares)for(const r of s.series)allDates.add(r.d);
  const calendar=[...allDates].sort();
  const nCal=calendar.length;
  const totalDaysCount=totalWeeks*5;
  if(nCal<totalDaysCount+5)return {error:'not enough trading history for a '+totalWeeks+'-week window'};
  const windowStartCalIdx=Math.max(0,nCal-totalDaysCount);
  const windowEndCalIdx=nCal-1;
  const windowStartDate=calendar[windowStartCalIdx];
  const windowEndDate=calendar[windowEndCalIdx];
  const blocks=[];
  for(let i=windowStartCalIdx;i<=windowEndCalIdx;i+=entryDays){
    const blockEnd=Math.min(i+entryDays-1,windowEndCalIdx);
    blocks.push({startIdx:i,endIdx:blockEnd,startDate:calendar[i],endDate:calendar[blockEnd]});
  }

  const results=[];
  for(const band of bands){
    // A fresh byDay per band: the SAME rec can qualify for at most one band
    // (its pick-day price is a single number), so there is no double-counting
    // across bands — but each band's own top-4 selection must only ever see
    // its own in-band candidates, which is why this is rebuilt, not shared.
    const byDay={};
    for(const rec of recs){
      let best=null;
      for(const k of rec.ks){
        if(EXCLUDE[k])continue;
        const m=M[k]; if(!m)continue;
        const sc=_cardScore10(m);
        if(sc<minScore)continue;
        if(!best||sc>best.score||(sc===best.score&&m.edge>best.edge))
          best={key:k,tier:m.tier,edge:m.edge,score:sc};
      }
      if(!best)continue;
      const pIdx=idxOf(rec.ticker,rec.d); if(pIdx==null)continue;
      const sh=shareByTicker[rec.ticker]; if(!sh)continue;
      const refClose=+sh.series[pIdx].c; if(!(refClose>0))continue;
      if(!(refClose>band.min&&refClose<=band.max))continue; // the ONE line that differs per band
      (byDay[rec.d]||(byDay[rec.d]=[])).push({ticker:rec.ticker,key:best.key,tier:best.tier,edge:best.edge,score:best.score,refClose});
    }

    const seenEver=new Set();
    const simmed=[];
    for(const block of blocks){
      const blockDays=calendar.slice(block.startIdx,block.endIdx+1);
      for(const d of blockDays){
        const picks=(byDay[d]||[]).slice().sort((a,b)=>(b.score-a.score)||(b.edge-a.edge)).slice(0,topN);
        for(const p of picks){
          if(seenEver.has(p.ticker))continue;
          seenEver.add(p.ticker);
          const sh=shareByTicker[p.ticker]; if(!sh)continue;
          const series=sh.series;
          const pickIdx=idxOf(p.ticker,d); if(pickIdx==null)continue;
          const idxForDate=(targetDate)=>{
            const cached=idxOf(p.ticker,targetDate); if(cached!=null)return cached;
            let lo=0,hi=series.length-1,ans=null;
            while(lo<=hi){ const mid=(lo+hi)>>1; if(series[mid].d<=targetDate){ans=mid;lo=mid+1;} else hi=mid-1; }
            return ans;
          };
          const entryEndIdx=idxForDate(block.endDate);
          const windowEndIdx=idxForDate(windowEndDate);
          if(entryEndIdx==null||windowEndIdx==null||windowEndIdx<=pickIdx)continue;
          const lr=(exitMode==='trail')
            ? _simulateTrailingStop(series,pickIdx,entryEndIdx,windowEndIdx,buyLevel,1,trailPct,PULL,peakBasis)
            : _simulateFixedTargetStop(series,pickIdx,entryEndIdx,windowEndIdx,buyLevel,1,targetPct,stopPct,PULL);
          // w496 — the trigger rate. A rule that fires rarely can post a fine
          // average and still compound to less, so how OFTEN it arms is part of
          // the result rather than a footnote.
          if(PULL.on){ pullSeen++;
            if(lr&&lr.filled)pullFilled++;
            else if(lr&&lr.pullback){
              if(lr.pullback.why==='not fallen enough')pullShallow++;
              else if(lr.pullback.why==='fallen too far')pullDeep++;
            } }
          simmed.push({ticker:p.ticker,pickDate:d,evidenceKey:p.key,tier:p.tier,edge:p.edge,score:p.score,refClose:p.refClose,level:lr});
        }
      }
    }

    const wouldFillAll=simmed.filter(c=>c.level&&c.level.filled);
    wouldFillAll.sort((a,b)=>(a.level.fillDate<b.level.fillDate?-1:(a.level.fillDate>b.level.fillDate?1:(b.score-a.score))));

    // w470 — quarantine the ticker ACROSS the event, not just the trade. A
    // corporate action corrupts the reference close the limit price is derived
    // from as well as the exit, so a pick made in the days right before one is
    // no more trustworthy than the exit itself. Excluded candidates never enter
    // the account at all — removing the P&L but leaving the position-size
    // effects in place would be a second, quieter version of the same bug.
    // Note this also frees the position slot, so a filtered re-run is NOT
    // byte-identical to the old one even where nothing was fabricated. That is
    // correct behaviour, and the output says so rather than letting it look
    // like drift.
    const excludedCorp=[];
    const wouldFill=[];
    for(const c of wouldFillAll){
      const ev=corpFor(c.ticker);
      // w472 — the guard window is measured in CALENDAR days, not array steps.
      // It used to walk back five rows, which silently assumes the series is
      // dense. VAL's is not: a handful of 2024 bars, then a gap, then 2026. Five
      // rows back from a 2026 pick landed in April 2024, so a two-year-old
      // consolidation was blamed for a 2026 trade and a real losing trade was
      // removed. Both the trades excluded that way were losses, so the error
      // flattered the result — the direction that gets believed rather than
      // questioned, which is exactly why it is worth fixing.
      const guardFrom=_dMinusDays(c.pickDate, 14);
      const hit=ev.find(e=>e.d>guardFrom&&e.d<=c.level.exitDate);
      if(hit){
        excludedCorp.push({ticker:c.ticker, pickDate:c.pickDate, guardFrom:guardFrom, fillDate:c.level.fillDate,
          fillPrice:c.level.fillPrice, exitDate:c.level.exitDate, exitPrice:c.level.exitPrice,
          exitWhy:c.level.exitWhy, wouldHavePlPct:c.level.plPct, event:hit});
        continue;
      }
      wouldFill.push(c);
    }

    // The account walk, factored out so it can be run a second time with the
    // held-out large movers removed (see _exitOvershoot). Same arithmetic as
    // before, moved verbatim into a function — no behaviour change.
    const runAccount=(cands)=>{
      let accountValue=startingCapital;
      const open=[];
      const trades=[];
      const skipped=[];
      const settleThrough=(cutoffDate)=>{
        for(let i=open.length-1;i>=0;i--){
          if(open[i].exitDate<=cutoffDate){ accountValue+=open[i].dollarPL; open.splice(i,1); }
        }
      };
      for(const cand of cands){
        settleThrough(cand.level.fillDate);
        const openCount=open.length;
        if(openCount>=maxPositions){ skipped.push(Object.assign({},cand,{openAtFill:openCount})); continue; }
        const size=accountValue/maxPositions;
        // w479 — brokerage and slippage. Charged where the money moves rather
        // than as a flat haircut at the end, because the two sides are not
        // symmetrical and that asymmetry is the whole point:
        //   entry  — a DIP order is a limit sitting in the book, so it fills at
        //            the price asked or better: no slippage. A MARKET entry
        //            takes whatever the open offers, so it pays.
        //   exit   — a TARGET is a limit: no slippage. A TRAIL or STOP becomes a
        //            market order the moment it triggers, so it pays. So does a
        //            window-end close, since that position still has to be sold.
        // Every trailing exit therefore pays on the way out, which is exactly
        // the comparison the fixed-target runs would otherwise win for free.
        const _lv=cand.level;
        const _eSlip=(buyLevel===0)?(slipPct/100):0;
        const _xSlip=(_lv.exitWhy==='target')?0:(slipPct/100);
        let dollarPL, plPctNet;
        if(feePerSide>0||slipPct>0){
          const effFill=(+_lv.fillPrice)*(1+_eSlip);
          const effExit=(+_lv.exitPrice)*(1-_xSlip);
          const qty=(effFill>0)?(size/effFill):0;
          dollarPL=(qty*effExit)-size-(2*feePerSide);
          plPctNet=(size>0)?((dollarPL/size)*100):0;
        } else {
          dollarPL=size*(_lv.plPct/100);
          plPctNet=_lv.plPct;
        }
        open.push({fillDate:cand.level.fillDate, exitDate:cand.level.exitDate, size, dollarPL});
        trades.push({ticker:cand.ticker, pickDate:cand.pickDate, evidenceKey:cand.evidenceKey, tier:cand.tier, score:cand.score,
          refClose:cand.refClose, fillDate:cand.level.fillDate, fillPrice:cand.level.fillPrice, exitDate:cand.level.exitDate,
          exitPrice:cand.level.exitPrice, exitWhy:cand.level.exitWhy, plPct:+plPctNet.toFixed(2),
          plPctGross:cand.level.plPct, costPts:+(cand.level.plPct-plPctNet).toFixed(2),
          peakGainPct:cand.level.peakGainPct, heldDays:cand.level.heldDays,
          accountValueAtEntry:+accountValue.toFixed(2), positionSize:+size.toFixed(2), dollarPL:+dollarPL.toFixed(2), openAtFill:openCount});
      }
      open.sort((a,b)=>(a.exitDate<b.exitDate?-1:(a.exitDate>b.exitDate?1:0)));
      for(const pos of open) accountValue+=pos.dollarPL;
      const wins=trades.filter(t=>t.dollarPL>0).length;
      // w483 — the drawdown. A result tells you the destination; the drawdown
      // tells you the ride, and the ride is what makes people abandon a rule
      // three months before it works. Measured on the SETTLED equity curve —
      // the account value after each exit banks — which is the honest series
      // for this sim, since open positions are not marked to market here.
      // Reporting a smoother curve than the one actually lived through would be
      // the most flattering lie available, so it is worth being explicit that
      // this is a floor on the pain, not the whole of it.
      const curve=[];
      { let v=startingCapital;
        const byExit=trades.slice().sort((a,b)=>(a.exitDate<b.exitDate?-1:(a.exitDate>b.exitDate?1:1)));
        for(const t of byExit){ v+=t.dollarPL; curve.push({d:t.exitDate,v:v}); } }
      let peak=startingCapital, maxDD=0, ddPeakV=startingCapital, ddFrom='', ddTo='', curFrom='';
      let longestUnder=0, curUnder=0, uFrom='', uAt='';
      for(const pt of curve){
        if(pt.v>=peak){ peak=pt.v; curFrom=pt.d; curUnder=0; }
        else {
          const dd=((peak-pt.v)/peak)*100;
          curUnder++;
          if(curUnder===1)uAt=pt.d;
          if(dd>maxDD){ maxDD=dd; ddPeakV=peak; ddFrom=curFrom; ddTo=pt.d; }
          if(curUnder>longestUnder){ longestUnder=curUnder; uFrom=uAt; }
        }
      }
      const drawdown={ maxDrawdownPct:+maxDD.toFixed(2),
        fromValue:+ddPeakV.toFixed(2), toValue:+(ddPeakV*(1-maxDD/100)).toFixed(2),
        fromDate:ddFrom||null, toDate:ddTo||null,
        dollarFall:+(ddPeakV*(maxDD/100)).toFixed(2),
        longestLosingRunTrades:longestUnder, losingRunFrom:uFrom||null,
        worstTradePct:trades.length?+Math.min.apply(null,trades.map(t=>t.plPct)).toFixed(2):null,
        settledPoints:curve.length };
      return {accountValue, trades, skipped, wins, drawdown};
    };

    const primary=runAccount(wouldFill);
    const trades=primary.trades, skipped=primary.skipped;
    const accountValue=primary.accountValue, wins=primary.wins;
    const drawdown=primary.drawdown||null;

    const flaggedLarge=[], heldOutLarge=[];
    for(const t of trades){
      const ov=_exitOvershoot(t, targetPct, stopPct);
      if(ov>50)      heldOutLarge.push({ticker:t.ticker, fillDate:t.fillDate, exitDate:t.exitDate, exitWhy:t.exitWhy, plPct:t.plPct, overshoot:ov, dollarPL:t.dollarPL});
      else if(ov>15) flaggedLarge.push({ticker:t.ticker, fillDate:t.fillDate, exitDate:t.exitDate, exitWhy:t.exitWhy, plPct:t.plPct, overshoot:ov, dollarPL:t.dollarPL});
    }
    // w478 — the concentration check. Re-runs the same account with the single
    // biggest DOLLAR winner removed, and again with the top three removed. A
    // setting survives both; one lucky trade does not. Cheap, because only the
    // account walk repeats — no re-simulation, no extra data.
    let concentration=null;
    if(trades.length>3){
      const rank=trades.slice().sort((a,b)=>b.dollarPL-a.dollarPL);
      const keyOf=(t)=>t.ticker+'|'+t.fillDate;
      const drop1=new Set([keyOf(rank[0])]);
      const drop3=new Set(rank.slice(0,3).map(keyOf));
      const cut=(dropSet)=>{
        const alt=runAccount(wouldFill.filter(c=>!dropSet.has(c.ticker+'|'+c.level.fillDate)));
        return { finalAccountValue:+alt.accountValue.toFixed(2),
          totalReturnPct:+(((alt.accountValue/startingCapital)-1)*100).toFixed(2),
          taken:alt.trades.length };
      };
      const topShare=(accountValue-startingCapital)!==0
        ? +((rank[0].dollarPL/(accountValue-startingCapital))*100).toFixed(1) : null;
      concentration={
        biggestWinner:{ ticker:rank[0].ticker, plPct:rank[0].plPct, dollarPL:rank[0].dollarPL,
          shareOfTotalGainPct:topShare },
        withoutTop1:cut(drop1), withoutTop3:cut(drop3) };
    }
    let exHeld=null;
    if(heldOutLarge.length){
      const drop=new Set(heldOutLarge.map(t=>t.ticker+'|'+t.fillDate));
      const alt=runAccount(wouldFill.filter(c=>!drop.has(c.ticker+'|'+c.level.fillDate)));
      exHeld={ finalAccountValue:+alt.accountValue.toFixed(2),
        totalReturnPct:+(((alt.accountValue/startingCapital)-1)*100).toFixed(2),
        taken:alt.trades.length,
        winRate:alt.trades.length>0?+((alt.wins/alt.trades.length)*100).toFixed(1):0 };
    }

    results.push({ band:band.label, bandMin:band.min, bandMax:(band.max===Infinity?null:band.max),
      offered:wouldFill.length, offeredBeforeCorpFilter:wouldFillAll.length,
      skippedForCap:skipped.length, taken:trades.length,
      startingCapital, finalAccountValue:+accountValue.toFixed(2),
      totalReturnPct:+(((accountValue/startingCapital)-1)*100).toFixed(2),
      winRate:trades.length>0?+((wins/trades.length)*100).toFixed(1):0,
      excludedCorpActions:excludedCorp, flaggedLargeMoves:flaggedLarge,
      heldOutLargeMoves:heldOutLarge, exHeldOut:exHeld, concentration:concentration, drawdown:drawdown,
      entryMode:entryMode,
      turnover:(function(){
        let inv=0, grossPts=0, costPts=0, held=0, n=0;
        for(const t of trades){
          const sz=+t.positionSize||0; inv+=sz; n++;
          held+=(+t.heldDays||0);
          grossPts+=(+t.plPctGross!=null? +t.plPctGross : +t.plPct)||0;
          costPts+=(+t.costPts||0);
        }
        const grossDollars = trades.reduce((a,t)=>a+((+t.positionSize||0)*(((+t.plPctGross!=null?+t.plPctGross:+t.plPct)||0)/100)),0);
        const costDollars  = trades.reduce((a,t)=>a+((+t.positionSize||0)*((+t.costPts||0)/100)),0);
        return {
          trades:n,
          dollarsDeployed:+inv.toFixed(2),
          timesCapitalTurnedOver: startingCapital? +(inv/startingCapital).toFixed(2) : 0,
          avgPositionSize: n? +(inv/n).toFixed(2) : 0,
          avgHeldDays: n? +(held/n).toFixed(1) : 0,
          tradesPerYear: n? +(n/((totalWeeks*5)/252)).toFixed(1) : 0,
          avgGrossPtsPerTrade: n? +(grossPts/n).toFixed(2) : 0,
          avgCostPtsPerTrade: n? +(costPts/n).toFixed(2) : 0,
          grossProfitDollars:+grossDollars.toFixed(2),
          costDollars:+costDollars.toFixed(2),
          costShareOfGrossPct: grossDollars>0? +((costDollars/grossDollars)*100).toFixed(1) : null
        };
      })(),
      pullback: PULL.on ? { waitDays:PULL.waitDays, minPct:PULL.minPct, maxPct:PULL.maxPct,
        signalsSeen:pullSeen, filled:pullFilled,
        triggerRatePct: pullSeen? +((pullFilled/pullSeen)*100).toFixed(1) : 0,
        skippedNotFallenEnough:pullShallow, skippedFellTooFar:pullDeep } : null,
      trades, skipped });
  }

  // w473 — report the span of picks ACTUALLY made, not just the window asked
  // for. A run whose window opens in 2023 but whose first pick lands in mid-2025
  // is not a 2.7-year test, and that should be visible on the page rather than
  // something you have to notice by reading 60 trade rows.
  let _pFrom='', _pTo='';
  for(const b of results)for(const t of b.trades){ if(!_pFrom||t.pickDate<_pFrom)_pFrom=t.pickDate; if(!_pTo||t.pickDate>_pTo)_pTo=t.pickDate; }
  return { windowStartDate, windowEndDate,
    gradeDaysUsed:X.days, firstPickDate:_pFrom, lastPickDate:_pTo,
    params:{entryDays,totalWeeks,topN,minScore,buyLevel,targetPct,stopPct,maxPositions,startingCapital,gradeDays,exitMode,trailPct,peakBasis,feePerSide,slipPct},
    excludeNonEquity, universeAfterExclusion:useShares.length,
    bands: results };
}

// w462 — Tony asked us to check which score the whole session has actually
// been filtering on. _cardScore10 (used everywhere above) grades a SIGNAL
// PATTERN's historical record — fired count, edge, tier — not a single
// share's setup today. That IS the "signal report card" score, confirmed
// by reading the function directly rather than assuming. The OTHER /10 in
// the app, the Watch Score (accumulation days + price streak + volume
// streak + today's move — watchScore10 in this same file, ported verbatim
// from the live app), grades one ticker's own pattern on one day, and has
// never been tried as the filter in any test this session. This is the
// exact same compounding test, byte-for-byte identical except for one
// substitution: a ticker still needs SOME qualifying evidence key to be a
// candidate at all (same prerequisite as every other test), but instead of
// ranking/filtering by that signal's historical _cardScore10, this ranks
// and filters by the TICKER'S OWN Watch Score on its pick day, computed via
// the same _scPrep/_scStats pipeline the live app's Watch Score uses.
function _dipLadderCompoundingWatchScore(shares, params){
  const {entryDays=5, totalWeeks=140, topN=4, minScore=7, buyLevel=-5,
    targetPct=15, stopPct=15, maxPositions=8, startingCapital=50000,
    excludeNonEquity=true, liqFloor=250000} = params||{};
  const useShares = excludeNonEquity ? shares.filter(s=>!_NONEQUITY_EXCLUDE.has(s.ticker)) : shares;
  const X=_auditNewCtx(useShares, 5, null, liqFloor);
  _auditRunAll(X);
  const recs=X.recs;
  const EXCLUDE={di:1,'vr-':1,'blk-':1,vr:1,blk:1};
  const shareByTicker={}; for(const s of useShares)shareByTicker[s.ticker]=s;
  const dateIdxCache={}, pfCache={};
  const byDay={};
  for(const rec of recs){
    let hasQualifying=false;
    for(const k of rec.ks){ if(!EXCLUDE[k]){ hasQualifying=true; break; } }
    if(!hasQualifying)continue;
    const sh=shareByTicker[rec.ticker]; if(!sh)continue;
    let di=dateIdxCache[rec.ticker];
    if(!di){ di={}; for(let i=0;i<sh.series.length;i++)di[sh.series[i].d]=i; dateIdxCache[rec.ticker]=di; }
    const idx=di[rec.d]; if(idx==null)continue;
    let pf=pfCache[rec.ticker];
    if(pf===undefined){ try{ pf=_scPrep(sh.series); }catch(e){ pf=null; } pfCache[rec.ticker]=pf; }
    if(!pf)continue;
    let st; try{ st=_scStats(sh.series,pf,idx); }catch(e){ st=null; }
    if(!st)continue;
    const watchScore=st.score;
    if(!(watchScore>=minScore))continue;
    (byDay[rec.d]||(byDay[rec.d]=[])).push({ticker:rec.ticker,key:'watch',tier:'watch',edge:st.acc||0,score:watchScore});
  }
  const allDates=new Set();
  for(const s of useShares)for(const r of s.series)allDates.add(r.d);
  const calendar=[...allDates].sort();
  const nCal=calendar.length;
  const totalDaysCount=totalWeeks*5;
  if(nCal<totalDaysCount+5)return {error:'not enough trading history for a '+totalWeeks+'-week window'};
  const windowStartCalIdx=Math.max(0,nCal-totalDaysCount);
  const windowEndCalIdx=nCal-1;
  const windowStartDate=calendar[windowStartCalIdx];
  const windowEndDate=calendar[windowEndCalIdx];
  const blocks=[];
  for(let i=windowStartCalIdx;i<=windowEndCalIdx;i+=entryDays){
    const blockEnd=Math.min(i+entryDays-1,windowEndCalIdx);
    blocks.push({startIdx:i,endIdx:blockEnd,startDate:calendar[i],endDate:calendar[blockEnd]});
  }

  const seenEver=new Set();
  const simmed=[];
  for(const block of blocks){
    const blockDays=calendar.slice(block.startIdx,block.endIdx+1);
    for(const d of blockDays){
      const picks=(byDay[d]||[]).slice().sort((a,b)=>(b.score-a.score)||(b.edge-a.edge)).slice(0,topN);
      for(const p of picks){
        if(seenEver.has(p.ticker))continue;
        seenEver.add(p.ticker);
        const sh=shareByTicker[p.ticker]; if(!sh)continue;
        const series=sh.series;
        const dateIdx=dateIdxCache[p.ticker];
        const pickIdx=dateIdx[d]; if(pickIdx==null)continue;
        const idxForDate=(targetDate)=>{
          if(dateIdx[targetDate]!=null)return dateIdx[targetDate];
          let lo=0,hi=series.length-1,ans=null;
          while(lo<=hi){ const mid=(lo+hi)>>1; if(series[mid].d<=targetDate){ans=mid;lo=mid+1;} else hi=mid-1; }
          return ans;
        };
        const entryEndIdx=idxForDate(block.endDate);
        const windowEndIdx=idxForDate(windowEndDate);
        if(entryEndIdx==null||windowEndIdx==null||windowEndIdx<=pickIdx)continue;
        const lr=_simulateFixedTargetStop(series,pickIdx,entryEndIdx,windowEndIdx,buyLevel,1,targetPct,stopPct);
        simmed.push({ticker:p.ticker,pickDate:d,evidenceKey:'Watch Score',tier:'watch',edge:p.edge,score:p.score,level:lr});
      }
    }
  }

  const wouldFill=simmed.filter(c=>c.level&&c.level.filled);
  wouldFill.sort((a,b)=>(a.level.fillDate<b.level.fillDate?-1:(a.level.fillDate>b.level.fillDate?1:(b.score-a.score))));

  let accountValue=startingCapital;
  const open=[];
  const trades=[];
  const skipped=[];

  const settleThrough=(cutoffDate)=>{
    for(let i=open.length-1;i>=0;i--){
      if(open[i].exitDate<=cutoffDate){ accountValue+=open[i].dollarPL; open.splice(i,1); }
    }
  };

  for(const cand of wouldFill){
    settleThrough(cand.level.fillDate);
    const openCount=open.length;
    if(openCount>=maxPositions){ skipped.push(Object.assign({},cand,{openAtFill:openCount})); continue; }
    const size=accountValue/maxPositions;
    const dollarPL=size*(cand.level.plPct/100);
    open.push({fillDate:cand.level.fillDate, exitDate:cand.level.exitDate, size, dollarPL});
    trades.push({ticker:cand.ticker, pickDate:cand.pickDate, evidenceKey:cand.evidenceKey, tier:cand.tier, score:cand.score,
      fillDate:cand.level.fillDate, fillPrice:cand.level.fillPrice, exitDate:cand.level.exitDate, exitPrice:cand.level.exitPrice,
      exitWhy:cand.level.exitWhy, plPct:cand.level.plPct, accountValueAtEntry:+accountValue.toFixed(2),
      positionSize:+size.toFixed(2), dollarPL:+dollarPL.toFixed(2), openAtFill:openCount});
  }
  open.sort((a,b)=>(a.exitDate<b.exitDate?-1:(a.exitDate>b.exitDate?1:0)));
  for(const pos of open) accountValue+=pos.dollarPL;

  const wins=trades.filter(t=>t.dollarPL>0).length;
  return { windowStartDate, windowEndDate,
    params:{entryDays,totalWeeks,topN,minScore,buyLevel,targetPct,stopPct,maxPositions,startingCapital},
    excludeNonEquity, universeAfterExclusion:useShares.length,
    offered:wouldFill.length, skippedForCap:skipped.length, taken:trades.length,
    startingCapital, finalAccountValue:+accountValue.toFixed(2),
    totalReturnPct:+(((accountValue/startingCapital)-1)*100).toFixed(2),
    winRate:trades.length>0?+((wins/trades.length)*100).toFixed(1):0,
    trades, skipped };
}

// w460 — Tony asked for a report that runs the NEW evidence rules (15%
// target / 15% stop, -5% dip, score 7+, top 4/day, once-EVER not once per
// backtest) live, every day, with a way to actually queue a buy. This is
// the live-selection counterpart to everything tested above — same
// scoring pipeline (_auditNewCtx/_cardScore10), same score>=7 and
// ETF/hybrid/bond exclusion, but run once per real trading day instead of
// once per backtest, with a persistent table so a ticker already
// suggested is never suggested again (the live version of "once-only
// across the whole window").
//
// Sizing: the existing bridge caps real orders at $500/order — well
// below the $5,000/position used throughout tonight's backtests, which
// was a testing convention, not a real constraint. New picks here are
// sized at $500/position so they fit the caps Tony already set, not the
// backtest's convention.
//
// "Buy" does not place a real trade. It inserts into the SAME
// bridge_queue table the app's own buy flow uses, which the local bridge
// (still in DRY_RUN / per-order-approve mode, per Tony's own go-live
// plan) reads from — so every existing safeguard (dry-run, per-order
// approval, hard caps, the written stop rule) still applies untouched.
const _NEW_RULES_AMOUNT = 500;
const _NEW_RULES_MINSCORE = 7;
const _NEW_RULES_TOPN = 4;
const _NEW_RULES_TARGET_PCT = 15;
const _NEW_RULES_STOP_PCT = 15;
// w521: 5 -> 2. The ten-year dip ladder (13 Aug 2026, real OHLC fills) showed
// returns fall monotonically as the limit deepens: 2% returned +232% where 5%
// returned +89%, and kept +160% vs +26% with the top three trades removed.
// Mechanism: at 5% most signals never fill — the order misses the winners
// rather than filtering the losers (130 offered at 2%, only 84 at 5%).
const _NEW_RULES_DIP_PCT = 2;
// w484 — the price band from the 1 August 2026 evidence session. Split five
// ways, the same rules returned +65.8% on $0.20-$0.99 and went NEGATIVE above
// $5: breakout and accumulation signals need room to move, and large stable
// companies do not provide it. Exits stay 15/15 with the 5% dip, as asked.
const _NEW_RULES_MIN_PRICE = 0.20;
const _NEW_RULES_MAX_PRICE = 0.99;
// w489 — a suggestion that never became an order stops being interesting. After
// this many days it is dropped, which also releases the ticker to be picked
// again under whatever the rules are then.
const _NEW_RULES_STALE_DAYS = 7;   // w542: 7 calendar days = 5 TRADING days (Tony, 19 Aug: '5 days'). A 2%-dip limit priced off a week-old close is not a live recommendation; the self-heal now retires suggested rows at 5 trading days instead of 14. Matches the app's v820 'Still open' divider exactly, so server retirement and app demotion tell one story. QUEUED rows still untouched.
// w491 — ONE place the build number lives. Everything that reports a version
// reads this, so the badge cannot claim a build the code is not.
const _WV = 556; // w556: THE EMAIL SHOWS WHAT'S STANDING, NOT JUST WHAT'S NEW (Tony, 9 Sep: 'why is these different to the email... can this be emailed too?'). The nightly mail was a newspaper - only picks first seen THAT day - while the app's panel is a scoreboard that also shows older picks still live (suggested, inside the 5-trading-day retirement window). Each lane's section now adds '\u267b still standing from earlier days' rows with their pick date, so the email and the panel finally tell the same story: tonight's news on top, the open field beneath. // w555: THE EARLY-TRICKLE GATE (25 Aug, caught by Tony's 4:40pm 'no picks tonight' email). EODHD publishes a handful of bars within minutes of the ASX close - tonight SIX tickers at 17:00 Sydney, the full ~1,900 not until ~18:40. The close chain triggers on MAX(d), so it started the evening on the trickle; and w554's grade-only-tickers-with-a-bar filter made that microscopic universe look COMPLETE, so grading 'finished' in seconds, the lanes scanned 3 movers, stamped an honest-looking empty night, and the mail went out - all before the real data existed. The old 3.5h grade had been accidentally load-bearing: it delayed the lanes past the final ingest every night. The delay is now an explicit GATE: the checklist will not start (or resume) for a day until its ingest stamp reads final/refine OR the day holds >=1500 bars. Plus the grade-warm now treats a cached day whose universe is under 500 as absent and rebuilds it, so a thin early cache can never pin the day. // w554: GRADING SHEDS ITS DEAD WEIGHT (Tony, 25 Aug: 'how long does data take to grade and can this be quicker?'). Measured: ~3.5h/night, walking all 5,161 tickers ever stored while only 1,988 traded on the day - 61% of the walk was delisted/dormant shares that cannot be tonight's picks. (1) The universe is now tickers WITH A BAR ON THE DAY being graded - zero information loss, 2.6x fewer. (2) Per-tick budget 6s -> 20s (~3% of the tick; ~35 D1 subrequests, under the ~50 freeze-week ceiling). Together: grading completes in ~2-3 ticks (~20-30 min), so the picks email lands ~30-40 min after the close data arrives (typically 6-7:30pm Adelaide) instead of 8:30-11pm. The w541 wait valve is untouched - it simply stops being needed on a normal night. // w553: EMAIL SPEAKS THE APP'S LANGUAGE (Tony, 24 Aug: 'full name of signals not abbreviations in email report'). The evidence column translates evidence_key codes into the one-language signal names used everywhere else (bo → 🚀 Breakout, inst → 🏦 Big money?, vr → 🥇 Vol record, ...), joined with ' + '. Unknown codes pass through untouched so a future signal can never blank the note. // w552: NIGHTLY PICKS EMAIL (Tony, 21 Aug: 'can this auto email me every day?'). Once per evening, the moment the bot lane's pick run has stamped for the day, the server mails the full picks table - all three lanes, limit/target-or-trail/stop, qty, order size, evidence (score+edge) - via Resend (RESEND_KEY + PICKS_EMAIL_TO secrets; optional PICKS_EMAIL_FROM once a domain is verified). mail_ASX_<day> is stamped ONLY on a confirmed 2xx send with a bounded 5-try counter - the 14 Aug lesson applied: never record intent as completion. Plus an 'Email me today's picks now' button on /admin/panel (/admin/mailtest) for on-demand sends and delivery testing. w551: TWO CLOSE-EVENING FIXES, SAME NIGHT AS THE AUDIT (20 Aug). (1) THE PANTRY LIST SPEAKS THE APP'S CONTRACT - mapRecord reads lowercase code/close/previous/change (the old provider's OpenAPI shape); the capitalized Symbol/Close rows shipped since w546 mapped to NULL, so every 'accepted' pantry list quietly became ZERO shares and the app fell back to its saved snapshot. Day-change sat blank ('-') because no row ever carried previous or change; both now ride on every row, computed from the prior stored day. (2) DAY-KEYED LIST CACHE - the old path+params key with a 30-minute TTL let a close-evening edge PoP pin devices to YESTERDAY for up to half an hour; the served day (latest_ASX, one 1-row read) is now part of the cache key, so the moment a new close lands every request walks past every stale entry. w550: THE TWO FIXES THE PARALLEL w549 DID NOT CARRY (two sessions minted a w549 on 20 Aug; the pantry-intercept one won the paste - correctly, it is the stronger /eod fix - and this build adds the audit's remaining two on top of it). (1) REFINE STAMPS AFTER SUCCESS - refine_ASX_<day> was stamped BEFORE the re-pull ran, so one dead invocation lost the day forever: 14 Aug sat at eodhd-final:1951 with its refine stamp burned while every neighbour refined to ~2,300. Now the stamp is written only when the re-pull returns ok with rows, with a bounded refineTry_ASX counter (MAX_TRIES) so a dead upstream cannot turn the retry into an every-tick fetch. (2) REPAIR-A-DAY on /admin/panel - a date box + button onto the existing /admin/ingest route, so a day stamped done-while-short can be re-pulled from a phone (built for 14 Aug; permanently useful). w549: THE DEAD PROVIDER'S LAST THREE PATHS NOW ANSWER FROM OUR OWN PANTRY. (1) symbol/list/ASX joins the w546 quote/list intercept — it is the FIRST url every app load tries, and each load was paying a 4-second dead-upstream round-trip (w545 abort) before quote/list rescued it. (2) quote/list/ASX/{ticker}?FromDateStamp&ToDateStamp serves per-ticker history straight from bars — the last per-load path that could still reach the dead domain. (3) technical/list/ASX serves month/year average volumes computed from our own bars (the bulk-volume feature reads symbolCode+monthAvgVolume+yearAvgVolume), cached a day. No app change needed — every device heals at once, including stale-cached ones. Full audit 20 Aug: found alongside a junk Sunday bar (HIQ 2026-08-09, deleted directly in D1) and the 19 Aug short day (1,909 bars, heals via the w523 refine pass tonight). // prior:  // w543: INGEST BREATHES so the app can read. The whole-market upsert ran ~22 D1 batches back-to-back — a solid write burst that made every concurrent app read queue and time out during the 17:00–17:15 and 18:15–18:45 Sydney ingest passes (Tony's screenshot, 19 Aug 17:00:50, 0 of 2,762 loaded). Both bars write loops now pause between chunks (150ms / 120ms): ingest takes ~3s longer, readers get through. This is the pattern the big analytical queries already use. w542: SUGGESTED PICKS RETIRE AT 5 TRADING DAYS. _NEW_RULES_STALE_DAYS 14→7 calendar (= 5 trading) days — Tony's call, 19 Aug, closing the stale-picks issue: AIH/WC8 sat 12+ days at prices from their own day. The heal already ran every close; only the window changes. w541: THE BOT WAS DECIDING ON YESTERDAY'S SIGNALS, EVERY NIGHT. Grading (_scanGradeStep) is cursor-stepped and takes hours; the picks step ran anyway, so every lane fell back to the last FULLY graded session \u2014 the previous day (18 Aug: all three lanes stamped day=2026-08-17 while latestBar was 2026-08-18). Two causes, both fixed: (a) picks now WAIT for st.scanGrades, retrying on later ticks the way the checklist was designed to, and (b) scanGrades joins the all-done early-exit, which previously let grading be abandoned mid-run once the other tasks finished (tonight's stamp carried no scanGrades key at all). A safety valve stops the wait becoming a hang: after _PICK_WAIT_MAX unfinished ticks the lanes run anyway and stamp staleGrades:true, so a stalled grader delays picks but never cancels them, and the reason is on the record. w540: the w539 Trail basis button rendered but did NOTHING on click \u2014 its handler called K() and say(), which exist on /admin/panel; this page names them key() and msg(). A ReferenceError at click time, silent unless a console is open. Fixed, and every failure now reports into the button's own output box rather than relying on a page-level helper at all. w539: /admin/trailbasis FIXED. It loaded the 560-bar pantry (~2.15 years) and then asked for a 400\u2013520 week window, so the backtest correctly refused \u2014 and the route THREW THE REASON AWAY, reporting a bare 'no band result' three times (18 Aug). Now it uses _pantrySeriesOHLCLong (the same deep loader the decade replay uses, ?maxBars up to 2700), reports the underlying error verbatim, states the window it actually got in trading days and calendar dates, and refuses to compare two sides unless BOTH produced trades. Plus a one-tap Trail basis button on the admin panel, so this runs from a phone. w538: PEAK BASIS is now a tested switch. _simulateTrailingStop takes peakBasis 'close' (shipped default) or 'high'; 'high' ratchets on the day's HIGH but, exactly like the close ratchet, the new stop only applies from the NEXT day \u2014 so a stop is never set by a price that may have printed after the low it is judged against. Same intraday trigger either way (gap opens fill at the open, otherwise the low fills at the stop). New /admin/trailbasis runs both bases over the same decade sample and reports them side by side, so the default follows evidence rather than intuition (Tony, 18 Aug: 'it should go off the high'). w537: /annbulk \u2014 ONE request replaces the app's per-ticker announcement sweep. The app was asking /asxann/{code} for up to 25 tickers per load, each falling through corsproxy.io and allorigins when the upstream per-ticker endpoint 502'd \u2014 ~75 doomed requests and up to 5s of timeout each, on EVERY load (Tony's console, 18 Aug). w532 already stores whole-market announcements in our own D1, so this route answers from there: no upstream call, no relay, no per-ticker fan-out. w536: HEAL TOLERANCE FIX \u2014 caught on w534's first live night, by inspection, before it bit. Sizing floors the share count (qty = floor(amount/limit)), so a minimum-amount parcel legitimately lands a few cents UNDER \u00242,000 (tonight's SXL: \u00241,999.83) \u2014 and the relic heal deleted strictly below 2000, which would have eaten the lane's own valid pick on its second night. The heal's job is to kill \u0024500-era relics, not cent-level flooring, so its threshold moves to \u00241,900: no honest minimum-sized parcel can land there (that would need a \u0024100+ share inside a \u00240.20\u2013\u00241.99 band), every old relic still dies. w535: SYNCED ACCOUNTS \u2014 autopilot moves to the server. One account per licence code (or OWNER for the master key), stored in D1: cash, pending limit orders, open positions with ratcheting trails, closed history. The nightly close task steps every autopilot-on account ONCE \u2014 fills pending limits against the day's bar (min(open,limit) when the low reaches it), ratchets and triggers trails on CLOSES with exits at the NEXT OPEN, expires stale orders, then places new orders from that account's OWN rules via the pick engine in dry-run \u2014 so two signed-in devices are two windows on one account and a buy can never happen twice. Fill conventions are byte-for-byte the decade-backtest's proven model; \u00243/side brokerage; \u00242,000 floor inherited. Routes: GET /acct (licence-gated), POST /acct/rules, POST /acct/auto, POST /acct/reset. w534: (b) \u00242,000 MINIMUM PARCEL, every lane. Tony's rule, 18 Aug: never size or judge a pick at toy money \u2014 \u00246 flat brokerage makes sub-\u00242,000 parcels structurally uneconomic (at \u0024500 brokerage alone is 1.2%), so the floor lives in one place in the selector, plus the saved-rules validator and the picks-amount setting. Old sub-\u00242,000 SUGGESTED rows are healed away. (a) THE GATE NOW CHARGES WHAT THE STRATEGY ACTUALLY PAYS. w533's gate demanded every pick beat 2\u00d7 (brokerage + full spread) \u2014 but these lanes enter on a 2% DIP LIMIT (the market comes to the order; no spread is crossed) and exit at the NEXT OPEN's auction (one price; no spread). The decade backtest that proved the presets charged exactly \u00246 round-trip brokerage on those fills. The gate and heal now use that same execution model: friction = \u00246 on the real parcel, per share. The per-share spread is still computed and reported in the stamp as CONTEXT (what a market-order trader would pay on top) \u2014 it informs, it no longer vetoes. Every share judged on its own numbers against the costs it will really incur. w533: THE FRICTION GATE GOES BEHAVIOURAL. Every pick lane now refuses a suggestion whose evidence edge is under 2\u00d7 its estimated round-trip cost \u2014 the exact test the app has PRINTED since v793 (\u00246 brokerage each way on the server-sized parcel + the bigger of one ASX tick and the share's own Corwin\u2013Schultz spread from ~100 days of highs/lows). The panel can no longer recommend a trade its own costs line calls uneconomic. Self-heal also drops old SUGGESTED rows that fail the same test on their stored sizing (the \u002412-day stale \u0024500-parcel relics). Funnel stamps gain frictionFail + frictionHealed. w532: announcement ingest — _annPollMarket reads the ASX official market-wide today's-announcements feed (one fetch, every ticker, price-sensitive flag) as a close task AFTER pick decisions and BEFORE laRebuild; stamps ann_run_ASX; news table gains `sens` (src column already existed). Kills the per-ticker RSS watch-list selection bias for announcement coverage. Additive. w531: GET /brief — server-composed Starter Today brief (breadth + month climate + strongest pick), cached per (exch,day) in meta; additive only. w530: di renamed '📉 Dist?'→'📉 Quiet selling?' (one name app-wide); era-cap direction bug fixed (dirNegSafe was undefined → warnings graded on raw t). w510: pick lanes stamp every run (day seen, funnel, errors) - an empty night is now visible, distinct from a dead cron
// w494 — ASX retail tick sizes. Under 10c the step is a tenth of a cent, from
// 10c to just under $2 it is half a cent, and from $2 up it is a cent. A price
// that is not on a step is not a price anyone can enter, so every limit, target
// and stop is snapped before it is stored.
function _tickSize(px, exch){
  if (String(exch||'ASX').toUpperCase() !== 'ASX') return 0.01;
  if (!(px > 0)) return 0.001;
  if (px < 0.10) return 0.001;
  if (px < 2.00) return 0.005;
  return 0.01;
}
function _tickRound(px, exch){
  const p = +px; if (!isFinite(p) || p <= 0) return 0;
  const t = _tickSize(p, exch);
  return +( Math.round(p / t) * t ).toFixed(4);
}

// w533 — the app's v793 Corwin\u2013Schultz spread estimator, ported verbatim to the
// worker's series shape ({d,o,h,l,c,v}). Same maths as the 16-Aug D1 study and
// the friction line the app prints: last ~100 bars, pairwise over consecutive
// days, negatives floored at 0, averaged; null under 40 clean pairs. Returns a
// FRACTION (0.012 = 1.2%).
function _csSpread(series){
  try{
    if(!Array.isArray(series)||series.length<45)return null;
    const R=series.slice(-100); const k=3-2*Math.SQRT2; let sum=0,n=0;
    for(let i=1;i<R.length;i++){
      const a=R[i-1],b=R[i];
      const h1=+a.h,l1=+a.l,h2=+b.h,l2=+b.l;
      if(!(h1>0&&l1>0&&h2>0&&l2>0&&h1>=l1&&h2>=l2))continue;
      const beta=Math.pow(Math.log(h1/l1),2)+Math.pow(Math.log(h2/l2),2);
      const gamma=Math.pow(Math.log(Math.max(h1,h2)/Math.min(l1,l2)),2);
      const alpha=(Math.sqrt(2*beta)-Math.sqrt(beta))/k - Math.sqrt(gamma/k);
      const sp=2*(Math.exp(alpha)-1)/(1+Math.exp(alpha));
      sum+=Math.max(0,sp); n++;
    }
    return n>=40 ? sum/n : null;
  }catch(e){ return null; }
}
// w533 — round-trip friction, in percent of the parcel, matching the app's
// printed line exactly: $6 brokerage each way on the REAL parcel (qty \u00d7 price),
// plus the crossing cost \u2014 the bigger of one exchange tick and the share's own
// estimated spread. The gate the app has displayed since v793: an edge under
// 2\u00d7 this number is not a trade, it is a donation to the broker.
// $6 is the ROUND TRIP ($3 a side, the product's standing assumption) \u2014 the
// same 6 the app's formula uses, byte-matched so server refusal and app
// verdict can never disagree. (The app's TOOLTIP wrongly says \u00246+\u00246;
// the formula \u2014 and v812's printed \u002452-on-\u00245000 \u2014 use 6. Tooltip fix queued app-side.)
function _frictionPct(px, qty, csFrac, exch){
  const p=+px, q=+qty;
  if(!(p>0&&q>=1))return null;
  const parcel=p*q;
  const tickPct=_tickSize(p, exch)/p*100;
  const csPct=(csFrac!=null&&isFinite(csFrac))?csFrac*100:null;
  const cross=(csPct!=null&&csPct>tickPct)?csPct:tickPct;
  return (6/parcel)*100 + cross;   // $6 round trip ($3/side), identical to the app's line
}
// w534 \u2014 what THIS strategy pays: dip-limit entry (no spread crossed) +
// next-open exit (auction, no spread) = brokerage only, \u00243 a side, on the
// exact parcel. This is the identical cost model the decade backtest proved
// the presets under (+248% net of it). _frictionPct above stays as the
// MARKET-ORDER model \u2014 the right number to show a human tapping 'buy at
// market', and the context figure the stamp reports \u2014 but the gate charges
// a strategy only for the road it actually drives.
function _frictionPctExec(px, qty){
  const p=+px, q=+qty;
  if(!(p>0&&q>=1))return null;
  return (6/(p*q))*100;
}
function _frictionOk(edge, fr){
  if(fr==null)return true;                        // can't measure \u2192 don't invent a verdict
  if(edge==null||!isFinite(+edge))return true;    // no edge on record \u2192 the app prints no verdict either
  return +edge >= 2*fr;
}

// \u2550\u2550\u2550 w535 \u2014 SYNCED ACCOUNTS \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// One paper account per licence code, living in D1, stepped ONCE nightly by the
// close task. Two signed-in devices are two windows on the same rows \u2014 the
// double-autobuy hazard cannot exist because no device executes anything.
// Fill model = the decade backtest's, exactly: dip-limit buys fill at
// min(open, limit) on the first day the LOW reaches the limit; trailing stops
// ratchet on CLOSES, trigger on CLOSES, and the exit itself fills at the NEXT
// day's OPEN; a position is never judged on its own entry day; \u00243 a side.
const _ACCT = {
  START_CASH: 10000,          // fresh account's practice cash
  ORDER_DAYS: 5,              // a limit order waits this many trading days, then expires
  MAX_OPEN: 20,               // decade-backtest ceiling, all presets
  FEE: 3,                     // dollars, each side
};
async function _acctEnsure(env){
  if (_acctEnsure._done) return true;
  try{
    await env.MARKET_DB.prepare('CREATE TABLE IF NOT EXISTS acct_state (cust TEXT PRIMARY KEY, cash REAL NOT NULL, start_cash REAL NOT NULL, auto INTEGER DEFAULT 0, rules TEXT, stepped_day TEXT, created TEXT, updated TEXT)').run();
    await env.MARKET_DB.prepare('CREATE TABLE IF NOT EXISTS acct_pos (id INTEGER PRIMARY KEY AUTOINCREMENT, cust TEXT NOT NULL, exch TEXT NOT NULL, ticker TEXT NOT NULL, status TEXT NOT NULL, qty INTEGER, limit_px REAL, placed_d TEXT, expiry_d TEXT, buy_px REAL, buy_d TEXT, hi REAL, trail_pct REAL, stop_px REAL, target_px REAL, sell_px REAL, sell_d TEXT, reason TEXT, key TEXT, score REAL, created TEXT, updated TEXT)').run();
    await env.MARKET_DB.prepare('CREATE INDEX IF NOT EXISTS idx_acct_pos_cust ON acct_pos (cust, status)').run();
    _acctEnsure._done = true; return true;
  }catch(e){ return false; }
}
// The account identity behind a request: the trial code that unlocked it, or
// OWNER for the master password. gateStatus has already vouched for the caller.
function _acctCust(g, request){
  if (g && g.trial) return String(request.headers.get('X-Insight-Access')||'').trim().toUpperCase().slice(0,40);
  return 'OWNER';
}
async function _acctGet(env, cust){
  await _acctEnsure(env);
  let st = await env.MARKET_DB.prepare('SELECT * FROM acct_state WHERE cust=?').bind(cust).first();
  if (!st){
    const now = new Date().toISOString();
    await env.MARKET_DB.prepare('INSERT INTO acct_state (cust,cash,start_cash,auto,created,updated) VALUES (?,?,?,0,?,?) ON CONFLICT(cust) DO NOTHING')
      .bind(cust, _ACCT.START_CASH, _ACCT.START_CASH, now, now).run();
    st = await env.MARKET_DB.prepare('SELECT * FROM acct_state WHERE cust=?').bind(cust).first();
  }
  return st;
}
// One account, one trading day. Idempotent per (cust, day) via stepped_day.
// Order inside the day mirrors the backtest: exits are decided on YESTERDAY'S
// close and fill at TODAY'S open, so they run before today's closes are looked
// at; then pending buys try to fill on today's bar; then trails ratchet and
// today's triggers arm exits for TOMORROW's open; finally new orders go in.
async function _acctStepOne(env, cust, exch, day, bars, dryPick){
  const st = await _acctGet(env, cust);
  if (!st || st.stepped_day === day) return { cust, skipped: true };
  const now = new Date().toISOString();
  let cash = +st.cash;
  const out = { cust, day, exits: 0, fills: 0, expired: 0, placed: 0 };
  const P = await env.MARKET_DB.prepare("SELECT * FROM acct_pos WHERE cust=? AND status IN ('open','pending','closing')").bind(cust).all();
  const pos = (P && P.results) || [];
  const bar = t => bars[t];   // today's OHLC by ticker (only tickers this account touches)
  // 1. positions armed yesterday exit at TODAY's open
  for (const p of pos){
    if (p.status !== 'closing') continue;
    const b = bar(p.ticker);
    const px = b && b.o > 0 ? b.o : p.stop_px;          // no bar today (halt): fill at the armed stop, honestly noted
    const proceeds = px * p.qty - _ACCT.FEE;
    cash += proceeds;
    await env.MARKET_DB.prepare("UPDATE acct_pos SET status='closed', sell_px=?, sell_d=?, reason=COALESCE(reason,'trail'), updated=? WHERE id=?")
      .bind(px, day, now, p.id).run();
    out.exits++;
  }
  // 2. pending limit orders against today's bar
  for (const p of pos){
    if (p.status !== 'pending') continue;
    const b = bar(p.ticker);
    if (b && b.l > 0 && b.l <= p.limit_px){
      const fillPx = Math.min(b.o > 0 ? b.o : p.limit_px, p.limit_px);
      const cost = fillPx * p.qty + _ACCT.FEE;
      if (cost <= cash){
        cash -= cost;
        await env.MARKET_DB.prepare("UPDATE acct_pos SET status='open', buy_px=?, buy_d=?, hi=?, updated=? WHERE id=?")
          .bind(fillPx, day, (b.c>0?b.c:fillPx), now, p.id).run();
        out.fills++;
        p.status='open'; p.buy_d=day; p.buy_px=fillPx; p.hi=(b.c>0?b.c:fillPx);
        continue;
      }
    }
    if (p.expiry_d && day >= p.expiry_d){
      await env.MARKET_DB.prepare("UPDATE acct_pos SET status='expired', updated=? WHERE id=?").bind(now, p.id).run();
      out.expired++;
    }
  }
  // 3. trails ratchet on today's close; a trigger arms an exit for TOMORROW's open
  for (const p of pos){
    if (p.status !== 'open') continue;
    if (p.buy_d === day) continue;                       // never judged on its own entry day
    const b = bar(p.ticker); if (!b || !(b.c > 0)) continue;
    let hi = Math.max(+p.hi || 0, b.c);
    let stop = p.trail_pct > 0 ? hi * (1 - p.trail_pct/100) : +p.stop_px || 0;
    if (p.trail_pct > 0 && +p.stop_px > 0) stop = Math.max(stop, +p.stop_px);   // a fixed floor never loosens
    let trigger = null;
    if (p.target_px > 0 && b.c >= p.target_px) trigger = 'target';
    else if (stop > 0 && b.c <= stop) trigger = (p.trail_pct > 0 ? 'trail' : 'stop');
    if (trigger){
      await env.MARKET_DB.prepare("UPDATE acct_pos SET status='closing', hi=?, stop_px=?, reason=?, updated=? WHERE id=?")
        .bind(hi, stop, trigger, now, p.id).run();
    } else if (hi !== +p.hi || stop !== +p.stop_px){
      await env.MARKET_DB.prepare('UPDATE acct_pos SET hi=?, stop_px=?, updated=? WHERE id=?').bind(hi, stop, now, p.id).run();
    }
  }
  // 4. new orders from this account's OWN rules (dryPick supplies today's sized
  //    candidates from the SAME engine the owner's lane uses)
  const openN = pos.filter(p => p.status === 'open' || p.status === 'closing').length;
  const pendN = pos.filter(p => p.status === 'pending').length;
  const held = new Set(pos.filter(p => p.status !== 'expired' && p.status !== 'closed').map(p => p.ticker));
  if (st.auto && dryPick && Array.isArray(dryPick.rows)){
    for (const r of dryPick.rows){
      if (openN + pendN + out.placed >= _ACCT.MAX_OPEN) break;
      if (held.has(r.ticker)) continue;
      const cost = r.limitPrice * r.qty + _ACCT.FEE;
      if (cost > cash) continue;                          // sized to rules; an account low on cash simply sits out
      const expiry = _acctAddTradingDays(day, _ACCT.ORDER_DAYS);
      await env.MARKET_DB.prepare('INSERT INTO acct_pos (cust,exch,ticker,status,qty,limit_px,placed_d,expiry_d,trail_pct,stop_px,target_px,key,score,created,updated) VALUES (?,?,?,\'pending\',?,?,?,?,?,?,?,?,?,?,?)')
        .bind(cust, exch, r.ticker, r.qty, r.limitPrice, day, expiry, (r.trailPct||0), (r.stopPrice||0), (r.targetPrice||0), r.key, r.score, now, now).run();
      held.add(r.ticker); out.placed++;
    }
  }
  await env.MARKET_DB.prepare('UPDATE acct_state SET cash=?, stepped_day=?, updated=? WHERE cust=?').bind(cash, day, now, cust).run();
  return out;
}
function _acctAddTradingDays(day, n){
  const d = new Date(day + 'T00:00:00Z'); let left = n;
  while (left > 0){ d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) left--; }
  return d.toISOString().slice(0, 10);
}
// The nightly step for every autopilot-on account, called from the close task.
// Per-account rules mean per-account dry runs; shares are re-used via one bars
// lookup per unique ticker so the cost stays modest at small account counts.
async function _acctStepAll(env, exch, day){
  await _acctEnsure(env);
  const A = await env.MARKET_DB.prepare('SELECT cust, auto, rules FROM acct_state').all();
  const accts = (A && A.results) || [];
  const summary = { day, accounts: accts.length, stepped: 0, exits: 0, fills: 0, placed: 0, errors: 0 };
  for (const a of accts){
    try{
      // today's bars for every ticker this account holds or waits on
      const T = await env.MARKET_DB.prepare("SELECT DISTINCT ticker FROM acct_pos WHERE cust=? AND status IN ('open','pending','closing')").bind(a.cust).all();
      const ticks = ((T && T.results) || []).map(r => r.ticker);
      const bars = {};
      for (let i = 0; i < ticks.length; i += 50){
        const chunk = ticks.slice(i, i + 50);
        const rs = await env.MARKET_DB.prepare('SELECT ticker,o,h,l,c FROM bars WHERE exch=? AND d=? AND ticker IN (' + chunk.map(()=>'?').join(',') + ')').bind(exch, day, ...chunk).all();
        for (const b of ((rs && rs.results) || [])) bars[b.ticker] = b;
      }
      let dry = null;
      if (a.auto){
        let RB = null; try{ const v = _botRulesSanitize(JSON.parse(a.rules||'')); if (v && v.ok) RB = v.rules; }catch(e){}
        if (RB) dry = await _newRulesDailyPick(env, exch, 'mine', RB, { dry: true });
      }
      const r = await _acctStepOne(env, a.cust, exch, day, bars, dry);
      if (!r.skipped){ summary.stepped++; summary.exits += r.exits||0; summary.fills += r.fills||0; summary.placed += r.placed||0; }
    }catch(e){ summary.errors++; }
  }
  try{ await _setMeta(env, 'acct_run_' + exch, JSON.stringify({ ...summary, at: new Date().toISOString() })); }catch(e){}
  return summary;
}

// w495 — the TRAILING rule set, run daily alongside the 15/15 control.
// Deliberately a separate table with the same shape: the two reports must pick
// from the same signals on the same band with the same entry, differing ONLY in
// how they exit. Sharing a table would let the once-per-ticker dedup of one rule
// set silently starve the other, which would quietly destroy the comparison.
const _TRAIL_RULES_TRAIL_PCT = 20;
async function _trailRulesEnsureTable(env){
  await env.MARKET_DB.prepare(
    'CREATE TABLE IF NOT EXISTS trail_rules_picks (exch TEXT NOT NULL, ticker TEXT NOT NULL, first_seen_day TEXT NOT NULL, ' +
    'evidence_key TEXT, score REAL, tier TEXT, edge REAL, ref_close REAL, limit_price REAL, trail_pct REAL, initial_stop REAL, ' +
    'qty INTEGER, status TEXT NOT NULL DEFAULT \'suggested\', queued_order_id TEXT, created TEXT NOT NULL, PRIMARY KEY (exch,ticker))'
  ).run();
}

async function _newRulesEnsureTable(env){
  await env.MARKET_DB.prepare(
    'CREATE TABLE IF NOT EXISTS new_rules_picks (exch TEXT NOT NULL, ticker TEXT NOT NULL, first_seen_day TEXT NOT NULL, ' +
    'evidence_key TEXT, score REAL, tier TEXT, edge REAL, ref_close REAL, limit_price REAL, target_price REAL, stop_price REAL, ' +
    'qty INTEGER, status TEXT NOT NULL DEFAULT \'suggested\', queued_order_id TEXT, created TEXT NOT NULL, PRIMARY KEY (exch,ticker))'
  ).run();
}

// ═══ w505 — THE SAVED-RULES LANE ═══════════════════════════════════════════
// The two picks tables above are forward comparison CONTROLS and stay exactly
// as they are. This lane runs Tony's own saved rules (posted by the app on
// Save) through the SAME proven selector, into its OWN table - so a preset or
// a manual set decided in the app is decided on the server every night too,
// whether or not the app is ever opened that day. Practice semantics only.
async function _botRulesEnsureTable(env){
  await env.MARKET_DB.prepare(
    'CREATE TABLE IF NOT EXISTS bot_rules_picks (exch TEXT NOT NULL, ticker TEXT NOT NULL, first_seen_day TEXT NOT NULL, ' +
    'evidence_key TEXT, score REAL, tier TEXT, edge REAL, ref_close REAL, limit_price REAL, target_price REAL, stop_price REAL, ' +
    'trail_pct REAL, qty INTEGER, status TEXT NOT NULL DEFAULT \'suggested\', queued_order_id TEXT, created TEXT NOT NULL, PRIMARY KEY (exch,ticker))'
  ).run();
}
// Every number hard-bounded: the worst a leaked access key can do is set
// silly-but-safe rules. Mode coherence enforced per the v494 lesson - exits
// must never collapse onto the entry.
function _botRulesSanitize(b){
  if (!b || typeof b !== 'object') return { ok:false, error:'no rules given' };
  const num=(v,lo,hi)=>{ const x=+v; return (isFinite(x)&&x>=lo&&x<=hi)?x:null; };
  const trailPct=num(b.trailPct==null?0:b.trailPct,0,50), targetPct=num(b.targetPct==null?0:b.targetPct,0,100), stopPct=num(b.stopPct==null?0:b.stopPct,0,50);
  const dipPct=num(b.dipPct,0,15), minScore=num(b.minScore,0,10), topN=num(b.topN,1,6);
  const minPrice=num(b.minPrice,0.01,10), maxPrice=num(b.maxPrice,0.02,50), amount=num(b.amount,2000,5000);   // w534b: \u00242,000 floor \u2014 \u00246 brokerage makes smaller parcels uneconomic by construction
  if (trailPct==null||targetPct==null||stopPct==null) return { ok:false, error:'trail 0-50, target 0-100, stop 0-50' };
  if (minPrice==null||maxPrice==null||!(maxPrice>minPrice)) return { ok:false, error:'price band must sit inside $0.01-$50 with max above min' };
  if (dipPct==null) return { ok:false, error:'dip entry must be 0-15%' };
  if (minScore==null||topN==null||amount==null) return { ok:false, error:'score 0-10, top-N 1-6, amount $2,000-$5,000 (below $2,000 the flat $6 brokerage eats the edge)' };
  if (targetPct>0){
    if (!(stopPct>0)) return { ok:false, error:'a fixed set needs a stop above 0 alongside its take-profit' };
    return { ok:true, rules:{ mode:'fixed', trailPct:0, targetPct, stopPct, dipPct, minScore, topN, minPrice, maxPrice, amount } };
  }
  if (!(trailPct>=5)) return { ok:false, error:'a trailing-only set (target 0) needs a trail of at least 5%' };
  return { ok:true, rules:{ mode:'trail', trailPct, targetPct:0, stopPct:0, dipPct, minScore, topN, minPrice, maxPrice, amount } };
}
async function _botRulesGet(env){
  try{
    const m = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind('bot_rules').first();
    if (!m || !m.v) return null;
    const v = _botRulesSanitize(JSON.parse(m.v));
    return v.ok ? v.rules : null;
  }catch(e){ return null; }
}

// w510 — THE INVISIBLE-NIGHT FIX. On 2026-08-07 all three lanes ran and chose
// nothing; the app's freshness banner then warned "these are not today's" as if
// the cron had died, because an empty run and a crashed run left identical
// evidence: none. Every lane run now writes a stamp — the day it decided, the
// newest bar it saw, the funnel counts, and any error — so /picks can tell the
// app which of the three stories actually happened. The stamp is written even
// when the lane throws: a lane that cannot say "I failed" is a lane that
// cannot be trusted to have succeeded.
async function _pickLaneRun(env, exch, mode, RB, staleGrades){
  const lane = RB ? 'mine' : (mode === 'trail' ? 'trail' : 'fixed');
  let out = null, err = null;
  try { out = await _newRulesDailyPick(env, exch, mode, RB); }
  catch (e) { err = String((e && e.message) || e).slice(0, 200); }
  try {
    const stamp = { at: new Date().toISOString(), error: err };
    if (out) {
      stamp.ok = !!out.ok;
      stamp.day = out.day || null;            // the session the lane decided on
      stamp.latestBar = out.latestBar || null; // the newest bar the lane SAW
      stamp.reason = out.reason || null;       // ok:false explanation, if any
      stamp.scanned = out.scanned; stamp.inBand = out.inBand;
      stamp.qualifying = out.qualifyingToday; stamp.suggested = out.suggested;
      stamp.inserted = out.inserted;
      stamp.frictionFail = out.frictionFail; stamp.frictionHealed = out.frictionHealed;   // w533
      if (staleGrades) stamp.staleGrades = true;   // w541: decided before grading finished \u2014 on the record, not hidden
      if (out.frictionDropped && out.frictionDropped.length) stamp.frictionDropped = out.frictionDropped;
    }
    await env.MARKET_DB.prepare('INSERT INTO meta (k,v,updated) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated=excluded.updated')
      .bind('picks_run_' + lane + '_' + exch, JSON.stringify(stamp), new Date().toISOString()).run();
  } catch (e) {}
  return out;
}
// w525 · the evidence lanes' per-order amount. Bounded to the same $100-$5000
// range the saved-rules validator already enforces, so no lane can be given a
// parcel the rest of the system would reject. The bridge's own hard caps
// (CAP_MAX_PER_ORDER etc.) still sit downstream and are NOT touched from here:
// a setting may propose, only the box owner's .env may permit.
async function _picksAmount(env, exch){
  try{
    const r = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind('picks_amount_' + (exch||'ASX')).first();
    const v = r && +r.v;
    return (isFinite(v) && v >= 2000 && v <= 5000) ? Math.round(v) : null;   // w534b: \u00242,000 floor; an old smaller setting falls back to the built-in \u00245,000
  }catch(e){ return null; }
}
async function _newRulesDailyPick(env, exch, mode, RB, OPT){
  const DRY = !!(OPT && OPT.dry);   // w535: compute-and-return only \u2014 no heal, no insert; synced accounts pick with the SAME engine, then size and place orders themselves
  // w495 — mode 'fixed' (default) writes the 15/15 control; mode 'trail' writes
  // the 20% trailing set. Everything before the exit calculation is shared, on
  // purpose: identical signals, band, entry and ranking.
  const TRAIL = RB ? (RB.mode === 'trail') : (mode === 'trail');
  if (RB) await _botRulesEnsureTable(env); else if (TRAIL) await _trailRulesEnsureTable(env); else await _newRulesEnsureTable(env);
  // w505 - the saved-rules blob drives every number when given; the two
  // control lanes keep their built-in constants untouched.
  // w525: the two evidence lanes' parcel size is now a setting, not a constant.
  // Stored server-side in meta as picks_amount_ASX so a phone can change it and
  // the nightly cron sees the same number. The constant remains the fallback,
  // so a wiped setting degrades to the old behaviour rather than to zero.
  const _amt = RB ? null : await _picksAmount(env, exch);
  const C = RB || { amount:(_amt || _NEW_RULES_AMOUNT), minScore:_NEW_RULES_MINSCORE, topN:_NEW_RULES_TOPN,
    targetPct:_NEW_RULES_TARGET_PCT, stopPct:_NEW_RULES_STOP_PCT, dipPct:_NEW_RULES_DIP_PCT,
    minPrice:_NEW_RULES_MIN_PRICE, maxPrice:_NEW_RULES_MAX_PRICE, trailPct:_TRAIL_RULES_TRAIL_PCT };
  // w534b \u2014 THE FLOOR. \u00242,000 minimum parcel for every lane, whatever any
  // stored setting or old blob says. \u00246 flat brokerage means small parcels are
  // uneconomic by construction \u2014 a \u0024500 parcel pays 1.2% in brokerage alone and
  // can never honestly clear the 2\u00d7 gate. Floored here, once, so no lane and no
  // legacy blob can ever size below it again.
  const _AMT_FLOOR = 2000;
  if (!(C.amount >= _AMT_FLOOR)) C.amount = _AMT_FLOOR;
  const TBL = RB ? 'bot_rules_picks' : (TRAIL ? 'trail_rules_picks' : 'new_rules_picks');
  const liqFloor = 250000;
  const pan = await _pantrySeriesOHLC(env, exch, liqFloor);
  if (!pan || !pan.shares || !pan.shares.length) return { ok:false, reason:'no stored history for this exchange yet' };
  const useShares = pan.shares.filter(s => !_NONEQUITY_EXCLUDE.has(s.ticker));

  const X = _auditNewCtx(useShares, 5, null, liqFloor);
  X.tailScan = true;              // w484: also record what fired on the newest bars
  _auditRunAll(X);
  const A = _auditFinalize(X);
  const M = A.M;
  const EXCLUDE = { di:1, 'vr-':1, 'blk-':1, vr:1, blk:1 };

  // w460 fix: the audit engine needs forward-looking days to confirm a
  // signal, so it never emits a rec for the last ~7 trading days of any
  // series — invisible in every backtest tonight (they spanned months),
  // but fatal here, since looking for recs on the literal latest price
  // date would always find none. "Today" for this function is the latest
  // date the engine has actually confirmed a signal for, which naturally
  // advances by one trading day on each daily run.
  // w484 — THE STALE-DATE FIX. This used to take the newest date in X.recs, and
  // the grading loop stops HOLD+2 bars short of the end because it measures each
  // firing's forward outcome. So "today" was always about seven trading days
  // behind the real latest session — a report dated 22 July on 31 July, with a
  // limit price derived from a close a week and a half old. X.today now carries
  // the firings on the newest bars, so the pick is made on the latest session
  // the store actually holds. The SCORES still come from the graded history, so
  // nothing ungraded is ever trusted — only the firing is fresh.
  let latestBar = null;
  for (const s2 of useShares) { const sr = s2.series; if (sr && sr.length) { const d = sr[sr.length-1].d; if (!latestBar || d > latestBar) latestBar = d; } }
  const todayList = (X.today && X.today.length) ? X.today : X.recs;
  let today = null;
  for (const r of todayList) if (!today || r.d > today) today = r.d;
  if (!today) return { ok:false, reason:'no signals on the newest sessions yet' };

  // w489 — SELF-HEALING. The table dedups once-per-ticker-ever, so a row written
  // under older rules blocks that ticker forever AND keeps showing a price the
  // current rules would never pick. Every run now drops SUGGESTED rows that fall
  // outside the live band, or that are older than the stale limit and never went
  // anywhere. QUEUED rows are still never touched automatically — those record a
  // real push to the bridge, and only the explicit button may remove them.
  let healed = 0;
  if (DRY) { /* w535: an account's dry run must never touch the owner's lane tables */ } else
  try {
    const cut = new Date(Date.now() - _NEW_RULES_STALE_DAYS*86400000).toISOString().slice(0,10);
    const hr = await env.MARKET_DB.prepare(
      "DELETE FROM " + TBL + " WHERE exch=? AND status='suggested' AND (ref_close<=? OR ref_close>? OR first_seen_day<?)"
    ).bind(exch, C.minPrice, C.maxPrice, cut).run();
    healed = (hr && hr.meta && hr.meta.changes) || 0;
  } catch(e) {}
  // w533 — the friction heal. Old SUGGESTED rows carry their sizing (qty \u00d7
  // limit_price) from the rules of the night they were written; a row sized off
  // a \u0024500 blob pays 2.4% in brokerage alone and fails the app's own printed
  // test forever. Judge every suggested row by TODAY'S maths on ITS stored
  // numbers and delete the ones that fail \u2014 suggested only, never queued: a
  // queued row records a real push to the bridge and only the button may
  // remove it. Rows with no edge on record are left alone (the app prints no
  // verdict for them, so the server invents none).
  let frictionHealed = 0;
  if (!DRY) try {
    const sug = await env.MARKET_DB.prepare('SELECT ticker, qty, limit_price, edge FROM ' + TBL + " WHERE exch=? AND status='suggested'").bind(exch).all();
    const bad = [];
    for (const r of ((sug && sug.results) || [])) {
      const parcel = (+r.limit_price || 0) * (+r.qty || 0);
      if (parcel > 0 && parcel < 1900) { bad.push(r.ticker); continue; }   // w536: kill \u0024500-era relics, not cent-level flooring \u2014 qty=floor(amount/limit) legitimately lands a hair under \u00242,000
      const fr = _frictionPctExec(r.limit_price, r.qty);   // w534: judged on the costs the strategy really pays
      if (!_frictionOk(r.edge, fr)) bad.push(r.ticker);
    }
    for (const tk of bad) {
      const dr = await env.MARKET_DB.prepare('DELETE FROM ' + TBL + " WHERE exch=? AND ticker=? AND status='suggested'").bind(exch, tk).run();
      frictionHealed += (dr && dr.meta && dr.meta.changes) || 0;
    }
  } catch(e) {}

  let already;
  try {
    const rs = await env.MARKET_DB.prepare('SELECT ticker FROM ' + TBL + ' WHERE exch=?').bind(exch).all();
    already = new Set((rs.results||[]).map(r=>r.ticker));
  } catch(e) { already = new Set(); }

  const todaysRecs = todayList.filter(r => r.d === today);
  // w493 — the share index and the close-on-the-day are needed DURING scoring
  // now, because the price band filters the pool rather than the winners.
  const shareByTicker = {}; for (const s2 of useShares) shareByTicker[s2.ticker] = s2;
  const closeOnDay = (tk) => {
    const sh = shareByTicker[tk]; if (!sh || !sh.series) return 0;
    for (let i = sh.series.length - 1; i >= 0; i--) {
      if (sh.series[i].d === today) return sh.series[i].c || 0;
      if (sh.series[i].d < today) return 0;
    }
    return 0;
  };
  const scored = [];
  let inBand = 0, outOfBand = 0, frictionFail = 0;
  const frictionDropped = [], frictionCtx = [];
  for (const rec of todaysRecs) {
    if (already.has(rec.ticker)) continue;
    const rc = closeOnDay(rec.ticker);
    if (!(rc > C.minPrice && rc <= C.maxPrice)) { outOfBand++; continue; }
    inBand++;
    let best = null;
    for (const k of rec.ks) {
      if (EXCLUDE[k]) continue;
      const m = M[k]; if (!m) continue;
      const sc = _cardScore10(m);
      if (sc < C.minScore) continue;
      if (!best || sc > best.score || (sc===best.score && m.edge>best.edge)) best = { key:k, tier:m.tier, edge:m.edge, score:sc };
    }
    if (best) scored.push({ ticker: rec.ticker, key:best.key, tier:best.tier, edge:best.edge, score:best.score });
  }
  scored.sort((a,b) => (b.score-a.score) || (b.edge-a.edge));
  const top = scored.slice(0, C.topN);

  const now = new Date().toISOString();
  let inserted = 0;
  const rows = [];
  for (const c of top) {
    const sh = shareByTicker[c.ticker]; if (!sh) continue;
    let onDay = null;
    for (let i = sh.series.length - 1; i >= 0; i--) { if (sh.series[i].d === today) { onDay = sh.series[i]; break; } if (sh.series[i].d < today) break; }
    if (!onDay || !(onDay.c > 0)) continue;
    const refClose = onDay.c;
    // w493 — the band already filtered the pool; this is now a belt-and-braces
    // assertion, not the gate. If it ever fires, the pool filter has regressed.
    if (!(refClose > C.minPrice && refClose <= C.maxPrice)) continue;
    const limitPrice = _tickRound(refClose * (1 - C.dipPct/100), exch);
    // w495 — the only place the two rule sets diverge.
    // The trailing set has NO take-profit. Its stop is the INITIAL trail level,
    // 20% under the fill, and it only ever ratchets up from there — so the number
    // printed is a starting point, not a fixed line, and the report says so.
    const targetPrice = TRAIL ? null : _tickRound(limitPrice * (1 + C.targetPct/100), exch);
    const stopPrice = TRAIL
      ? _tickRound(limitPrice * (1 - C.trailPct/100), exch)
      : _tickRound(limitPrice * (1 - C.stopPct/100), exch);
    if (!(limitPrice > 0)) continue;
    if (!TRAIL && !(targetPrice > limitPrice)) continue; // v494 lesson: never ship an order whose exits collapse onto the entry
    if (!(stopPrice > 0 && stopPrice < limitPrice)) continue;
    const qty = Math.floor(C.amount / limitPrice);
    if (qty < 1) continue;
    // w533 — THE FRICTION GATE. The same two numbers the app compares on every
    // card, compared here BEFORE the suggestion exists: what the round trip
    // costs at this exact sizing vs what the signal has averaged. Under 2\u00d7 and
    // the pick is refused and counted, never shown.
    { const _fr = _frictionPctExec(limitPrice, qty);   // w534: the costs THIS strategy pays \u2014 limit in, open out, \u00246 all up
      if (!_frictionOk(c.edge, _fr)) { frictionFail++; frictionDropped.push({ t: c.ticker, edge: +(+c.edge).toFixed(2), needs: +(2*_fr).toFixed(2) }); continue; }
      const _cs = shareByTicker[c.ticker] ? _csSpread(shareByTicker[c.ticker].series) : null;   // context only: what a MARKET order would add
      if (_cs != null) frictionCtx.push({ t: c.ticker, mktAddsPct: +(_cs*100).toFixed(2) }); }
    rows.push({ exch, ticker:c.ticker, day:today, key:c.key, score:c.score, tier:c.tier, edge:c.edge, refClose, limitPrice, targetPrice, stopPrice, qty });
  }
  if (!DRY) for (const r of rows) {
    try {
      const res = RB
        ? await env.MARKET_DB.prepare(
            'INSERT INTO bot_rules_picks (exch,ticker,first_seen_day,evidence_key,score,tier,edge,ref_close,limit_price,target_price,stop_price,trail_pct,qty,status,created) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,\'suggested\',?) ON CONFLICT(exch,ticker) DO NOTHING'
          ).bind(r.exch, r.ticker, r.day, r.key, r.score, r.tier, r.edge, r.refClose, r.limitPrice, (TRAIL?null:r.targetPrice), r.stopPrice, (TRAIL?C.trailPct:null), r.qty, now).run()
        : TRAIL
        ? await env.MARKET_DB.prepare(
            'INSERT INTO trail_rules_picks (exch,ticker,first_seen_day,evidence_key,score,tier,edge,ref_close,limit_price,trail_pct,initial_stop,qty,status,created) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,\'suggested\',?) ON CONFLICT(exch,ticker) DO NOTHING'
          ).bind(r.exch, r.ticker, r.day, r.key, r.score, r.tier, r.edge, r.refClose, r.limitPrice, _TRAIL_RULES_TRAIL_PCT, r.stopPrice, r.qty, now).run()
        : await env.MARKET_DB.prepare(
            'INSERT INTO new_rules_picks (exch,ticker,first_seen_day,evidence_key,score,tier,edge,ref_close,limit_price,target_price,stop_price,qty,status,created) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,\'suggested\',?) ON CONFLICT(exch,ticker) DO NOTHING'
          ).bind(r.exch, r.ticker, r.day, r.key, r.score, r.tier, r.edge, r.refClose, r.limitPrice, r.targetPrice, r.stopPrice, r.qty, now).run();
      if (res && res.meta && res.meta.changes) inserted++;
    } catch(e) {}
  }
  return { ok:true, mode: (RB?'mine':(TRAIL?'trail':'fixed')), exitStyle:(TRAIL?'trail':'fixed'), rulesFrom:(RB?'saved-rules':'built-in'), day:today, latestBar, stale: (latestBar && today < latestBar), healed, minScore: C.minScore, topN: C.topN,
    band: C.minPrice + '-' + C.maxPrice,
    scanned: todaysRecs.length, inBand, outOfBand, qualifyingToday: scored.length, suggested: rows.length, inserted,
    rows: (DRY ? rows : undefined),   // w535: dry-run callers receive the sized candidates directly
    frictionFail, frictionDropped: frictionDropped.slice(0, 8), frictionCtx: frictionCtx.slice(0, 8), frictionHealed };
}

// w446 — Tony asked what the evidence itself points to for a single best
// target/stop pair, plus what else could be added. Two things stood out:
// (1) every target/stop test so far only ever varied the TARGET (5/7/10)
// while holding the stop fixed at 10% — the stop side has never been swept
// at all; (2) an earlier backtest tonight (before any of this dip-ladder
// work) found that excluding ETFs/hybrids/bonds actually IMPROVED the
// edge, and that exclusion has never been applied here. This sweeps both
// target and stop across a real grid, with the exclusion on by default,
// grading the market and building the once-only candidate list ONCE (both
// are independent of target/stop) then re-running the cheap simulation
// once per grid cell — same 4-level, once-only, score-filtered setup as
// every other fixed target/stop test tonight, just swept properly instead
// of guessed at one pair at a time.
function _dipLadderGridSearch(shares, params){
  const {entryDays=5, totalWeeks=52, topN=4, amountPerLevel=5000, minScore=7,
    targets=[7,10,12,15,20], stops=[5,7,10,12,15],
    levels=[-10,-5,-2.5,0], excludeNonEquity=true, liqFloor=250000} = params||{};
  const useShares = excludeNonEquity ? shares.filter(s=>!_NONEQUITY_EXCLUDE.has(s.ticker)) : shares;
  const X=_auditNewCtx(useShares, 5, null, liqFloor);
  _auditRunAll(X);
  const recs=X.recs;
  const A=_auditFinalize(X);
  const M=A.M;
  const EXCLUDE={di:1,'vr-':1,'blk-':1,vr:1,blk:1};
  const byDay={};
  for(const rec of recs){
    let best=null;
    for(const k of rec.ks){
      if(EXCLUDE[k])continue;
      const m=M[k]; if(!m)continue;
      const sc=_cardScore10(m);
      if(sc<minScore)continue;
      if(!best||sc>best.score||(sc===best.score&&m.edge>best.edge))
        best={key:k,tier:m.tier,edge:m.edge,score:sc};
    }
    if(!best)continue;
    (byDay[rec.d]||(byDay[rec.d]=[])).push({ticker:rec.ticker,key:best.key,tier:best.tier,edge:best.edge,score:best.score});
  }
  const allDates=new Set();
  for(const s of useShares)for(const r of s.series)allDates.add(r.d);
  const calendar=[...allDates].sort();
  const nCal=calendar.length;
  const totalDaysCount=totalWeeks*5;
  if(nCal<totalDaysCount+5)return {error:'not enough trading history for a '+totalWeeks+'-week window'};
  const windowStartCalIdx=Math.max(0,nCal-totalDaysCount);
  const windowEndCalIdx=nCal-1;
  const windowStartDate=calendar[windowStartCalIdx];
  const windowEndDate=calendar[windowEndCalIdx];
  const blocks=[];
  for(let i=windowStartCalIdx;i<=windowEndCalIdx;i+=entryDays){
    const blockEnd=Math.min(i+entryDays-1,windowEndCalIdx);
    blocks.push({startIdx:i,endIdx:blockEnd,startDate:calendar[i],endDate:calendar[blockEnd]});
  }
  const shareByTicker={}; for(const s of useShares)shareByTicker[s.ticker]=s;

  // Build the once-only candidate list ONCE — independent of target/stop.
  const seenEver=new Set();
  const candidates=[];
  for(const block of blocks){
    const blockDays=calendar.slice(block.startIdx,block.endIdx+1);
    for(const d of blockDays){
      const picks=(byDay[d]||[]).slice().sort((a,b)=>(b.score-a.score)||(b.edge-a.edge)).slice(0,topN);
      for(const p of picks){
        if(seenEver.has(p.ticker))continue;
        seenEver.add(p.ticker);
        const sh=shareByTicker[p.ticker]; if(!sh)continue;
        const series=sh.series;
        const dateIdx={}; for(let i=0;i<series.length;i++)dateIdx[series[i].d]=i;
        const pickIdx=dateIdx[d]; if(pickIdx==null)continue;
        const idxForDate=(targetDate)=>{
          if(dateIdx[targetDate]!=null)return dateIdx[targetDate];
          let lo=0,hi=series.length-1,ans=null;
          while(lo<=hi){ const mid=(lo+hi)>>1; if(series[mid].d<=targetDate){ans=mid;lo=mid+1;} else hi=mid-1; }
          return ans;
        };
        const entryEndIdx=idxForDate(block.endDate);
        const windowEndIdx=idxForDate(windowEndDate);
        if(entryEndIdx==null||windowEndIdx==null||windowEndIdx<=pickIdx)continue;
        candidates.push({ticker:p.ticker,pickDate:d,series,pickIdx,entryEndIdx,windowEndIdx});
      }
    }
  }

  // Now the cheap part — re-run the simulation once per (target,stop) cell.
  const grid=[];
  for(const targetPct of targets){
    for(const stopPct of stops){
      let invested=0, proceeds=0, filled=0, wins=0;
      for(const c of candidates){
        for(const lv of levels){
          const lr=_simulateFixedTargetStop(c.series,c.pickIdx,c.entryEndIdx,c.windowEndIdx,lv,amountPerLevel,targetPct,stopPct);
          if(!lr.filled)continue;
          filled++; invested+=lr.invested; proceeds+=lr.totalProceeds; if(lr.pl>0)wins++;
        }
      }
      const pl=proceeds-invested;
      grid.push({targetPct, stopPct, candidates:candidates.length, filled,
        invested:+invested.toFixed(2), proceeds:+proceeds.toFixed(2), pl:+pl.toFixed(2),
        plPct:invested>0?+((pl/invested)*100).toFixed(2):0,
        winRate:filled>0?+((wins/filled)*100).toFixed(1):0});
    }
  }
  grid.sort((a,b)=>b.plPct-a.plPct);
  return { windowStartDate, windowEndDate, blockCount:blocks.length, candidateCount:candidates.length,
    excludeNonEquity, universeAfterExclusion:useShares.length,
    params:{entryDays,totalWeeks,topN,amountPerLevel,minScore,levels,targets,stops},
    grid };
}

// w449 — three grid rounds in a row found the widest corner still winning,
// with the pattern never once turning over in either direction. Before
// pushing wider again, this checks WHY: for a handful of specific pairs,
// it tallies not just P/L but *how each position actually exited* — target
// hit, stop hit, or ran out the window still open (marked at the last
// close). If the win keeps coming from wider pairs increasingly hitting
// window-end rather than a genuine target, the "optimum" isn't really
// exit discipline anymore — it's just measuring how good buy-and-hold was
// over this one mostly-rising year, which is a different (and much less
// robust) thing than a target/stop rule.
function _dipLadderGridDiagnostic(shares, params){
  const {entryDays=5, totalWeeks=52, topN=4, amountPerLevel=5000, minScore=7,
    pairs=[[10,10],[20,15],[40,30],[80,60]],
    levels=[-10,-5,-2.5,0], excludeNonEquity=true, liqFloor=250000} = params||{};
  const useShares = excludeNonEquity ? shares.filter(s=>!_NONEQUITY_EXCLUDE.has(s.ticker)) : shares;
  const X=_auditNewCtx(useShares, 5, null, liqFloor);
  _auditRunAll(X);
  const recs=X.recs;
  const A=_auditFinalize(X);
  const M=A.M;
  const EXCLUDE={di:1,'vr-':1,'blk-':1,vr:1,blk:1};
  const byDay={};
  for(const rec of recs){
    let best=null;
    for(const k of rec.ks){
      if(EXCLUDE[k])continue;
      const m=M[k]; if(!m)continue;
      const sc=_cardScore10(m);
      if(sc<minScore)continue;
      if(!best||sc>best.score||(sc===best.score&&m.edge>best.edge))
        best={key:k,tier:m.tier,edge:m.edge,score:sc};
    }
    if(!best)continue;
    (byDay[rec.d]||(byDay[rec.d]=[])).push({ticker:rec.ticker,key:best.key,tier:best.tier,edge:best.edge,score:best.score});
  }
  const allDates=new Set();
  for(const s of useShares)for(const r of s.series)allDates.add(r.d);
  const calendar=[...allDates].sort();
  const nCal=calendar.length;
  const totalDaysCount=totalWeeks*5;
  if(nCal<totalDaysCount+5)return {error:'not enough trading history for a '+totalWeeks+'-week window'};
  const windowStartCalIdx=Math.max(0,nCal-totalDaysCount);
  const windowEndCalIdx=nCal-1;
  const windowStartDate=calendar[windowStartCalIdx];
  const windowEndDate=calendar[windowEndCalIdx];
  const blocks=[];
  for(let i=windowStartCalIdx;i<=windowEndCalIdx;i+=entryDays){
    const blockEnd=Math.min(i+entryDays-1,windowEndCalIdx);
    blocks.push({startIdx:i,endIdx:blockEnd,startDate:calendar[i],endDate:calendar[blockEnd]});
  }
  const shareByTicker={}; for(const s of useShares)shareByTicker[s.ticker]=s;
  const seenEver=new Set();
  const candidates=[];
  for(const block of blocks){
    const blockDays=calendar.slice(block.startIdx,block.endIdx+1);
    for(const d of blockDays){
      const picks=(byDay[d]||[]).slice().sort((a,b)=>(b.score-a.score)||(b.edge-a.edge)).slice(0,topN);
      for(const p of picks){
        if(seenEver.has(p.ticker))continue;
        seenEver.add(p.ticker);
        const sh=shareByTicker[p.ticker]; if(!sh)continue;
        const series=sh.series;
        const dateIdx={}; for(let i=0;i<series.length;i++)dateIdx[series[i].d]=i;
        const pickIdx=dateIdx[d]; if(pickIdx==null)continue;
        const idxForDate=(targetDate)=>{
          if(dateIdx[targetDate]!=null)return dateIdx[targetDate];
          let lo=0,hi=series.length-1,ans=null;
          while(lo<=hi){ const mid=(lo+hi)>>1; if(series[mid].d<=targetDate){ans=mid;lo=mid+1;} else hi=mid-1; }
          return ans;
        };
        const entryEndIdx=idxForDate(block.endDate);
        const windowEndIdx=idxForDate(windowEndDate);
        if(entryEndIdx==null||windowEndIdx==null||windowEndIdx<=pickIdx)continue;
        candidates.push({ticker:p.ticker,pickDate:d,series,pickIdx,entryEndIdx,windowEndIdx});
      }
    }
  }
  const results=[];
  for(const pair of pairs){
    const targetPct=pair[0], stopPct=pair[1];
    let invested=0, proceeds=0, filled=0, wins=0, targetHits=0, stopHits=0, windowEndHits=0;
    for(const c of candidates){
      for(const lv of levels){
        const lr=_simulateFixedTargetStop(c.series,c.pickIdx,c.entryEndIdx,c.windowEndIdx,lv,amountPerLevel,targetPct,stopPct);
        if(!lr.filled)continue;
        filled++; invested+=lr.invested; proceeds+=lr.totalProceeds; if(lr.pl>0)wins++;
        if(lr.exitWhy==='target')targetHits++;
        else if(lr.exitWhy==='stop')stopHits++;
        else if(lr.exitWhy==='window-end')windowEndHits++;
      }
    }
    const pl=proceeds-invested;
    results.push({targetPct, stopPct, filled,
      targetHits, stopHits, windowEndHits,
      targetHitPct:filled>0?+((targetHits/filled)*100).toFixed(1):0,
      stopHitPct:filled>0?+((stopHits/filled)*100).toFixed(1):0,
      windowEndPct:filled>0?+((windowEndHits/filled)*100).toFixed(1):0,
      invested:+invested.toFixed(2), proceeds:+proceeds.toFixed(2), pl:+pl.toFixed(2),
      plPct:invested>0?+((pl/invested)*100).toFixed(2):0,
      winRate:filled>0?+((wins/filled)*100).toFixed(1):0});
  }
  return { windowStartDate, windowEndDate, candidateCount:candidates.length,
    excludeNonEquity, universeAfterExclusion:useShares.length,
    params:{entryDays,totalWeeks,topN,amountPerLevel,minScore,levels,pairs},
    results };
}

// resets each week (matching _dipLadderBacktestRecurring's own scope)
// rather than persisting across the whole year (_dipLadderBacktestFixedTS's
// global dedupe). byTicker concentration is restored since it's meaningful
// again once repeats are allowed. Also computes concurrent-$-exposure
// directly (peak / median / p90 across ALL 4 levels combined) — the number
// that actually decides whether this is executable on a real account,
// rather than the misleading "total invested over the whole year" figure
// (which double/triple-counts capital as it gets recycled through closed
// positions). Peak alone can be inflated by positions entered in the last
// few weeks that haven't had a fair chance to resolve yet (a backtest-
// boundary artifact, not a real requirement) — median is the more honest
// "typical" figure, reported alongside it rather than instead of it.
function _concurrentExposure(results, amountPerLevel){
  const openEvents={}, closeEvents={};
  let count=0;
  for(const r of results){
    for(const lr of r.levels){
      if(!lr.filled)continue;
      count++;
      openEvents[lr.fillDate]=(openEvents[lr.fillDate]||0)+1;
      closeEvents[lr.exitDate]=(closeEvents[lr.exitDate]||0)+1;
    }
  }
  const allDates=[...new Set([...Object.keys(openEvents),...Object.keys(closeEvents)])].sort();
  let running=0; const series=[];
  for(const d of allDates){
    running+=(openEvents[d]||0);
    series.push(running*amountPerLevel);
    running-=(closeEvents[d]||0);
  }
  const sorted=series.slice().sort((a,b)=>a-b);
  const n=sorted.length;
  const pct=(p)=>n?sorted[Math.min(n-1,Math.floor(n*p))]:0;
  return { positionsFilled:count, peakExposure:n?sorted[n-1]:0, medianExposure:pct(0.5), p90Exposure:pct(0.9) };
}
function _dipLadderBacktestFixedTSMulti(shares, params){
  const {entryDays=5, totalWeeks=52, topN=7, amountPerLevel=5000,
    targetPct=10, stopPct=10,
    levels=[-10,-5,-2.5,0], liqFloor=250000} = params||{};
  const X=_auditNewCtx(shares, 5, null, liqFloor);
  _auditRunAll(X);
  const recs=X.recs;
  const A=_auditFinalize(X);
  const M=A.M;
  const EXCLUDE={di:1,'vr-':1,'blk-':1,vr:1,blk:1};
  const tierRank={solid:2,promising:1,early:0};
  const byDay={};
  for(const rec of recs){
    let best=null;
    for(const k of rec.ks){
      if(EXCLUDE[k])continue;
      const m=M[k]; if(!m||m.tier==='early')continue;
      if(!best||tierRank[m.tier]>tierRank[best.tier]||(tierRank[m.tier]===tierRank[best.tier]&&m.edge>best.edge))
        best={key:k,tier:m.tier,edge:m.edge};
    }
    if(!best)continue;
    (byDay[rec.d]||(byDay[rec.d]=[])).push({ticker:rec.ticker,key:best.key,tier:best.tier,edge:best.edge});
  }
  const allDates=new Set();
  for(const s of shares)for(const r of s.series)allDates.add(r.d);
  const calendar=[...allDates].sort();
  const nCal=calendar.length;
  const totalDaysCount=totalWeeks*5;
  if(nCal<totalDaysCount+5)return {error:'not enough trading history for a '+totalWeeks+'-week window'};
  const windowStartCalIdx=Math.max(0,nCal-totalDaysCount);
  const windowEndCalIdx=nCal-1;
  const windowStartDate=calendar[windowStartCalIdx];
  const windowEndDate=calendar[windowEndCalIdx];
  const blocks=[];
  for(let i=windowStartCalIdx;i<=windowEndCalIdx;i+=entryDays){
    const blockEnd=Math.min(i+entryDays-1,windowEndCalIdx);
    blocks.push({startIdx:i,endIdx:blockEnd,startDate:calendar[i],endDate:calendar[blockEnd]});
  }
  const shareByTicker={}; for(const s of shares)shareByTicker[s.ticker]=s;
  const results=[];
  for(const block of blocks){
    const blockDays=calendar.slice(block.startIdx,block.endIdx+1);
    const seenThisBlock=new Set(); // resets EVERY week — multiple buys of the same share across different weeks are allowed
    for(const d of blockDays){
      const picks=(byDay[d]||[]).slice().sort((a,b)=>(tierRank[b.tier]-tierRank[a.tier])||(b.edge-a.edge)).slice(0,topN);
      for(const p of picks){
        if(seenThisBlock.has(p.ticker))continue;
        seenThisBlock.add(p.ticker);
        const sh=shareByTicker[p.ticker]; if(!sh)continue;
        const series=sh.series;
        const dateIdx={}; for(let i=0;i<series.length;i++)dateIdx[series[i].d]=i;
        const pickIdx=dateIdx[d]; if(pickIdx==null)continue;
        const idxForDate=(targetDate)=>{
          if(dateIdx[targetDate]!=null)return dateIdx[targetDate];
          let lo=0,hi=series.length-1,ans=null;
          while(lo<=hi){ const mid=(lo+hi)>>1; if(series[mid].d<=targetDate){ans=mid;lo=mid+1;} else hi=mid-1; }
          return ans;
        };
        const entryEndIdx=idxForDate(block.endDate);
        const windowEndIdx=idxForDate(windowEndDate);
        if(entryEndIdx==null||windowEndIdx==null||windowEndIdx<=pickIdx)continue;
        const levelResults=levels.map(lv=>_simulateFixedTargetStop(series,pickIdx,entryEndIdx,windowEndIdx,lv,amountPerLevel,targetPct,stopPct));
        results.push({ticker:p.ticker,pickDate:d,weekStart:block.startDate,evidenceKey:p.key,tier:p.tier,edge:p.edge,levels:levelResults});
      }
    }
  }
  const perLevel={};
  for(const lv of levels)perLevel[lv]={filled:0,notFilled:0,invested:0,proceeds:0,wins:0};
  for(const r of results){
    for(const lr of r.levels){
      const agg=perLevel[lr.level];
      if(!lr.filled){agg.notFilled++;continue;}
      agg.filled++; agg.invested+=lr.invested; agg.proceeds+=lr.totalProceeds; if(lr.pl>0)agg.wins++;
    }
  }
  const perLevelSummary=levels.map(lv=>{
    const a=perLevel[lv];
    const pl=a.proceeds-a.invested;
    return {level:lv, candidates:results.length, filled:a.filled, notFilled:a.notFilled,
      invested:+a.invested.toFixed(2), proceeds:+a.proceeds.toFixed(2), pl:+pl.toFixed(2),
      plPct:a.invested>0?+((pl/a.invested)*100).toFixed(2):0,
      winRate:a.filled>0?+((a.wins/a.filled)*100).toFixed(1):0};
  });
  const byTickerMap={};
  for(const r of results){
    const t=byTickerMap[r.ticker]||(byTickerMap[r.ticker]={ticker:r.ticker,timesPicked:0,invested:0,proceeds:0});
    t.timesPicked++;
    for(const lr of r.levels){ if(lr.filled){ t.invested+=lr.invested; t.proceeds+=lr.totalProceeds; } }
  }
  const byTicker=Object.values(byTickerMap).map(t=>({ticker:t.ticker,timesPicked:t.timesPicked,invested:+t.invested.toFixed(2),proceeds:+t.proceeds.toFixed(2),pl:+(t.proceeds-t.invested).toFixed(2)})).sort((a,b)=>b.timesPicked-a.timesPicked||b.pl-a.pl);
  const exposure=_concurrentExposure(results, amountPerLevel);
  return { windowStartDate, windowEndDate, blockCount:blocks.length, candidateCount:results.length,
    params:{entryDays,totalWeeks,topN,amountPerLevel,targetPct,stopPct,levels},
    perLevelSummary, byTicker, exposure, candidates:results };
}

// w442 — Tony asked what combination and stop/target the evidence actually
// supports, and whether to stay away from repeat buys. Everything tested so
// far (w440/w441) only compared NEW fixed-target-stop variants against each
// other — never against the app's OWN current recommended defaults
// (applyBotBestPractice(): 20% target, 8% stop, 8% trailing, breakeven-arm
// at +5%, 10-day max hold — a materially different, more complex exit than
// a flat target/stop pair). This closes that gap: same evidence-picking,
// same once-only dedupe (the already-established better choice), same
// single -5% dip buy level for BOTH sides — so the exit mechanism is the
// only thing that differs, and the comparison is honest.
function _simulateHybridExit(series, pickIdx, entryEndIdx, windowEndIdx, levelPct, amountDollars, targetPct, stopPct, trailPct, bePct, maxHoldDays){
  const pickClose=series[pickIdx].c;
  const limitPrice=levelPct===0?null:+(pickClose*(1+levelPct/100)).toFixed(4);
  let fillIdx=null, fillPrice=null;
  if(levelPct===0){
    const nxt=series[pickIdx+1];
    if(pickIdx+1<=entryEndIdx&&nxt&&nxt.o>0){ fillIdx=pickIdx+1; fillPrice=nxt.o; }
  } else {
    for(let i=pickIdx+1;i<=entryEndIdx;i++){
      const day=series[i]; if(!day)break;
      if(day.o>0&&day.o<=limitPrice){ fillIdx=i; fillPrice=day.o; break; }
      if(day.lo>0&&day.lo<=limitPrice){ fillIdx=i; fillPrice=limitPrice; break; }
    }
  }
  if(fillIdx===null)return {level:levelPct, limitPrice, filled:false};
  let peak=fillPrice, beArmed=false;
  let exitIdx=null, exitPrice=null, exitWhy=null;
  const targetPrice=fillPrice*(1+targetPct/100);
  for(let i=fillIdx+1;i<=windowEndIdx;i++){
    const day=series[i]; if(!day)break;
    const heldDays=i-fillIdx;
    if(maxHoldDays>0&&heldDays>maxHoldDays){ exitIdx=i; exitPrice=day.o; exitWhy='time'; break; }
    const fixedStop=fillPrice*(1-stopPct/100);
    const trailStop=trailPct>0?peak*(1-trailPct/100):0;
    const beStop=beArmed?fillPrice:0;
    const stopNow=Math.max(fixedStop,trailStop,beStop);
    if(stopNow>0){
      if(day.o>0&&day.o<=stopNow){ exitIdx=i; exitPrice=day.o; exitWhy='stop'; break; }
      if(day.lo>0&&day.lo<=stopNow){ exitIdx=i; exitPrice=stopNow; exitWhy='stop'; break; }
    }
    if(targetPct>0){
      if(day.o>0&&day.o>=targetPrice){ exitIdx=i; exitPrice=day.o; exitWhy='target'; break; }
      if(day.hi>0&&day.hi>=targetPrice){ exitIdx=i; exitPrice=targetPrice; exitWhy='target'; break; }
    }
    if(day.c>0){
      if(day.c>peak)peak=day.c;
      if(!beArmed&&bePct>0&&day.c>=fillPrice*(1+bePct/100))beArmed=true;
    }
  }
  if(exitIdx===null){ exitIdx=windowEndIdx; exitPrice=series[windowEndIdx].c; exitWhy='window-end'; }
  const qty=amountDollars/fillPrice;
  const proceeds=qty*exitPrice;
  const pl=proceeds-amountDollars;
  const plPct=(proceeds/amountDollars-1)*100;
  return {level:levelPct, limitPrice, filled:true, fillDate:series[fillIdx].d, fillPrice,
    exitDate:series[exitIdx].d, exitPrice, exitWhy,
    invested:amountDollars, totalProceeds:+proceeds.toFixed(2), pl:+pl.toFixed(2), plPct:+plPct.toFixed(2)};
}
function _dipLadderVsAppDefault(shares, params){
  const {entryDays=5, totalWeeks=52, topN=7, amountPerLevel=5000,
    buyLevel=-5, liqFloor=250000,
    appTarget=20, appStop=8, appTrail=8, appBE=5, appHold=10,
    newTarget=10, newStop=10} = params||{};
  const X=_auditNewCtx(shares, 5, null, liqFloor);
  _auditRunAll(X);
  const recs=X.recs;
  const A=_auditFinalize(X);
  const M=A.M;
  const EXCLUDE={di:1,'vr-':1,'blk-':1,vr:1,blk:1};
  const tierRank={solid:2,promising:1,early:0};
  const byDay={};
  for(const rec of recs){
    let best=null;
    for(const k of rec.ks){
      if(EXCLUDE[k])continue;
      const m=M[k]; if(!m||m.tier==='early')continue;
      if(!best||tierRank[m.tier]>tierRank[best.tier]||(tierRank[m.tier]===tierRank[best.tier]&&m.edge>best.edge))
        best={key:k,tier:m.tier,edge:m.edge};
    }
    if(!best)continue;
    (byDay[rec.d]||(byDay[rec.d]=[])).push({ticker:rec.ticker,key:best.key,tier:best.tier,edge:best.edge});
  }
  const allDates=new Set();
  for(const s of shares)for(const r of s.series)allDates.add(r.d);
  const calendar=[...allDates].sort();
  const nCal=calendar.length;
  const totalDaysCount=totalWeeks*5;
  if(nCal<totalDaysCount+5)return {error:'not enough trading history for a '+totalWeeks+'-week window'};
  const windowStartCalIdx=Math.max(0,nCal-totalDaysCount);
  const windowEndCalIdx=nCal-1;
  const windowStartDate=calendar[windowStartCalIdx];
  const windowEndDate=calendar[windowEndCalIdx];
  const blocks=[];
  for(let i=windowStartCalIdx;i<=windowEndCalIdx;i+=entryDays){
    const blockEnd=Math.min(i+entryDays-1,windowEndCalIdx);
    blocks.push({startIdx:i,endIdx:blockEnd,startDate:calendar[i],endDate:calendar[blockEnd]});
  }
  const shareByTicker={}; for(const s of shares)shareByTicker[s.ticker]=s;
  const results=[];
  const seenEver=new Set(); // once-only across the whole window — the already-established better choice
  for(const block of blocks){
    const blockDays=calendar.slice(block.startIdx,block.endIdx+1);
    for(const d of blockDays){
      const picks=(byDay[d]||[]).slice().sort((a,b)=>(tierRank[b.tier]-tierRank[a.tier])||(b.edge-a.edge)).slice(0,topN);
      for(const p of picks){
        if(seenEver.has(p.ticker))continue;
        seenEver.add(p.ticker);
        const sh=shareByTicker[p.ticker]; if(!sh)continue;
        const series=sh.series;
        const dateIdx={}; for(let i=0;i<series.length;i++)dateIdx[series[i].d]=i;
        const pickIdx=dateIdx[d]; if(pickIdx==null)continue;
        const idxForDate=(targetDate)=>{
          if(dateIdx[targetDate]!=null)return dateIdx[targetDate];
          let lo=0,hi=series.length-1,ans=null;
          while(lo<=hi){ const mid=(lo+hi)>>1; if(series[mid].d<=targetDate){ans=mid;lo=mid+1;} else hi=mid-1; }
          return ans;
        };
        const entryEndIdx=idxForDate(block.endDate);
        const windowEndIdx=idxForDate(windowEndDate);
        if(entryEndIdx==null||windowEndIdx==null||windowEndIdx<=pickIdx)continue;
        const appResult=_simulateHybridExit(series,pickIdx,entryEndIdx,windowEndIdx,buyLevel,amountPerLevel,appTarget,appStop,appTrail,appBE,appHold);
        const newResult=_simulateFixedTargetStop(series,pickIdx,entryEndIdx,windowEndIdx,buyLevel,amountPerLevel,newTarget,newStop);
        results.push({ticker:p.ticker,pickDate:d,weekStart:block.startDate,evidenceKey:p.key,tier:p.tier,edge:p.edge,appResult,newResult});
      }
    }
  }
  const agg=(field)=>{
    const a={filled:0,notFilled:0,invested:0,proceeds:0,wins:0};
    for(const r of results){
      const lr=r[field]; if(!lr.filled){a.notFilled++;continue;}
      a.filled++; a.invested+=lr.invested; a.proceeds+=lr.totalProceeds; if(lr.pl>0)a.wins++;
    }
    const pl=a.proceeds-a.invested;
    return {candidates:results.length, filled:a.filled, notFilled:a.notFilled,
      invested:+a.invested.toFixed(2), proceeds:+a.proceeds.toFixed(2), pl:+pl.toFixed(2),
      plPct:a.invested>0?+((pl/a.invested)*100).toFixed(2):0,
      winRate:a.filled>0?+((a.wins/a.filled)*100).toFixed(1):0};
  };
  const expOf=(field)=>_concurrentExposure(results.map(r=>({levels:[r[field]]})), amountPerLevel);
  return { windowStartDate, windowEndDate, blockCount:blocks.length, candidateCount:results.length,
    buyLevel,
    appConfig:{target:appTarget,stop:appStop,trail:appTrail,be:appBE,hold:appHold},
    newConfig:{target:newTarget,stop:newStop},
    appSummary:agg('appResult'), newSummary:agg('newResult'),
    appExposure:expOf('appResult'), newExposure:expOf('newResult'),
    candidates:results };
}

// w455 — Tony asked to run this comparison again, but everything since the
// original (10%/10%) version — the score>=7 filter, top-4 selection,
// ETF/hybrid/bond exclusion, and now the 15%/15% answer itself — was
// established using the newer, score-based selection logic. The original
// _dipLadderVsAppDefault above still uses the older tier-rank/topN=7
// selection from when it was first built, so reusing it as-is would be
// comparing 15/15 against a DIFFERENT, older candidate pool than the one
// that actually produced the 15/15 answer. This is the same head-to-head —
// app's live mechanism vs a fixed target/stop, same -5% dip entry, same
// picks for both sides — rebuilt on the current-standard selection so the
// comparison is genuinely apples-to-apples with everything that led here.
function _dipLadderVsAppDefaultV2(shares, params){
  const {entryDays=5, totalWeeks=52, topN=4, amountPerLevel=5000,
    buyLevel=-5, minScore=7, excludeNonEquity=true, liqFloor=250000,
    appTarget=20, appStop=8, appTrail=8, appBE=5, appHold=10,
    newTarget=15, newStop=15} = params||{};
  const useShares = excludeNonEquity ? shares.filter(s=>!_NONEQUITY_EXCLUDE.has(s.ticker)) : shares;
  const X=_auditNewCtx(useShares, 5, null, liqFloor);
  _auditRunAll(X);
  const recs=X.recs;
  const A=_auditFinalize(X);
  const M=A.M;
  const EXCLUDE={di:1,'vr-':1,'blk-':1,vr:1,blk:1};
  const byDay={};
  for(const rec of recs){
    let best=null;
    for(const k of rec.ks){
      if(EXCLUDE[k])continue;
      const m=M[k]; if(!m)continue;
      const sc=_cardScore10(m);
      if(sc<minScore)continue;
      if(!best||sc>best.score||(sc===best.score&&m.edge>best.edge))
        best={key:k,tier:m.tier,edge:m.edge,score:sc};
    }
    if(!best)continue;
    (byDay[rec.d]||(byDay[rec.d]=[])).push({ticker:rec.ticker,key:best.key,tier:best.tier,edge:best.edge,score:best.score});
  }
  const allDates=new Set();
  for(const s of useShares)for(const r of s.series)allDates.add(r.d);
  const calendar=[...allDates].sort();
  const nCal=calendar.length;
  const totalDaysCount=totalWeeks*5;
  if(nCal<totalDaysCount+5)return {error:'not enough trading history for a '+totalWeeks+'-week window'};
  const windowStartCalIdx=Math.max(0,nCal-totalDaysCount);
  const windowEndCalIdx=nCal-1;
  const windowStartDate=calendar[windowStartCalIdx];
  const windowEndDate=calendar[windowEndCalIdx];
  const blocks=[];
  for(let i=windowStartCalIdx;i<=windowEndCalIdx;i+=entryDays){
    const blockEnd=Math.min(i+entryDays-1,windowEndCalIdx);
    blocks.push({startIdx:i,endIdx:blockEnd,startDate:calendar[i],endDate:calendar[blockEnd]});
  }
  const shareByTicker={}; for(const s of useShares)shareByTicker[s.ticker]=s;
  const results=[];
  const seenEver=new Set();
  for(const block of blocks){
    const blockDays=calendar.slice(block.startIdx,block.endIdx+1);
    for(const d of blockDays){
      const picks=(byDay[d]||[]).slice().sort((a,b)=>(b.score-a.score)||(b.edge-a.edge)).slice(0,topN);
      for(const p of picks){
        if(seenEver.has(p.ticker))continue;
        seenEver.add(p.ticker);
        const sh=shareByTicker[p.ticker]; if(!sh)continue;
        const series=sh.series;
        const dateIdx={}; for(let i=0;i<series.length;i++)dateIdx[series[i].d]=i;
        const pickIdx=dateIdx[d]; if(pickIdx==null)continue;
        const idxForDate=(targetDate)=>{
          if(dateIdx[targetDate]!=null)return dateIdx[targetDate];
          let lo=0,hi=series.length-1,ans=null;
          while(lo<=hi){ const mid=(lo+hi)>>1; if(series[mid].d<=targetDate){ans=mid;lo=mid+1;} else hi=mid-1; }
          return ans;
        };
        const entryEndIdx=idxForDate(block.endDate);
        const windowEndIdx=idxForDate(windowEndDate);
        if(entryEndIdx==null||windowEndIdx==null||windowEndIdx<=pickIdx)continue;
        const appResult=_simulateHybridExit(series,pickIdx,entryEndIdx,windowEndIdx,buyLevel,amountPerLevel,appTarget,appStop,appTrail,appBE,appHold);
        const newResult=_simulateFixedTargetStop(series,pickIdx,entryEndIdx,windowEndIdx,buyLevel,amountPerLevel,newTarget,newStop);
        results.push({ticker:p.ticker,pickDate:d,weekStart:block.startDate,evidenceKey:p.key,tier:p.tier,edge:p.edge,score:p.score,appResult,newResult});
      }
    }
  }
  const agg=(field)=>{
    const a={filled:0,notFilled:0,invested:0,proceeds:0,wins:0};
    for(const r of results){
      const lr=r[field]; if(!lr.filled){a.notFilled++;continue;}
      a.filled++; a.invested+=lr.invested; a.proceeds+=lr.totalProceeds; if(lr.pl>0)a.wins++;
    }
    const pl=a.proceeds-a.invested;
    return {candidates:results.length, filled:a.filled, notFilled:a.notFilled,
      invested:+a.invested.toFixed(2), proceeds:+a.proceeds.toFixed(2), pl:+pl.toFixed(2),
      plPct:a.invested>0?+((pl/a.invested)*100).toFixed(2):0,
      winRate:a.filled>0?+((a.wins/a.filled)*100).toFixed(1):0};
  };
  const expOf=(field)=>_concurrentExposure(results.map(r=>({levels:[r[field]]})), amountPerLevel);
  return { windowStartDate, windowEndDate, blockCount:blocks.length, candidateCount:results.length,
    buyLevel, excludeNonEquity, universeAfterExclusion:useShares.length,
    appConfig:{target:appTarget,stop:appStop,trail:appTrail,be:appBE,hold:appHold},
    newConfig:{target:newTarget,stop:newStop},
    appSummary:agg('appResult'), newSummary:agg('newResult'),
    appExposure:expOf('appResult'), newExposure:expOf('newResult'),
    candidates:results };
}

// ── w419: READ THE GRADING UNIVERSE FROM THE PANTRY ─────────────────────────
// The bars are already HERE — the app has been slimming and uploading 540 bars
// per share for data this store holds. This reads the same window straight
// from D1: a 560-trading-day tail (v538's proven-equivalent 540 + slack), for
// tickers passing a GENEROUS turnover prefilter (half the requested floor over
// the last 90 exchange days) so the read stays proportionate — the engine then
// applies its EXACT gates (turnover, flat, stale) on the loaded series, so the
// prefilter can only trim the read, never change the answer.
async function _pantrySeries(env, exch, floor){
  const cut = await env.MARKET_DB.prepare(
    'SELECT d FROM (SELECT DISTINCT d FROM bars WHERE exch=? ORDER BY d DESC LIMIT 560) ORDER BY d ASC LIMIT 1'
  ).bind(exch).first();
  if (!cut || !cut.d) return null;
  const from = cut.d;
  const w90 = await env.MARKET_DB.prepare(
    'SELECT d FROM (SELECT DISTINCT d FROM bars WHERE exch=? ORDER BY d DESC LIMIT 90) ORDER BY d ASC LIMIT 1'
  ).bind(exch).first();
  const from90 = (w90 && w90.d) || from;
  const tq = await env.MARKET_DB.prepare(
    'SELECT ticker FROM bars WHERE exch=? AND d>=? AND c>0 AND v>0 GROUP BY ticker HAVING AVG(c*v)>=?'
  ).bind(exch, from90, Math.max(1, Math.floor(floor * 0.5))).all();
  const tickers = ((tq && tq.results) || []).map(r => r.ticker);
  const shares = [];
  for (let i = 0; i < tickers.length; i += 90) {           // w411: D1 caps bound vars at 100
    const batch = tickers.slice(i, i + 90);
    const ph = batch.map(() => '?').join(',');
    const rs = await env.MARKET_DB.prepare(
      'SELECT ticker,d,c,v FROM bars WHERE exch=? AND d>=? AND ticker IN (' + ph + ') ORDER BY ticker,d'
    ).bind(exch, from, ...batch).all();
    let curT = null, cur = null;
    for (const row of (rs.results || [])) {
      if (row.ticker !== curT) { curT = row.ticker; cur = []; shares.push({ ticker: row.ticker, series: cur }); }
      cur.push({ d: row.d, c: +row.c, v: +row.v });
    }
  }
  return { shares, universe: tickers.length, from };
}
// w437 — same pantry read as _pantrySeries, but carries o/h/l too (the bars
// table has always stored full OHLC — the existing evidence-grading fetch
// just never needed more than close+volume, since _auditOneShare only ever
// reads s.series[i].c/.v). Reused for BOTH the grading pass (harmless extra
// fields it ignores) and the new dip-ladder backtest's fill simulation
// (which genuinely needs open/high/low for gap-aware, no-hindsight fills —
// same convention as the app's own checkAutoSellTargets: a gap through a
// limit/stop fills at the open; otherwise an intraday touch fills AT the
// limit/stop itself).
async function _pantrySeriesOHLC(env, exch, floor){
  const cut = await env.MARKET_DB.prepare(
    'SELECT d FROM (SELECT DISTINCT d FROM bars WHERE exch=? ORDER BY d DESC LIMIT 560) ORDER BY d ASC LIMIT 1'
  ).bind(exch).first();
  if (!cut || !cut.d) return null;
  const from = cut.d;
  const w90 = await env.MARKET_DB.prepare(
    'SELECT d FROM (SELECT DISTINCT d FROM bars WHERE exch=? ORDER BY d DESC LIMIT 90) ORDER BY d ASC LIMIT 1'
  ).bind(exch).first();
  const from90 = (w90 && w90.d) || from;
  const tq = await env.MARKET_DB.prepare(
    'SELECT ticker FROM bars WHERE exch=? AND d>=? AND c>0 AND v>0 GROUP BY ticker HAVING AVG(c*v)>=?'
  ).bind(exch, from90, Math.max(1, Math.floor(floor * 0.5))).all();
  const tickers = ((tq && tq.results) || []).map(r => r.ticker);
  const shares = [];
  for (let i = 0; i < tickers.length; i += 90) {
    const batch = tickers.slice(i, i + 90);
    const ph = batch.map(() => '?').join(',');
    const rs = await env.MARKET_DB.prepare(
      'SELECT ticker,d,o,h,l,c,v FROM bars WHERE exch=? AND d>=? AND ticker IN (' + ph + ') ORDER BY ticker,d'
    ).bind(exch, from, ...batch).all();
    let curT = null, cur = null;
    for (const row of (rs.results || [])) {
      if (row.ticker !== curT) { curT = row.ticker; cur = []; shares.push({ ticker: row.ticker, series: cur }); }
      cur.push({ d: row.d, o: +row.o, hi: +row.h, lo: +row.l, c: +row.c, v: +row.v });
    }
  }
  return { shares, universe: tickers.length, from };
}

// w451 — Tony asked to run the capital-cost comparison over 3 years, but
// _pantrySeriesOHLC hard-limits to the last 560 stored trading days
// (~2.15 years) regardless of how much history the bars table actually
// holds — a true 3-year (156-week) window would silently get truncated to
// ~2.15 years under that fetch, which would mislabel the result. This is
// the same fetch with the limit raised, used only by the long-window
// dip-ladder route so the existing 560-bar path (and whatever else depends
// on its current behavior) stays untouched. If the bars table doesn't
// actually go back that far, the backtest functions' own "not enough
// trading history" check will say so honestly rather than this silently
// returning a shorter window.
// w462 — default raised from 900 (~3.5yr) to 2700 (~10.4yr) to match the
// crawler's new 2600-day target (w462, same session) — this fetch cap must
// stay ahead of however deep the pantry actually gets, or a genuine 10-year
// backtest would silently truncate the exact same way the original 560-bar
// default did. The bars table itself will only actually hold this much once
// the backfill (driven manually, a real billed EODData call at a time) has
// run long enough to reach it — until then the graceful error above is what
// tells you how far it's actually gotten.
// w520: how many trading days a backtest may load. Was hardcoded to 900 at
// every call site, which silently capped every test at ~3.5 years however
// long a window was requested. Default unchanged; ?maxBars= opens it up.
function _maxBars(url){ const v = +url.searchParams.get('maxBars');
  return (isFinite(v) && v > 0) ? Math.min(2700, Math.max(200, Math.floor(v))) : 900; }
async function _pantrySeriesOHLCLong(env, exch, floor, maxBars){
  const cap = maxBars || 2700;
  const cut = await env.MARKET_DB.prepare(
    'SELECT d FROM (SELECT DISTINCT d FROM bars WHERE exch=? ORDER BY d DESC LIMIT ' + (+cap) + ') ORDER BY d ASC LIMIT 1'
  ).bind(exch).first();
  if (!cut || !cut.d) return null;
  const from = cut.d;
  const w90 = await env.MARKET_DB.prepare(
    'SELECT d FROM (SELECT DISTINCT d FROM bars WHERE exch=? ORDER BY d DESC LIMIT 90) ORDER BY d ASC LIMIT 1'
  ).bind(exch).first();
  const from90 = (w90 && w90.d) || from;
  const tq = await env.MARKET_DB.prepare(
    'SELECT ticker FROM bars WHERE exch=? AND d>=? AND c>0 AND v>0 GROUP BY ticker HAVING AVG(c*v)>=?'
  ).bind(exch, from90, Math.max(1, Math.floor(floor * 0.5))).all();
  const tickers = ((tq && tq.results) || []).map(r => r.ticker);
  const shares = [];
  for (let i = 0; i < tickers.length; i += 90) {
    const batch = tickers.slice(i, i + 90);
    const ph = batch.map(() => '?').join(',');
    const rs = await env.MARKET_DB.prepare(
      'SELECT ticker,d,o,h,l,c,v FROM bars WHERE exch=? AND d>=? AND ticker IN (' + ph + ') ORDER BY ticker,d'
    ).bind(exch, from, ...batch).all();
    let curT = null, cur = null;
    for (const row of (rs.results || [])) {
      if (row.ticker !== curT) { curT = row.ticker; cur = []; shares.push({ ticker: row.ticker, series: cur }); }
      cur.push({ d: row.d, o: +row.o, hi: +row.h, lo: +row.l, c: +row.c, v: +row.v });
    }
  }
  return { shares, universe: tickers.length, from };
}

// ── w421: THE DAY GRADES ITSELF AT THE CLOSE ────────────────────────────────
// Since w419 the worker grades from its own pantry — which means nobody has to
// be the first asker of the day. Right after the final ingest, this computes
// the standard combos (5-day window at the three floors the app offers) into
// the same cache POST /grades serves, so EVERY device's first look — desktop,
// phone, customer — answers in about a second. Windows 10/30 stay
// compute-on-first-ask (rarer, and their asker sees the honest live timer).
async function _gradeWarm(env, exch, date){
  const out = { warmed: 0, floors: [] };
  if (!env || !env.MARKET_DB || !date) return out;
  const cache = caches.default;
  /* w422 — warm EVERY window Tony actually uses, on the ONE ruler.
     v586 fixed the measurement floor at $250k (the other floors are display
     filters and are never asked for — trimming them here was queued since
     w421 shipped). And v588 made a hold-window switch re-ask the server
     immediately, which exposed the gap Tony felt as 'really slow when
     switching': only 5d was warmed, so the first 10d/30d ask of each day
     computed fresh for 30–90s. Now the close computes all three windows —
     same nightly budget as the old 3-floor warm, and a window switch lands
     on the day's cache like everything else. */
  const FLOORS = [250000], HOLDS = [5, 10, 30];
  let annPS = null; try { annPS = await _annFromStore(env, exch); } catch (e) { annPS = null; }
  /* w422: eras exist only where w417 built them (5d) — fetched per-hold inside the loop, null elsewhere is honest */
  for (const HOLD of HOLDS) for (const fl of FLOORS) {
    try {
      const dd = date + '_p';                     // exactly what the v580 app sends
      const key = new Request(_GC_ORIGIN + '/grades-cache?exch=' + encodeURIComponent(exch) + '&date=' + encodeURIComponent(dd) + '&hold=' + HOLD + '&fp=pantry' + fl, { method: 'GET' });
      const _had = await cache.match(key);
      if (_had) { /* w555: a cache built on the early trickle must not pin the day */
        let _hu = 0; try { _hu = ((await _had.clone().json()) || {}).universe | 0; } catch (e) { _hu = 0; }
        if (_hu >= 500) { out.floors.push(fl + ':had'); continue; }
        try { await cache.delete(key); } catch (e) {}
      }
      let eras = null; try { eras = await _eraSummaryCached(env, HOLD); } catch (e) { eras = null; }
      const pan = await _pantrySeries(env, exch, fl);
      if (!pan || !pan.shares.length) { out.floors.push(fl + ':empty'); continue; }
      const A = gradeShares(pan.shares, HOLD, annPS, fl);
      if (eras && A) { A.eras = eras; _applyEraCap(A); }
      const body = JSON.stringify({ ok: true, date: dd, src: 'pantry', universe: pan.universe, from: pan.from, A });
      await cache.put(key, new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${GRADE_CACHE_SECONDS}` } }));
      try { if (body.length <= 900000) await env.MARKET_DB.prepare('INSERT INTO meta (k,v,updated) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated=excluded.updated').bind(_d1cKey(key.url), body, new Date().toISOString()).run(); } catch (e) {}
      out.warmed++; out.floors.push(fl + ':warmed');
    } catch (e) { out.floors.push(fl + ':err'); }
  }
  return out;
}

// ── w522: CLOSE TASKS FIRE ON DATA ARRIVAL, NOT ON THE CLOCK ────────────────
// The old design gave the evening exactly one shot: a single 'final' ingest
// pass (~18:31 Sydney) ran tech52 + grade warm + the pick lanes + the R2 copy.
// On 13 Aug the close's bars arrived at 20:44 (late, via the backfill) — the
// 18:31 shot had already fired against YESTERDAY'S data: picks graded the old
// day, and the warm cached grades computed on 12 Aug bars under 13 Aug's key.
// Now every cron tick asks one cheap question — "is the pantry's latest day
// newer than the last day I finished close tasks for?" — and runs whatever is
// still undone for that day, task by task, with per-task retry. A failed task
// (e.g. D1 busy under a backfill) simply stays unticked and re-runs next tick.
// w541: how many cron ticks the pick lanes will wait for grading to finish
// before going ahead on the last fully graded session and saying so. Sized to
// cover a normal grading run with room to spare, not to wait forever.
const _PICK_WAIT_MAX = 24;
async function _dayCloseTasks(env, t) {
  if (!env || !env.MARKET_DB) return;
  const mx = await env.MARKET_DB.prepare("SELECT MAX(d) d FROM bars WHERE exch='ASX'").first();
  const day = mx && mx.d; if (!day) return;
  // w555: EARLY-TRICKLE GATE - a new day exists the moment ONE early bar lands
  // (~17:00 Sydney), but the evening must not start until the day's data has
  // actually finished arriving (~18:40). Final/refine stamp, or >=1500 bars.
  try {
    const ing = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind('ingest_ASX_' + day).first();
    if (!/final|refine/.test(String((ing && ing.v) || ''))) {
      const bc = await env.MARKET_DB.prepare("SELECT COUNT(*) n FROM bars WHERE exch='ASX' AND d=?").bind(day).first();
      if (!bc || (bc.n | 0) < 1500) return;   // still trickling in - wait, whole checklist
    }
  } catch (e) { return; }
  const got = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind('closeTasks_ASX').first();
  let st = {}; try { st = JSON.parse((got && got.v) || '{}'); } catch (e) { st = {}; }
  if (st.day !== day) st = { day };                       // a new close resets the checklist
  // w541: scanGrades joins the checklist. Without it, once the other tasks were
  // ticked this block returned early and the half-finished grader was abandoned
  // for the day \u2014 which is exactly how the lanes ended up picking on stale grades.
  if (st.tech52 && st.scanGrades && st.warm && st.picks && st.ann && st.acct && st.la && st.r2) return;   // all done for this close
  const save = async () => { try { await env.MARKET_DB.prepare('INSERT INTO meta (k,v,updated) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated=excluded.updated').bind('closeTasks_ASX', JSON.stringify(st), new Date().toISOString()).run(); } catch (e) {} };
  if (!st.tech52) { try { await buildTech52(env, 'ASX'); st.tech52 = 1; await save(); } catch (e) {} }
  // w528: nightly scan-grades — the app's 50-field grading for every ticker,
  // cursor-stepped with a 6 s budget per firing; resumes next cron if unfinished.
  if (!st.scanGrades) { try { const g = await _scanGradeStep(env, 'ASX', 20000); /* w554: 6s->20s */ if (g && g.done) { st.scanGrades = 1; await save(); } } catch (e) {} }
  if (!st.warm) {
    // the warm is keyed to the PANTRY'S real latest day — never the wall clock —
    // so a late close can no longer cache old-day grades under the new day's key.
    try { const w = await _gradeWarm(env, 'ASX', day);
      const bad = (w && w.floors || []).some(f => /err|empty/.test(String(f)));
      if (w && !bad && (w.warmed > 0 || (w.floors || []).some(f => /had/.test(String(f))))) { st.warm = 1; await save(); }
    } catch (e) {}
  }
  // w541: PICKS WAIT FOR GRADING. A lane can only choose from sessions that are
  // fully graded, so running before the grader finishes guaranteed yesterday's
  // signals. Now the step simply doesn't tick until grading is done, and the
  // checklist re-fires it on the next cron tick \u2014 the same self-healing that
  // covers every other task here. The valve: after _PICK_WAIT_MAX unfinished
  // ticks we go ahead anyway and say so in the stamp, because a stalled grader
  // should delay the decision, never cancel it.
  if (!st.picks) {
    const waited = (st.pickWaits || 0);
    if (!st.scanGrades && waited < _PICK_WAIT_MAX) {
      st.pickWaits = waited + 1; await save();
    } else {
      const stale = !st.scanGrades;
      let okAll = true;
      try { await _pickLaneRun(env, 'ASX', 'fixed', null, stale); } catch (e) { okAll = false; }
      try { await _pickLaneRun(env, 'ASX', 'trail', null, stale); } catch (e) { okAll = false; }
      try { const RB0 = await _botRulesGet(env); if (RB0) await _pickLaneRun(env, 'ASX', '', RB0, stale); } catch (e) { okAll = false; }
      if (okAll) { st.picks = 1; st.picksStaleGrades = stale ? 1 : 0; await save(); }
    }
  }
  // w532: the market-wide announcement pull — deliberately AFTER the pick
  // lanes (announcements must never influence tonight's picks until they have
  // earned a tier) and BEFORE laRebuild (the heaviest step goes last).
  if (!st.ann) { try { const a = await _annPollMarket(env); if (a && a.ok) { st.ann = 1; await save(); } } catch (e) {} }
  // w535: step every synced account exactly once for this close \u2014 after the
  // owner's pick lanes (same engine, same day's grades), before the heavy la.
  if (!st.acct) { try { await _acctStepAll(env, 'ASX', day); st.acct = 1; await save(); } catch (e) {} }
  if (!st.la) { try {
      const g2 = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind('la_built').first();
      if (!g2 || String(g2.v) < day) { await laRebuild(env, 'ASX'); }
      st.la = 1; await save();
    } catch (e) {} }
  if (!st.r2) { try { await pantryToR2(env, 'ASX', day); st.r2 = 1; await save(); } catch (e) {} }
}

// ── w410: THREE-YEAR ERA STUDY ──────────────────────────────────────────────
// The two OLDER eras graded by the same engine, one admin press at a time.
// Live tiers stay recent-year-decided; these are the durability verdicts.
const _ERA = { SPAN: 250, ERAS: [2, 3], HOLDS: [5, 30], CHUNK_A: 150, CHUNK_B: 60, VER: 3,   // w417: VER 3 — per-window study (5d AND 30d); 10d skipped deliberately, it is nobody's working view
  WARM: 62 + 2 };   // predicate warm-up (a90/maxC need ~60 prior bars) + fencepost
function _eraSlice(series, era, hold){
  const n = series.length;
  const end = n - (era - 1) * _ERA.SPAN;               // newest bar of this era (exclusive)
  const start = Math.max(0, end - (_ERA.SPAN + hold + _ERA.WARM));
  if (end - start < _AUD.MINROWS) return null;
  return series.slice(start, end);
}
async function _eraLoadState(env){
  try { const v = await _getMeta(env, 'era_state'); if (v) { const st = JSON.parse(v); if (st && st.ver === _ERA.VER) return st; } } catch (e) {}
  // w417: a FINISHED VER-2 study was built with identical maths (clustered
  // strength + fixed lookbacks) — only ever at hold=5. Adopt it as the _h5
  // half rather than making Tony rebuild it a third time tonight.
  try {
    const v2 = await _getMeta(env, 'era_state');
    if (v2) { const old = JSON.parse(v2);
      if (old && old.ver === 2 && old.finished) {
        for (const e2 of _ERA.ERAS) {
          for (const kk of ['era_day', 'era_m', 'era_c']) {
            const val = await _getMeta(env, kk + e2);
            if (val != null) await _setMeta(env, kk + e2 + '_h5', val);
          }
        }
        const sum = await _getMeta(env, 'era_summary');
        if (sum != null) { try { const sj = JSON.parse(sum); sj.hold = 5; sj.ver = _ERA.VER; await _setMeta(env, 'era_summary_h5', JSON.stringify(sj)); } catch (e) {} }
        const st = { ver: _ERA.VER, phase: 'A', era: _ERA.ERAS[0], holdIx: 1, cursor: 0, finished: false, migrated5: true };
        await _setMeta(env, 'era_state', JSON.stringify(st));
        return st;
      }
    }
  } catch (e) {}
  return { ver: _ERA.VER, phase: 'A', era: _ERA.ERAS[0], holdIx: 0, cursor: 0, finished: false };
}
async function _eraJSON(env, key, fallback){
  try { const v = await _getMeta(env, key); if (v) return JSON.parse(v); } catch (e) {}
  return fallback;
}
async function _eraChunkSeries(env, tickers){
  // w411: D1 caps bound variables at 100 per statement — batch the IN list.
  const out = {};
  for (let i = 0; i < tickers.length; i += 90) {
    const batch = tickers.slice(i, i + 90);
    const ph = batch.map(() => '?').join(',');
    const rs = await env.MARKET_DB.prepare(
      "SELECT ticker,d,c,v FROM bars WHERE exch='ASX' AND ticker IN (" + ph + ") ORDER BY ticker,d"
    ).bind(...batch).all();
    for (const row of (rs.results || [])) {
      (out[row.ticker] || (out[row.ticker] = [])).push({ d: row.d, c: +row.c, v: +row.v });
    }
  }
  return out;
}
// One press of the builder. Returns progress; safe to call forever.
async function _eraBuildStep(env){
  // Honest gate: two full older eras need ~250*3 + warm-up days of pantry.
  const depth = await _eraJSON(env, 'depth', []);
  const asxDepth = (Array.isArray(depth) ? depth : []).filter(x => x && x.exch === 'ASX').map(x => +x.days)[0] || 0;
  if (asxDepth && asxDepth < 600) return { ok: true, blocked: 'pantry too shallow for a three-year study (' + asxDepth + ' days stored; needs ~750)' };
  let st = await _eraLoadState(env);
  if (st.finished) {
    const sum = await _eraJSON(env, 'era_summary_h' + _ERA.HOLDS[_ERA.HOLDS.length - 1], null);
    return { ok: true, finished: true, built: sum && sum.built, note: 'era study is built (windows: ' + _ERA.HOLDS.join('d + ') + 'd) — call with ?reset=1 to rebuild on fresher data' };
  }
  let tickers = await _eraJSON(env, 'era_tickers', null);
  if (!tickers) {
    const rs = await env.MARKET_DB.prepare("SELECT DISTINCT ticker FROM bars WHERE exch='ASX' ORDER BY ticker").all();
    tickers = (rs.results || []).map(r => r.ticker);
    await _setMeta(env, 'era_tickers', JSON.stringify(tickers));
  }
  const chunkN = (st.phase === 'A') ? _ERA.CHUNK_A : _ERA.CHUNK_B;
  const chunk = tickers.slice(st.cursor, st.cursor + chunkN);
  const seriesByT = await _eraChunkSeries(env, chunk);
  const era = st.era, hold = _ERA.HOLDS[st.holdIx || 0], _hs = '_h' + hold;   // w417: the window this pass is grading
  if (st.phase === 'A') {
    // benchmark pass: per-day mean of every tradeable share's capped outcome.
    const dayAcc = await _eraJSON(env, 'era_day' + era + _hs, {});
    const X = _auditNewCtx(chunk.map(t => ({ ticker: t, series: _eraSlice(seriesByT[t] || [], era, hold) }))
      .filter(sh => sh.series), hold, null);
    _auditRunAll(X);
    for (const dk in X.day) {
      const D = X.day[dk], a = dayAcc[dk] || (dayAcc[dk] = { n: 0, sum: 0 });
      a.n += D.n; a.sum += D.sum;
    }
    await _setMeta(env, 'era_day' + era + _hs, JSON.stringify(dayAcc));
  } else {
    // fire pass: same engine, excess priced against the FINISHED era benchmark.
    const dayAcc = await _eraJSON(env, 'era_day' + era + _hs, {});
    const mAcc = await _eraJSON(env, 'era_m' + era + _hs, {});
    const cAcc = await _eraJSON(env, 'era_c' + era + _hs, {});   // w416: {key:{day:[n,sum]}}
    // w412: NEVER trust a stored shape — a reset writes '{}', and a {} without
    // its keys container crashed phase B on the first fire it tried to file.
    if (!mAcc.keys) mAcc.keys = {};
    if (mAcc.from === undefined) mAcc.from = null;
    if (mAcc.to === undefined) mAcc.to = null;
    if (!mAcc.covered) mAcc.covered = 0;
    if (!mAcc.liqSkipped) mAcc.liqSkipped = 0;
    const X = _auditNewCtx(chunk.map(t => ({ ticker: t, series: _eraSlice(seriesByT[t] || [], era, hold) }))
      .filter(sh => sh.series), hold, null);
    _auditRunAll(X);
    mAcc.covered += X.covered; mAcc.liqSkipped += X.liqSkipped;
    for (const rec of X.recs) {
      const D = dayAcc[rec.d];
      const mean = (D && D.n) ? (D.sum / D.n) : 0;
      const exc = rec.out - mean;
      if (mAcc.from === null || rec.d < mAcc.from) mAcc.from = rec.d;
      if (mAcc.to === null || rec.d > mAcc.to) mAcc.to = rec.d;
      for (const k of rec.ks) {
        const m = mAcc.keys[k] || (mAcc.keys[k] = { n: 0, up: 0, upEx: 0, excSum: 0, excSq: 0 });
        m.n++; if (rec.out > 0) m.up++; if (exc > 0) m.upEx = (m.upEx || 0) + 1;
        m.excSum += exc; m.excSq += exc * exc;
        // w416: per-DAY totals, so the era's strength is measured the same way
        // the live card measures it.
        const ck = cAcc[k] || (cAcc[k] = {});
        const ca = ck[rec.d] || (ck[rec.d] = [0, 0]);
        ca[0]++; ca[1] += exc;
      }
    }
    await _setMeta(env, 'era_m' + era + _hs, JSON.stringify(mAcc));
    await _setMeta(env, 'era_c' + era + _hs, JSON.stringify(cAcc));   // w416
  }
  // advance the cursor / phase / era
  st.cursor += chunk.length;
  if (st.cursor >= tickers.length) {
    st.cursor = 0;
    const ei = _ERA.ERAS.indexOf(st.era);
    if (ei < _ERA.ERAS.length - 1) st.era = _ERA.ERAS[ei + 1];
    else if (st.phase === 'A') { st.phase = 'B'; st.era = _ERA.ERAS[0]; }
    else {
      // w417: this WINDOW is done — finalize its own summary under _h{hold},
      // then move to the next window (or finish the study).
      const eras = {};
      for (const e2 of _ERA.ERAS) {
        const mAcc = await _eraJSON(env, 'era_m' + e2 + _hs, {});
        if (!mAcc.keys) mAcc.keys = {}; // w412: same defence at finalize
        const cAcc = await _eraJSON(env, 'era_c' + e2 + _hs, {});   // w416
        const perKey = {};
        for (const k in mAcc.keys) {
          const m = mAcc.keys[k]; if (!m.n) continue;
          const edge = m.excSum / m.n;
          const varE = Math.max(0, (m.excSq / m.n) - (edge * edge));
          const tFire = (m.n > 1 && varE > 0) ? (edge / Math.sqrt(varE / m.n)) : 0;
          const _c = _clusterT(cAcc[k] || {});                 // w416: across DAYS
          const t = _c.t;
          perKey[k] = { n: m.n, up: m.up, upEx: m.upEx || 0, e: +edge.toFixed(3), t: +t.toFixed(2) };
        }
        eras[e2] = { from: mAcc.from, to: mAcc.to, covered: mAcc.covered || 0, liqSkipped: mAcc.liqSkipped || 0, perKey };
      }
      await _setMeta(env, 'era_summary' + _hs, JSON.stringify({ ver: _ERA.VER, hold: hold, built: new Date().toISOString().slice(0, 10), spanDays: _ERA.SPAN, eras }));
      _ERA_SUM_CACHE = {}; // w417: per-hold cache — drop it all
      const hi = (st.holdIx || 0);
      if (hi < _ERA.HOLDS.length - 1) { st.holdIx = hi + 1; st.phase = 'A'; st.era = _ERA.ERAS[0]; }
      else { st.finished = true; }
    }
  }
  await _setMeta(env, 'era_state', JSON.stringify(st));
  const passTotal = tickers.length * _ERA.ERAS.length;
  const passDone = _ERA.ERAS.indexOf(st.era) * tickers.length + st.cursor;
  const phasePct = Math.min(100, Math.round((passDone / Math.max(1, passTotal)) * 100));
  return { ok: true, finished: st.finished, phase: st.phase, era: st.era,
    doneTickers: st.cursor, totalTickers: tickers.length, phasePct,
    note: st.finished ? 'era study built' : ((st.migrated5 ? '5-day study adopted from tonight\u2019s build · ' : '') + _ERA.HOLDS[st.holdIx || 0] + '-day window · phase ' + st.phase + (st.phase === 'A' ? ' (benchmarks)' : ' (fires)') + ' · era ' + st.era + ' · ' + phasePct + '% of this phase') };
}
let _ERA_SUM_CACHE = {};
async function _eraSummaryCached(env, hold){
  // w417: serve the study graded on the REQUESTED window; if that window has
  // no finished study, fall back to the 5-day one (the app dims it and says
  // which window it came from — honest, never silent). A request for 10d
  // always gets the 5-day set for the same reason.
  const want = (hold === 30) ? 30 : 5;
  const tryHolds = (want === 30) ? [30, 5] : [5];
  for (const hh of tryHolds) {
    const ck = 'h' + hh;
    if (_ERA_SUM_CACHE[ck] === undefined) {
      _ERA_SUM_CACHE[ck] = await _eraJSON(env, 'era_summary_h' + hh, null);
      if (_ERA_SUM_CACHE[ck] === null && hh === 5)   // pre-w417 build not yet migrated: legacy key
        _ERA_SUM_CACHE[ck] = await _eraJSON(env, 'era_summary', null);
      if (_ERA_SUM_CACHE[ck] && !_ERA_SUM_CACHE[ck].hold) _ERA_SUM_CACHE[ck].hold = 5;
    }
    if (_ERA_SUM_CACHE[ck]) return _ERA_SUM_CACHE[ck];
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVER-SIDE MARKET HISTORY (v381) — nightly EOD ingest into D1.
// A cron fetches the whole-market quote list after the ASX close and upserts
// each symbol's daily bar into the D1 database bound as MARKET_DB. The app can
// then pull just the new day(s) instead of rebuilding a year of history itself.
// ALL of this is DORMANT until the MARKET_DB binding exists — without it the
// Worker behaves exactly as before, so pasting this changes nothing until you
// add the binding + cron triggers in the dashboard. Ingest is gated to the
// Sydney close and is DST-aware (see scheduled()).
// ═══════════════════════════════════════════════════════════════════════════
function sydneyNow(){
  const p = {};
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' })
      .formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  } catch (e) {}
  let hour = parseInt(p.hour, 10); if (hour === 24) hour = 0; // en-CA can emit 24:00
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { date: `${p.year}-${p.month}-${p.day}`, hour: hour || 0, minute: parseInt(p.minute, 10) || 0, dow };
}
const _num = (x) => { const n = parseFloat(x); return isFinite(n) ? n : null; };
function _parseQuoteRows(data) {
  // Match the app's own field handling: code/symbol + OHLCV, any casing.
  const rows = Array.isArray(data) ? data : ((data && (data.quotes || data.data || data.Quotes || data.result || data.results)) || []);
  const out = [];
  for (const q of rows) {
    const t = String(q.code || q.symbolCode || q.symbol || q.Code || q.Symbol || '').toUpperCase().trim();
    if (!t) continue;
    const c = _num(q.close != null ? q.close : q.Close);
    if (c == null) continue; // a bar with no close is useless
    out.push({ t, o: _num(q.open != null ? q.open : q.Open), h: _num(q.high != null ? q.high : q.High), l: _num(q.low != null ? q.low : q.Low), c, v: _num(q.volume != null ? q.volume : q.Volume) || 0 });
  }
  return out;
}
async function _upsertBars(env, exch, date, bars) {
  const sql = 'INSERT INTO bars (exch,ticker,d,o,h,l,c,v) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(exch,ticker,d) DO UPDATE SET o=excluded.o,h=excluded.h,l=excluded.l,c=excluded.c,v=excluded.v';
  const stmt = env.MARKET_DB.prepare(sql);
  const CHUNK = 200; let written = 0;
  for (let i = 0; i < bars.length; i += CHUNK) {
    const batch = bars.slice(i, i + CHUNK).map(b => stmt.bind(exch, b.t, date, b.o, b.h, b.l, b.c, b.v));
    if (batch.length) { await env.MARKET_DB.batch(batch); written += batch.length; }
    // w543: breathe between chunks. D1 is single-writer; ~22 back-to-back
    // batches of 200 held the write lock for the whole market, and every app
    // read arriving during the 5:00pm / 6:30pm Sydney passes queued behind
    // them and timed out (Tony's screenshot, 19 Aug 17:00:50: 'Loaded 0
    // shares... the data proxy was slow'). 150ms per chunk ≈ +3s on a cron
    // job nobody is waiting for, and readers get through between batches.
    if (i + CHUNK < bars.length) await new Promise(r => setTimeout(r, 150));
  }
  return written;
}
async function _setMeta(env, k, v) {
  await env.MARKET_DB.prepare('INSERT INTO meta (k,v,updated) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated=excluded.updated')
    .bind(k, String(v), new Date().toISOString()).run();
}
async function _getMeta(env, k) {
  try { const m = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind(k).first(); return (m && m.v) || null; }
  catch (e) { return null; }
}
// w523: THE DAILY FEED IS EODHD NOW. EODDATA_KEY vanished from the secrets on
// 13 Aug (the same dashboard session as the w521 paste, by the timeline) and
// every daily ingest since silently returned 'no key' — the 13th's bars exist
// only because the ten-year backfill wrote them at ~8pm with EODHD's
// PRELIMINARY volumes (GML showed 1.7M against a larger final print; late
// trades and crossings keep reporting for hours after the ASX close).
// The router below prefers EODHD's one-call whole-exchange endpoint and keeps
// the old EODData body as a fallback should its key ever be restored.
async function ingestDay(env, date, pass, exch) {
  if (env && env.EODHD_KEY) return await _eodhdIngestDay(env, date, pass, exch);
  return await _eoddataIngestDay(env, date, pass, exch);
}
async function _eodhdIngestDay(env, date, pass, exch) {
  exch = exch || 'ASX';
  if (NYSE_RETIRED && String(exch).toUpperCase() === 'NYSE') return { ok: false, exch, skipped: 'NYSE is retired on this server' };
  if (!env.MARKET_DB) return { ok: false, error: 'no MARKET_DB binding' };
  if (!env.EODHD_KEY) return { ok: false, error: 'no EODHD_KEY secret' };
  let arr;
  try {
    const r = await fetch('https://eodhd.com/api/eod-bulk-last-day/AU?api_token=' + env.EODHD_KEY + '&fmt=json&date=' + encodeURIComponent(date), { headers: { accept: 'application/json' } });
    if (!r.ok) return { ok: false, error: 'eodhd http ' + r.status };
    arr = await r.json();
  } catch (e) { return { ok: false, error: 'eodhd fetch failed: ' + (e && e.message || e) }; }
  if (!Array.isArray(arr)) return { ok: false, error: 'eodhd: unexpected shape' };
  let written = 0; const stmts = [];
  for (const b of arr) {
    const tk = String(b.code || '').trim().toUpperCase();
    const d = String(b.date || '').slice(0, 10);
    if (!tk || d !== date) continue;
    const rawC = +b.close || 0;
    const c = +(b.adjusted_close != null ? b.adjusted_close : b.close) || 0;
    const v = +b.volume || 0;
    if (!(c > 0)) continue;
    // same basis discipline as the w520 backfill: o/h/l scaled onto the
    // adjusted close, bands never excluding the close they belong to.
    const adj = (rawC > 0) ? (c / rawC) : 1;
    const sc = (x) => { const r2 = +x; return (isFinite(r2) && r2 > 0) ? +(r2 * adj).toFixed(6) : null; };
    let o = sc(b.open), h = sc(b.high), l = sc(b.low);
    if (h != null && h < c) h = c;
    if (l != null && l > c) l = c;
    if (h != null && l != null && l > h) { const t2 = h; h = l; l = t2; }
    stmts.push(env.MARKET_DB.prepare('INSERT INTO bars (exch,ticker,d,o,h,l,c,v) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(exch,ticker,d) DO UPDATE SET o=COALESCE(excluded.o,bars.o), h=COALESCE(excluded.h,bars.h), l=COALESCE(excluded.l,bars.l), c=excluded.c, v=excluded.v').bind(exch, tk, d, o, h, l, c, v));
    written++;
    if (stmts.length >= 150) { await env.MARKET_DB.batch(stmts.splice(0)); await new Promise(r => setTimeout(r, 120)); } // w544: 40-row batches turned one file into ~58 subrequests — past the ~50/invocation platform cap, so every close tick died at batch ~48 (19 Aug: bars frozen at 1,909 = 40x47.7 for 3+ hours, grading and lanes starved behind it). 150 keeps the sleeps (the actual cure for the 17:00 read-starvation — the lock releases between batches) at ~16 subrequests per file.
  }
  if (stmts.length) await env.MARKET_DB.batch(stmts);
  if (!written) return { ok: true, date, pass, count: 0, note: 'no rows (EOD data not published yet?)' };
  try {
    const _cur = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind('latest_' + exch).first();
    if (!_cur || !_cur.v || String(_cur.v) < date) await _setMeta(env, 'latest_' + exch, date);
  } catch (e) { await _setMeta(env, 'latest_' + exch, date); }
  await _setMeta(env, 'ingest_' + exch + '_' + date, 'eodhd-' + pass + ':' + written);
  if (pass !== 'backfill') { try { await _setMeta(env, 'last_ingest_' + exch, date + '|' + pass); } catch (e) {} }
  return { ok: true, exch, date, pass, count: written };
}
async function _eoddataIngestDay(env, date, pass, exch) {
  // w411: the retirement is enforced where the rows are written, not only at
  // the callers — an old deployment's crawler re-bought 128 days of NYSE on
  // 30 Jul. Belt and braces: this copy will never write NYSE bars again.
  if (NYSE_RETIRED && String(exch).toUpperCase() === 'NYSE') return { ok: false, exch, skipped: 'NYSE is retired on this server' };
  exch = exch || 'ASX';
  if (!env.MARKET_DB) return { ok: false, error: 'no MARKET_DB binding' };
  if (true) return { ok: false, error: 'eoddata retired (w545) — fallback list path serves' }; // w545: api.eoddata.com is dead; this first-hop fetch hung every app load for seconds before the fallback engaged. Fail instantly instead.
  if (!env.EODDATA_KEY) return { ok: false, error: 'no EODDATA_KEY secret' };
  const upstream = 'https://api.eoddata.com/quote/list/' + encodeURIComponent(exch) + '?apiKey=' + env.EODDATA_KEY + '&DateStamp=' + encodeURIComponent(date);
  let data, _httpStatus = null, _rawSnippet = null;
  try {
    const r = await fetch(upstream, { headers: { 'Accept': 'application/json' } });
    _httpStatus = r.status;
    const txt = await r.text();
    _rawSnippet = String(txt || '').slice(0, 300); // w463: kept only on failure below — never logged on a clean parse
    data = JSON.parse(txt);
  } catch (e) {
    // w463 — Tony's 10-year backfill push stalled right after the crawler's
    // OLD 760-day target, and the only message available was "the store is
    // as far back as the data goes, or the provider refused" — genuinely
    // unable to tell which, because this catch threw away the one thing
    // that would say so: what EODData actually sent back. A parse failure
    // almost always means the upstream response wasn't JSON at all (a plan
    // limit, a rate limit, an auth error, or an outage all render as HTML or
    // plain text) — so the real answer was always in `txt`, just never kept.
    const detail = { ok: false, error: 'upstream fetch/parse failed', date, pass, httpStatus: _httpStatus, rawSnippet: _rawSnippet };
    detail.storedAt = new Date().toISOString();
    try { await _setMeta(env, 'bf_lasterr_' + exch, JSON.stringify(detail)); } catch (e2) {}
    return detail;
  }
  const bars = _parseQuoteRows(data);
  if (!bars.length) return { ok: true, date, pass, count: 0, note: 'no rows (EOD data not published yet?)' };
  const written = await _upsertBars(env, exch, date, bars);
  // v389: the `latest_` pointer must NEVER walk backwards. The depth crawler
  // ingests OLD days, and this line used to rewrite the pointer to whatever old
  // day had just been filled — so the app was told the newest close was weeks
  // ago, stamped every share "fresh" at that date, and quietly stopped
  // downloading. Only a genuinely newer close may advance the pointer now.
  //
  // w397: ...and it must not walk FORWARDS onto a day that barely exists. The
  // 5pm `early` pass lands before the provider has published, so it was moving
  // the pointer on 82 rows out of 4,300 — telling the app today's close had
  // arrived while 4,218 shares still held Monday's price. Every trading
  // afternoon, healing itself at 6:30pm before anyone could catch it.
  //
  // So the day has to look like a day: at least 60% of the last complete day
  // already stored. A short session is still four thousand shares; 82 is a day
  // that has not been published yet. The bars are written regardless — partial
  // data is real data — but the app is not told today is done until it is.
  let _advanced = true;
  try {
    const _cur = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind('latest_' + exch).first();
    const _prev = (_cur && _cur.v) ? String(_cur.v) : '';
    if (!_prev || String(date) > _prev) {
      let _need = 0;
      if (_prev) {
        try {
          const _c = await env.MARKET_DB.prepare('SELECT COUNT(*) AS n FROM bars WHERE exch=? AND d=?').bind(exch, _prev).first();
          _need = Math.floor(((_c && _c.n) || 0) * 0.6);
        } catch (e) { _need = 0; }
      }
      // No previous day to measure against → bootstrapping an empty store,
      // which a rule about its contents must not block.
      if (written >= _need) await _setMeta(env, 'latest_' + exch, date);
      else _advanced = false;
    }
  } catch (e) { await _setMeta(env, 'latest_' + exch, date); }
  // Say which happened. A row count alone leaves the next reader inferring it.
  await _setMeta(env, 'ingest_' + exch + '_' + date, pass + (_advanced ? '' : '-partial') + ':' + written);
  // v390: a single row that answers "when did a real close last land?" without
  // scanning per-day keys. The depth crawler is excluded on purpose — it walks
  // backwards, so it says nothing about whether we are keeping up.
  if (pass !== 'backfill') { try { await _setMeta(env, 'last_ingest_' + exch, date + '|' + pass); } catch (e) {} }
  return { ok: true, exch, date, pass, count: written };
}
// Which ingest pass (if any) a cron firing maps to, given the SYDNEY local time.
// Pure + testable. Weekdays only; ~5:00pm = early look, ~6:30pm = authoritative.
function _ingestPass(t) {
  if (!t || t.dow === 0 || t.dow === 6) return null;         // ASX trades Mon–Fri
  if (t.hour === 17 && t.minute < 15) return 'early';        // ~5:00pm Sydney
  if (t.hour === 18 && t.minute >= 15 && t.minute < 45) return 'final'; // ~6:30pm Sydney
  return null;                                               // any other firing (wrong DST offset) → skip
}
// v384: same idea for New York — the NYSE closes 16:00 ET; EOD data lands after.
function nyNow(){
  const p = {};
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' })
      .formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  } catch (e) {}
  let hour = parseInt(p.hour, 10); if (hour === 24) hour = 0;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { date: `${p.year}-${p.month}-${p.day}`, hour: hour || 0, minute: parseInt(p.minute, 10) || 0, dow };
}
function _ingestPassNY(t) {
  if (!t || t.dow === 0 || t.dow === 6) return null;         // NYSE trades Mon–Fri
  if (t.hour === 17 && t.minute < 15) return 'early';        // ~5:00pm New York
  if (t.hour === 18 && t.minute >= 15 && t.minute < 45) return 'final'; // ~6:30pm New York
  return null;
}
// ── v390 SELF-HEALING CATCH-UP ─────────────────────────────────────────────
// The two passes above only fire when a cron firing lands inside a narrow
// window of LOCAL time — 15 minutes wide for `early`, 30 for `final`. Cloudflare
// cron is UTC-only, so covering both markets across both DST regimes takes eight
// separate firings, and today all eight are configured (verify_worker_v390.mjs
// holds the matrix). The schedule is CORRECT. What this guards is the cost of it
// being wrong by even one entry: a pass that never runs raises no error, and
// since v389 made the `latest_` pointer monotonic, a stall no longer corrects
// itself on the next lucky tick. It just stops, quietly, looking healthy.
//
// So we stop relying on the clock alone. On every firing we also ask a question
// the clock cannot get wrong — "what is the most recent trading day this
// exchange has finished, and do we already hold it?" — and fetch it if we don't.
// A late firing, a dropped one, an edited cron list, a future DST rule change,
// an upstream 5xx at exactly the wrong minute: all heal on the next tick.
// This is a net under a schedule that works, not a patch for one that doesn't.
const _INGEST = { CLOSE_HOUR: 17, MAX_TRIES: 24 /* w523: 6 died in one bad evening (13 Aug); 24 ≈ half a day of firings — still stops holiday spam, survives an outage */ };
function _lastClosedDay(t, closeHour) {   // pure: newest LOCAL weekday whose close has passed
  if (!t || !t.date || t.dow == null) return null;
  const weekday = t.dow >= 1 && t.dow <= 5;
  if (weekday && t.hour >= closeHour) return t.date;   // today's close is behind us
  return _bfPrevWeekday(t.date);                       // otherwise the weekday before
}
async function _ingestCatchUp(env, exch, t) {
  if (!env.MARKET_DB || (!env.EODDATA_KEY && !env.EODHD_KEY)) return null;   // w523: either feed
  const day = _lastClosedDay(t, _INGEST.CLOSE_HOUR);
  if (!day) return null;
  if (await _getMeta(env, 'ingest_' + exch + '_' + day)) return null;   // already held
  // One marker row per exchange, self-resetting when the day rolls over. A market
  // holiday returns no rows for ever, so give up after a few tries rather than
  // asking upstream the same dead question on every firing until midnight.
  const mark = String((await _getMeta(env, 'catchup_' + exch)) || '');
  const cut = mark.indexOf(':');
  const tries = (cut > 0 && mark.slice(0, cut) === day) ? (parseInt(mark.slice(cut + 1), 10) || 0) : 0;
  if (tries >= _INGEST.MAX_TRIES) return null;
  try { await _setMeta(env, 'catchup_' + exch, day + ':' + (tries + 1)); } catch (e) {}
  return await ingestDay(env, day, 'auto', exch);
}
// Is the store keeping up? One trading day of slack covers the gap between the
// close and publication. Reported on /health so a stall is VISIBLE — the whole
// cost of the v455 incident was that a stalled feed looked perfectly healthy.
// \u2500\u2500 w552: NIGHTLY PICKS EMAIL \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// The admin page already shows the night's picks; this mails the same table so
// nobody has to remember to look. Sent via Resend (RESEND_KEY + PICKS_EMAIL_TO
// secrets; optional PICKS_EMAIL_FROM once a domain is verified - the default
// onboarding@resend.dev delivers only to the Resend account owner's address).
async function _picksMailBuild(env, day) {
  const lanes = [
    { label: '\ud83e\udd16 Your rules (the bot lane - your app places these at the next open)', table: 'bot_rules_picks' },
    { label: '\ud83d\udccc Current rules', table: 'new_rules_picks' },
    { label: '\ud83e\udea3 Trailing rules', table: 'trail_rules_picks' }
  ];
  // w553: one language everywhere - the same names the app and admin panel use.
  const _sigNames = { bo: '\ud83d\ude80 Breakout', inf: '\ud83d\udd75\ufe0f Informed?', inst: '\ud83c\udfe6 Big money?', cx: '\u2934 MA cross', di: '\ud83d\udcc9 Quiet selling?', vr: '\ud83e\udd47 Vol record', blk: '\ud83d\udd37 Block day' };
  const sigFull = k => String(k || '').split('+').map(c => _sigNames[c.trim()] || c.trim()).filter(Boolean).join(' + ');
  const px = n => (n == null ? '\u2014' : ('$' + (+n).toFixed(3).replace(/0$/, '').replace(/0$/, '').replace(/\.$/, '')));
  const money = n => (n == null ? '\u2014' : ('$' + (+n).toFixed(2)));
  let count = 0; const secs = [];
  for (const ln of lanes) {
    let rows = [];
    try {
      const rs = await env.MARKET_DB.prepare('SELECT ticker,score,edge,tier,evidence_key,limit_price,target_price,stop_price,trail_pct,qty FROM ' + ln.table + " WHERE exch='ASX' AND first_seen_day=? ORDER BY score DESC").bind(day).all();
      rows = (rs && rs.results) || [];
    } catch (e) {}
    // w556: the picks from earlier days still on the field - suggested, not yet
    // filled or retired. The panel shows them; the email now does too.
    let standing = [];
    try {
      const ss = await env.MARKET_DB.prepare('SELECT ticker,score,edge,tier,evidence_key,limit_price,target_price,stop_price,trail_pct,qty,first_seen_day FROM ' + ln.table + " WHERE exch='ASX' AND status='suggested' AND first_seen_day<? ORDER BY first_seen_day DESC, score DESC LIMIT 12").bind(day).all();
      standing = (ss && ss.results) || [];
    } catch (e) {}
    count += rows.length;
    let body;
    if (!rows.length) {
      body = '<p style="color:#8a8f98;margin:4px 0 14px">\u2014 no picks under these rules for ' + day + '.</p>';
    } else {
      const tr = rows.map(r => {
        const size = (r.limit_price != null && r.qty != null) ? money(r.limit_price * r.qty) : '\u2014';
        const note = sigFull(r.evidence_key) + ' (' + String(r.tier || '') + ', score ' + (r.score == null ? '?' : (+r.score).toFixed(1)) + ', edge ' + (r.edge == null ? '?' : ((+r.edge >= 0 ? '+' : '') + (+r.edge).toFixed(2))) + ')';
        const exitCell = (r.trail_pct != null && +r.trail_pct > 0) ? ('trail ' + (+r.trail_pct) + '%') : (px(r.target_price) + ' / ' + px(r.stop_price));
        return '<tr><td style="padding:5px 10px;font-weight:700">' + r.ticker + '</td><td style="padding:5px 10px">' + px(r.limit_price) + '</td><td style="padding:5px 10px">' + exitCell + '</td><td style="padding:5px 10px;text-align:right">' + (r.qty == null ? '\u2014' : r.qty) + '</td><td style="padding:5px 10px;text-align:right">' + size + '</td><td style="padding:5px 10px;color:#8a8f98;font-size:12px">' + note + '</td></tr>';
      }).join('');
      body = '<table style="border-collapse:collapse;font-size:14px;margin:4px 0 14px"><tr style="color:#8a8f98;font-size:12px;text-align:left"><th style="padding:5px 10px">Ticker</th><th style="padding:5px 10px">Limit</th><th style="padding:5px 10px">Target / Stop</th><th style="padding:5px 10px">Qty</th><th style="padding:5px 10px">Order size</th><th style="padding:5px 10px">Evidence</th></tr>' + tr + '</table>';
    }
    if (standing.length) {
      const st = standing.map(r => {
        const size = (r.limit_price != null && r.qty != null) ? money(r.limit_price * r.qty) : '\u2014';
        const exitCell = (r.trail_pct != null && +r.trail_pct > 0) ? ('trail ' + (+r.trail_pct) + '%') : (px(r.target_price) + ' / ' + px(r.stop_price));
        return '<tr><td style="padding:4px 10px;font-weight:700">' + r.ticker + '</td><td style="padding:4px 10px;color:#8a8f98;font-size:12px">picked ' + String(r.first_seen_day || '') + '</td><td style="padding:4px 10px">' + px(r.limit_price) + '</td><td style="padding:4px 10px">' + exitCell + '</td><td style="padding:4px 10px;text-align:right">' + (r.qty == null ? '\u2014' : r.qty) + '</td><td style="padding:4px 10px;text-align:right">' + size + '</td></tr>';
      }).join('');
      body += '<p style="margin:0 0 2px;font-size:12px;color:#8a8f98">\u267b Still standing from earlier days \u2014 suggested before, not yet filled, retire after 5 trading days:</p>'
        + '<table style="border-collapse:collapse;font-size:13px;margin:2px 0 14px"><tr style="color:#8a8f98;font-size:11px;text-align:left"><th style="padding:4px 10px">Ticker</th><th style="padding:4px 10px">Picked</th><th style="padding:4px 10px">Limit</th><th style="padding:4px 10px">Target / Stop</th><th style="padding:4px 10px">Qty</th><th style="padding:4px 10px">Order size</th></tr>' + st + '</table>';
    }
    secs.push('<h3 style="margin:16px 0 4px;font-size:15px">' + ln.label + '</h3>' + body);
  }
  const subject = 'Insight picks \u00b7 ' + day + ' \u00b7 ' + (count ? (count + ' candidate' + (count === 1 ? '' : 's')) : 'no picks tonight');
  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1f28;max-width:680px">'
    + '<h2 style="margin:0 0 2px">\ud83d\udcca Insight Trading \u2014 picks for ' + day + '</h2>'
    + '<p style="color:#8a8f98;margin:0 0 10px;font-size:13px">Decided at the close by the server\u2019s pick lanes on the fully graded market.</p>'
    + secs.join('')
    + '<p style="color:#8a8f98;font-size:12px;margin-top:16px">The bot lane\u2019s picks are placed by your app as dated practice limit orders at the next open, subject to your max-positions cap and available cash. Paper trading \u2014 practice only, not financial advice.</p>'
    + '</div>';
  return { subject, html, count };
}
async function _picksMailSend(env, day) {
  if (!env.RESEND_KEY || !env.PICKS_EMAIL_TO) return { ok: false, skip: 'not configured - add RESEND_KEY and PICKS_EMAIL_TO secrets in the Cloudflare dashboard' };
  if (!day) return { ok: false, skip: 'no day to report' };
  const b = await _picksMailBuild(env, day);
  const from = env.PICKS_EMAIL_FROM || 'Insight Trading <onboarding@resend.dev>';
  let resp;
  try {
    resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [String(env.PICKS_EMAIL_TO)], subject: b.subject, html: b.html })
    });
  } catch (e) { return { ok: false, status: 0, detail: String(e && e.message || e).slice(0, 200) }; }
  const ok = resp.status >= 200 && resp.status < 300;
  let detail = ''; try { if (!ok) detail = (await resp.text()).slice(0, 300); } catch (e) {}
  return { ok, status: resp.status, detail, picks: b.count };
}

async function _ingestFresh(env) {
  const out = {};
  if (!env.MARKET_DB) return out;
  for (const row of [['ASX', sydneyNow()], ['NYSE', nyNow()]]) {
    try {
      const have = await _getMeta(env, 'latest_' + row[0]);
      const want = _lastClosedDay(row[1], _INGEST.CLOSE_HOUR);
      out[row[0]] = !!(have && want && String(have) >= _bfPrevWeekday(want));
    } catch (e) { out[row[0]] = null; }
  }
  return out;
}
// v384 DEPTH CRAWLER — the selectable outcome windows and the whole report card
// get stronger with deeper history; this walks backwards a little every firing.
// w395: two old days a firing put a year of history about three months away,
// which made the pantry — not the code — the thing blocking the reports from
// moving to the server. Eight a firing, plus /admin/backfill for a sprint.
// w399: New York aimed at 220 days. A 52-week high needs 252, so it would have
// reported itself full and still been short of the only thing the target is
// there to enable — measured: 0 of 3,301 NY tickers had 252 bars at 220 days.
// w406: NYSE retired — the crawler now serves one exchange, deeply. 760
// trading days ≈ 3 calendar years; the walk-back happens automatically at
// ~PER_FIRING trading days per cron firing (one whole-market call per day),
// so the two extra years arrive over a few nights on the quota NYSE freed.
// w462 — Tony's EODData plan covers 10 years; the old 760-day target was
// this crawler's own self-imposed ceiling, not a limit from the provider.
// Raised to 2600 (comfortably past 10 calendar years once _bfFloorDate's
// existing calendar-conversion and holiday slack are applied). PER_FIRING
// stays at 8 deliberately — the automatic daily cron does NOT speed up, so
// reaching full depth is still something Tony drives himself via /admin/backfill
// or "Fill until full", a few real, billed EODData calls at a time, on purpose.
const _BF = { TARGET: { ASX: 2600 }, PER_FIRING: 8 };
// How many trading days a report that ranks on the 52-week high needs.
const _DEEP_DAYS = 252;
function _bfPrevWeekday(dstr) { // pure: the previous Mon–Fri calendar day
  const d = new Date(dstr + 'T12:00:00Z');
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}
function _bfFloorDate(target, now) { // pure: how far back the crawl should ever go
  const d = now ? new Date(now) : new Date();
  d.setUTCDate(d.getUTCDate() - Math.ceil(target * 7 / 5) - 20); // trading→calendar days + holiday slack
  return d.toISOString().slice(0, 10);
}
async function _backfillTick(env) {
  return; // w545: RETIRED. The 10-year ASX backfill completed (every decade study runs on 2016+ data),
  // but bf_cursor_ASX sat at 2022-07-14 — so EVERY scheduled tick ended with the crawler bulk-ingesting
  // historical days (each a full-market file, 14+ D1 batches) straight past the ~50-subrequest cap.
  // That executed the scheduler mid-tick, around the clock: the 13-hour freeze of 19-20 Aug, the
  // days of slowness before it. The pantry is full; the crawler's job is done; it rests.
  if (!env.MARKET_DB || !env.EODDATA_KEY) return;
  const today = new Date().toISOString().slice(0, 10);
  const cand = [];
  for (const ex of Object.keys(_BF.TARGET)) {
    const floor = _bfFloorDate(_BF.TARGET[ex]);
    let cur = null;
    try { const m = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind('bf_cursor_' + ex).first(); cur = m && m.v; } catch (e) {}
    if (!cur) { // first ever look: start from the oldest stored day (or today)
      try { const r = await env.MARKET_DB.prepare('SELECT MIN(d) AS o FROM bars WHERE exch=?').bind(ex).first(); cur = (r && r.o) || today; } catch (e) { cur = today; }
    }
    if (cur > floor) cand.push({ ex, cur, floor, prog: (Date.parse(today) - Date.parse(cur)) / Math.max(1, Date.parse(today) - Date.parse(floor)) });
  }
  if (!cand.length) return; // every exchange at depth — the crawler is done
  cand.sort((a, b) => a.prog - b.prog); // help whichever is furthest behind
  const p = cand[0];
  let cur = p.cur;
  for (let i = 0; i < _BF.PER_FIRING; i++) {
    const day = _bfPrevWeekday(cur);
    if (day < p.floor) break;
    let out = null;
    try { out = await ingestDay(env, day, 'backfill', p.ex); } catch (e) { break; }
    if (!out || out.ok !== true) break; // plan/outage trouble: stop, keep cursor, retry next firing
    cur = day;                          // holidays come back ok with 0 rows — walk past them
    try { await _setMeta(env, 'bf_cursor_' + p.ex, cur); } catch (e) {}
  }
  await _refreshDepth(env);
}

// w399: how many distinct trading days we hold, per exchange, cached in meta.
// Counting them reads about 1.8 million rows — fine once a firing, wrong on
// every request, which is why /reports reads the cached number instead.
async function _refreshDepth(env) {
  if (!env.MARKET_DB) return;
  try {
    const r = await env.MARKET_DB.prepare(
      'SELECT exch, COUNT(DISTINCT d) AS n FROM bars GROUP BY exch').all();
    for (const x of ((r && r.results) || [])) {
      if (x && x.exch) await _setMeta(env, 'days_' + x.exch, String(x.n || 0));
    }
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// NEWS FEED (v386) — SHORTLIST-SCOPED, not a market crawl.
//
// The honest problem this fixes: the app's "had news" flag is an ESTIMATE
// inferred from price and volume. It is often right and sometimes badly
// wrong. This stores REAL headlines — but only for shares the user actually
// holds, watches, or was picked today. That keeps the whole thing to roughly
// 40 tickers a day, one poll each, from per-ticker feeds that are published
// for syndication. No bulk scraping of anybody's website.
//
// DORMANT until the plain (non-secret) variable NEWS_ON = 1 exists.
// ═══════════════════════════════════════════════════════════════════════════
const _NEWS = {
  MAX_PER_FIRING: 12,   // tickers polled per cron firing (4 firings ≈ 48/day)
  MAX_WATCH: 400,       // hard ceiling on the registered shortlist
  KEEP_DAYS: 400,       // how long headlines are kept (matches the 1-year cards)
  MIN_GAP_H: 20,        // never re-poll the same ticker inside this many hours
  PER_TICKER: 12,       // headlines kept per poll
  ENOUGH: 3,            // this many from one source and we don't ask the next
  MAX_BODY: 512 * 1024, // never parse more feed than this (a truncated or HTML
                        // response is otherwise unbounded work for the parser)
  RETRY_H: 2,           // after a total fetch failure, try again this soon
};
function _newsOn(env) { return !!(env && env.MARKET_DB && String((env && env.NEWS_ON) || '') === '1'); }
function _newsExch(x) { const e = String(x || 'ASX').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); return e || 'ASX'; }
function _newsTicker(x) { return String(x || '').toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 12); }

// ---- tiny XML/RSS reader. Workers have no DOMParser, so this is deliberate,
//      boring string work: unwrap CDATA, strip tags, decode entities. ----
function _xClean(s) {
  s = String(s == null ? '' : s);
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(+d); } catch (e) { return ' '; } });
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ' '; } });
  s = s.replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&lsquo;|&rsquo;/gi, "'")
       .replace(/&ldquo;|&rdquo;/gi, '"').replace(/&nbsp;/gi, ' ').replace(/&#39;/g, "'")
       .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&'); // &amp; LAST
  // Decoding can RE-CREATE tags (&lt;img onerror=…&gt;), so strip once more.
  // Headlines come from third parties and end up rendered in the app: this is
  // the right place to make sure a title is only ever text.
  // Just neutralise the brackets. A tag cannot exist without them, and unlike a
  // second tag-strip this can't swallow real text out of "revenue <$1m".
  s = s.replace(/[<>]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}
function _xTag(block, tag) {
  const m = block.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return m ? _xClean(m[1]) : '';
}
function _newsDate(s) {
  const t = Date.parse(String(s || ''));
  const now = Date.now();
  if (!isFinite(t) || t <= 0) return '';                       // undated → caller skips it
  if (t > now + 36e5) return new Date(now).toISOString();       // mildly future-dated → clamp
  return new Date(t).toISOString();
}
// The day an announcement belongs to is the EXCHANGE's day, not UTC's. ASX
// announcements land 07:00-10:00 Sydney — which is the PREVIOUS day in UTC. Get
// this wrong and the report card credits the news to the day before the move,
// which is worse than the estimate it replaces.
const _newsTZ = { ASX: 'Australia/Sydney', NYSE: 'America/New_York', NASDAQ: 'America/New_York', AMEX: 'America/New_York' };
const _newsFmt = {};
function _newsLocalDay(exch, iso) {
  const tz = _newsTZ[exch] || 'UTC';
  try {
    if (!_newsFmt[tz]) _newsFmt[tz] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const d = _newsFmt[tz].format(new Date(iso));
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : String(iso).slice(0, 10);
  } catch (e) { return String(iso).slice(0, 10); }
}
// Deliberately NOT a lazy `<item>…</item>` pair match: on a truncated feed with
// no closing tags that is quadratic (a 512KB body measured at 3+ seconds of CPU,
// which would blow the Worker's budget). Instead: find the item STARTS, and treat
// each item as the text up to the next start. Linear, and a malformed feed costs
// the same as a good one.
function _rssItems(xml) {
  const out = [];
  const s = String(xml || '');
  const open = /<(item|entry)(?=[\s>])/gi;
  const starts = [];
  let m;
  while ((m = open.exec(s)) && starts.length < 200) starts.push([m.index, m[1].toLowerCase()]);
  const low = starts.length ? s.toLowerCase() : '';
  for (let k = 0; k < starts.length && out.length < 40; k++) {
    const at = starts[k][0];
    // stop at the next item OR this item's own close tag, whichever comes first —
    // otherwise the LAST item swallows the channel's own <title>/<link> and we
    // invent a headline for a day that had none.
    let hardEnd = (k + 1 < starts.length) ? starts[k + 1][0] : s.length;
    const close = low.indexOf('</' + starts[k][1] + '>', at);
    if (close >= 0 && close < hardEnd) hardEnd = close;
    const b = s.slice(at, Math.min(hardEnd, at + 20000));
    const title = _xTag(b, 'title');
    if (!title) continue;
    let link = _xTag(b, 'link');
    if (!link) { const l = b.match(/<link[^>]*href=["']([^"']+)["']/i); if (l) link = _xClean(l[1]); }
    const dt = _xTag(b, 'pubDate') || _xTag(b, 'published') || _xTag(b, 'updated') || _xTag(b, 'dc:date');
    out.push({ title, link, ts: _newsDate(dt) });
  }
  return out;
}
function _newsJsonItems(txt) {
  let d; try { d = JSON.parse(txt); } catch (e) { return []; }
  const rows = (d && Array.isArray(d.data)) ? d.data : [];
  return rows.map(r => ({ title: _xClean(r && r.title), link: String((r && r.url) || ''), ts: _newsDate(r && r.published_at) }));
}

// ---- what kind of news, and how much it should count for. Ordered: the
//      first pattern that matches wins, so market-moving things sit at the
//      top. `weight` is a MATERIALITY GUESS, never a certainty — the app
//      labels it as an estimate, exactly like every other score we publish. ----
const _NEWS_KIND = [
  { k: 'halt',     w: 1.00, re: /\b(trading halt|voluntary suspension|suspension from (official )?quotation|reinstate\w* to (official )?quotation|pause in trading)\b/i },
  { k: 'takeover', w: 1.00, re: /\b(takeover|scheme of arrangement|merger|acquisition of|agrees? to acquire|to acquire|\bacquir(e|es|ed|ing)\b|bid for|indicative (proposal|offer)|nbio|strategic review)\b/i },
  { k: 'results',  w: 0.90, re: /\b((half|full|first|second)[- ]year|quarterly|interim|annual|fy\s?\d{2})\s+(results|report|earnings|production|output)|\b(results|earnings)\s+(for|announcement|release|presentation)|\bappendix\s?4[cde]\b|\bpreliminary final report\b|\bactivities report\b|\b(reports?|posts?|delivers?|records?|lifts?|boosts?)\b[^.]{0,45}\b(production|output|shipments|revenue|profit|earnings|loss)\b|\bq[1-4]\b.*\b(production|output|results|shipments)\b|\b(production|output)\s+(report|update|recovers?|rises?|falls?|climbs?|slips?)\b/i },
  { k: 'guidance', w: 0.90, re: /\b(guidance|earnings (upgrade|downgrade)|profit (upgrade|downgrade|warning)|trading update|outlook (upgrade|downgrade|cut|raise)|revises? (its )?(forecast|outlook))\b/i },
  { k: 'capital',  w: 0.85, re: /\b(capital raising|equity raising|placement|entitlement offer|rights issue|share purchase plan|\bspp\b|prospectus|convertible note|buy-?back|special dividend|dividend|distribution|dilut\w+)\b/i },
  // a board committing hundreds of millions is material even when the word
  // "capital" never appears — "Greenlights $900 Million Pilbara Expansion"
  { k: 'project',  w: 0.80, re: /\b(approves?|approved|greenlights?|green-?lit|commits?|committed|sanctions?|earmarks?)\b[^.]{0,60}?\$\s?[\d.,]+\s?(m|bn|b|million|billion)?\b|\$\s?[\d.,]+\s?(m|bn|billion|million)\b[^.]{0,40}\b(expansion|project|mine|plant|development|refinery|smelter|terminal|solar farm)\b|\b(final investment decision|\bfid\b|begins? (construction|work)|first (ore|production|shipment|power))\b/i },
  { k: 'legal',    w: 0.75, re: /\b(class action|\basic\b|\bacc?c\b|court|litigation|investigation|penalt\w+|fined?|breach|subpoena|recall|settle(s|d|ment)?|compensat\w+|damages|native title|tribunal|appeal)\b/i },
  { k: 'contract', w: 0.70, re: /\b(contract award|awarded (a|the)? ?contract|\bsigns?\b[^.]{0,30}\b(agreement|contract|mou|deal|charter)\b|\bagreement\b[^.]{0,20}\b(with|for)\b|licence agreement|offtake|partnership with|joint venture|\bwins?\b[^.]{0,25}\b(contract|tender|deal)\b|extends? [^.]{0,30}\bfacility\b)/i },
  { k: 'drill',    w: 0.70, re: /\b(drill(ing)? results|assay|resource (upgrade|estimate)|maiden resource|intercept|exploration update|feasibility study|first production|maiden ore)\b/i },
  { k: 'people',   w: 0.55, re: /\b(appoint\w*|resign\w*|retire\w*|steps? down|chief (executive|financial) officer|\bceo\b|\bcfo\b|chair(man|person)?|board change|change (of|in) director'?s? interest)\b/i },
  { k: 'broker',   w: 0.50, re: /\b(price target|target price|upgrade[sd]? to (buy|outperform|overweight|hold)|downgrade[sd]? to (sell|underperform|underweight|hold)|initiat\w+ coverage|reiterate[sd]? (its )?rating|moves? to (strong )?(buy|sell|hold)|(raises?|lifts?|cuts?|trims?) [^.]{0,25}(target|forecast|estimates?)|\brating\b[^.]{0,20}\b(upgrade|downgrade)\b|\b(bull|bear) of the day\b)/i },
];
// ---- IS THIS HEADLINE EVEN ABOUT THE COMPANY? ----
// A per-ticker feed is a loose thing: it carries sector pieces, market wraps and
// stories about rivals. A headline only counts if it NAMES the company — by
// ticker, or by a distinctive word from its registered name. Words like "bank",
// "group", "mining" or "australia" are never distinctive enough on their own;
// that is precisely how a story about a tariff ended up filed under BHP.
const _NEWS_GENERIC = new Set(['the','and','of','for','a','an','ltd','limited','plc','inc','corp','corporation',
  'co','company','group','holdings','holding','nl','pty','sa','se','ag','nv','trust','fund','reit',
  'bank','banking','banks','resources','resource','mining','mines','minerals','metals','energy','power',
  'australia','australian','national','international','global','pacific','asia','asian','american','america',
  'industries','industrial','technologies','technology','tech','solutions','services','systems','partners',
  'capital','investments','investment','financial','finance','property','properties','health','healthcare',
  'pharma','pharmaceuticals','media','digital','data','cloud','green','clean','new','first','united','general']);
function _newsKeywords(ticker, name) {
  const out = new Set();
  const t = String(ticker || '').toLowerCase();
  if (t) out.add(t);
  const words = String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (w.length < 4) continue;              // too short to be distinctive on its own
    if (_NEWS_GENERIC.has(w)) continue;      // "bank" is not a company
    out.add(w);
  }
  return out;
}
function _newsRelevant(ticker, name, title) {
  const s = String(title || '').toLowerCase();
  if (!s) return false;
  const t = String(ticker || '').toLowerCase();
  if (t) {
    // the ticker, but only as its own word — "cba" must not match "cbaz", and
    // ASX:CBA / CBA.AX / (CBA) are the forms these feeds actually use
    const re = new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)');
    if (re.test(s)) return true;
  }
  const kws = _newsKeywords(ticker, name);
  for (const k of kws) {
    if (k === t) continue;
    if (new RegExp('(^|[^a-z0-9])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(s)) return true;
  }
  // No name registered and no ticker match: we cannot tell, so we say no. A
  // missing flag is honest; a wrong one is not.
  return false;
}
function _newsClassify(title) {
  for (const c of _NEWS_KIND) { if (c.re.test(title)) return { kind: c.k, weight: c.w }; }
  return { kind: 'other', weight: 0.35 };
}
// ---- and what to throw away. Ticker feeds are full of listicles and daily
//      market wraps. Letting those in would make "had news" meaningless, which
//      is worse than having no news at all. ----
const _NEWS_NOISE = [
  /\b(top|best|worst)\s+\d+\s*(asx|nyse|nasdaq)?\s*(shares?|stocks?)\b/i,
  /\b\d+\s+(asx|top|cheap|small[- ]cap|blue[- ]chip)\s+(shares?|stocks?)\b/i,
  /\bshould you (buy|sell|hold|invest)\b/i,
  /\b(why|how) i(’|')?d\b/i,
  /\b(shares?|stocks?) to (watch|buy|consider)\b/i,
  /\bhot stocks?\b/i,
  /\b(asx ?200|s&p|nasdaq|dow|market)\s+(close[sd]?|open[sd]?|wrap|recap|update|live|midday|morning|afternoon|higher|lower)\b/i,
  /\b(what|things) you need to know\b/i,
  /\bmotley fool\b/i,
  /\bis (it|now) a (good )?(time|buy)\b/i,
  /\b(here(’|')?s (why|how|what))\b/i,
  /\b(3|5|10)\s+reasons\b/i,
  /\bwatch (these|this) \d+\b/i,                       // "Watch These 3 Copper Stocks…"
  /\b(is it|too late) (too late )?to (buy|consider|invest)\b/i,
  /\b(may be|might be) \d+% (above|below) fair value\b/i,
  /\b(story|narrative) is shifting\b/i,
  /\bjust shift\w* .*(investment )?narrative\b/i,
  /\b(zacks|simply wall st|motley fool)\b/i,
  /\bafter recent share price swings\b/i,
];
function _newsIsNoise(t) { const s = String(t || ''); return _NEWS_NOISE.some(re => re.test(s)); }

// ── w532: OFFICIAL MARKET-WIDE ANNOUNCEMENTS ────────────────────────────────
// The per-ticker RSS poller above only sees shares somebody put on the watch
// shortlist — announcement coverage inherited the watch list's selection bias,
// which is exactly the flaw that sank the news signal as evidence. This feed is
// the ASX's own "today's announcements" page: ONE fetch covers every listed
// company, and the exchange itself marks which announcements are price
// sensitive. No relevance test is needed (the exchange files each announcement
// under its own code) and no media-noise gate is needed (these are company
// filings, not journalism). The classifier still runs — `kind` and `weight`
// stay comparable across sources — and the official flag lands in `sens`.
const _ANN_SRC = {
  URL: 'https://www.asx.com.au/asx/v2/statistics/todayAnns.do',
  MAX_BODY: 3 * 1024 * 1024,   // the whole-market day page; results days run big
  MAX_ROWS: 1500,              // hard ceiling on rows parsed from one page
};
// Parse the todayAnns.do HTML table WITHOUT a DOM: rows split on <tr>, cells on
// <td>. Deliberately tolerant — a markup change should degrade to "parsed 0"
// (visible in the ann_run_ASX stamp and the probe route), never to wrong rows.
function _annParseToday(html) {
  const out = [];
  const s = String(html || '').slice(0, _ANN_SRC.MAX_BODY);
  const trs = s.split(/<tr[\s>]/i);
  for (let i = 1; i < trs.length && out.length < _ANN_SRC.MAX_ROWS; i++) {
    const row = trs[i].slice(0, 8000);
    if (!/<td/i.test(row)) continue;
    const cells = [];
    const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let m; while ((m = re.exec(row)) && cells.length < 10) cells.push(m[1]);
    if (cells.length < 2) continue;
    // the company code: first cell whose CLEANED text is a bare ASX code.
    // 3 characters only, on purpose — 4-6 char codes are warrants/notes/prefs
    // (census-proven) and the app never trades them.
    let ticker = '';
    for (const c of cells) { const t = _xClean(c); if (/^[A-Z0-9]{3}$/.test(t)) { ticker = t; break; } }
    if (!ticker) continue;
    // the headline: prefer the cell that carries the document link; otherwise
    // the longest cleaned cell that isn't a code, a time, or a page/size count.
    let title = '', link = '';
    for (const c of cells) {
      if (/<a[\s>]/i.test(c)) {
        const t = _xClean(c);
        if (t.length > title.length && t.length >= 4 && t !== ticker) title = t;
        const h = c.match(/href=["']([^"']+)["']/i);
        if (h && !link) link = h[1];
      }
    }
    if (!title) {
      for (const c of cells) {
        const t = _xClean(c);
        if (t === ticker) continue;
        if (/^\d{1,2}:\d{2}/.test(t)) continue;
        if (/^[\d.,]+\s*(page|kb|mb|b)?s?$/i.test(t)) continue;
        if (t.length > title.length && t.length >= 8) title = t;
      }
    }
    if (!title) continue;
    // pages/size suffixes ride inside the headline cell on this page —
    // strip a trailing "3 pages 128KB"-shaped tail so ids stay stable.
    title = title.replace(/\s*\d+\s*pages?\s*[\d.,]*\s*(KB|MB|B)?\s*$/i, '').trim();
    if (!title) continue;
    // the exchange's own price-sensitive marker (an asterisk image on this page)
    const sens = /price[\s_-]?sensitive|pricesens|asterix|asterisk/i.test(row) ? 1 : 0;
    const tm = _xClean(row).match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
    if (link && link.charAt(0) === '/') link = 'https://www.asx.com.au' + link;
    out.push({ ticker, title, link, sens, hh: tm ? tm[1] : '', mm: tm ? tm[2] : '', ap: tm ? tm[3].toUpperCase() : '' });
  }
  return out;
}
const _ANN_INS = 'INSERT OR IGNORE INTO news (id,exch,ticker,d,ts,title,url,src,kind,weight,fetched,sens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)';
async function _annPollMarket(env) {
  if (!env || !env.MARKET_DB) return { ok: false, error: 'no store' };
  const stamp = { at: new Date().toISOString() };
  const put = async () => { try { await _setMeta(env, 'ann_run_ASX', JSON.stringify(stamp)); } catch (e) {} };
  try {
    if (!(await _newsEnsure(env))) { stamp.error = 'news store not ready'; await put(); return { ok: false, ...stamp }; }
    // the day these announcements belong to is Sydney's today — the page only
    // ever shows the current exchange day.
    const nowIso = new Date().toISOString();
    const day = _newsLocalDay('ASX', nowIso);
    stamp.day = day;
    let body = '';
    try {
      const r = await fetch(_ANN_SRC.URL, { headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0 (InsightTrading EOD research; contact via app)' } });
      stamp.http = r.status;
      if (!r.ok) { stamp.error = 'upstream ' + r.status; await put(); return { ok: false, ...stamp }; }
      body = (await r.text()).slice(0, _ANN_SRC.MAX_BODY);
    } catch (e) { stamp.error = 'fetch failed: ' + String(e).slice(0, 80); await put(); return { ok: false, ...stamp }; }
    const parsed = _annParseToday(body);
    stamp.parsed = parsed.length;
    if (!parsed.length) { stamp.error = 'parsed 0 rows — page markup may have changed (see /admin/annprobe)'; await put(); return { ok: false, ...stamp }; }
    // Sydney wall-clock timestamp for each row, from the page's own AM/PM time.
    // Sub-day precision is presentation-only; the DAY is what grading reads.
    const rows = []; const seen = new Set(); let sensN = 0;
    for (const a of parsed) {
      const cls = _newsClassify(a.title);
      const w = a.sens ? Math.max(cls.weight, 0.9) : cls.weight;  // the exchange's flag outranks our guess
      let ts = day + 'T00:00:00.000Z';
      if (a.hh) { let h = (+a.hh % 12) + (a.ap === 'PM' ? 12 : 0); ts = day + 'T' + ('0' + h).slice(-2) + ':' + a.mm + ':00+10:00'; try { ts = new Date(ts).toISOString(); } catch (e) { ts = day + 'T00:00:00.000Z'; } }
      const id = _newsId('ASX', a.ticker, day, a.title);
      if (seen.has(id)) continue; seen.add(id);
      if (a.sens) sensN++;
      rows.push({ id, exch: 'ASX', ticker: a.ticker, d: day, ts, title: a.title.slice(0, 300), url: String(a.link || '').slice(0, 400), src: 'asx', kind: cls.kind, weight: w, sens: a.sens });
    }
    stamp.kept = rows.length; stamp.sens = sensN;
    const now = new Date().toISOString();
    const stmt = env.MARKET_DB.prepare(_ANN_INS);
    let stored = 0;
    for (let i = 0; i < rows.length; i += 50) {
      const b = rows.slice(i, i + 50).map(r => stmt.bind(r.id, r.exch, r.ticker, r.d, r.ts, r.title, r.url, r.src, r.kind, r.weight, now, r.sens));
      const res = await env.MARKET_DB.batch(b);
      for (const x of (res || [])) stored += (x && x.meta && x.meta.changes) ? x.meta.changes : 0;
    }
    // a headline the RSS poller already stored dedupes to the same id (same
    // normalised title, same day) and OR IGNORE keeps the old row — but the
    // official flag must still land, so backfill sens onto the survivors.
    const sensIds = rows.filter(r => r.sens).map(r => r.id);
    for (let i = 0; i < sensIds.length; i += 50) {
      const b = sensIds.slice(i, i + 50).map(id => env.MARKET_DB.prepare('UPDATE news SET sens=1, src=COALESCE(src,?) WHERE id=? AND (sens IS NULL OR sens=0)').bind('asx', id));
      try { await env.MARKET_DB.batch(b); } catch (e) {}
    }
    stamp.stored = stored;
    // provenance: the first day the market-wide feed ran — from this day on,
    // announcement coverage is the whole exchange, not a watch list.
    try { if (!(await _getMeta(env, 'ann_feed_start_ASX'))) await _setMeta(env, 'ann_feed_start_ASX', day); } catch (e) {}
    await put();
    return { ok: true, ...stamp };
  } catch (e) { stamp.error = String(e).slice(0, 140); await put(); return { ok: false, ...stamp }; }
}

// ---- stable id so the same headline is stored once, forever. 64 bits of
//      FNV-1a over the normalised title, scoped to exchange+ticker+day. ----
function _newsNorm(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90); }
function _newsHash(s) { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
function _newsId(exch, ticker, day, title) {
  const n = _newsNorm(title);
  return exch + ':' + ticker + ':' + day + ':' + _newsHash(n) + _newsHash(n.split('').reverse().join(''));
}

// ---- where the headlines come from. Per-ticker feeds published for
//      syndication; marketaux only if Tony sets the optional NEWS_KEY secret. ----
function _newsYSym(exch, ticker) { return exch === 'ASX' ? ticker + '.AX' : ticker; }
function _newsSources(env, exch, ticker) {
  const y = _newsYSym(exch, ticker);
  const au = exch === 'ASX';
  const list = [];
  if (env && env.NEWS_KEY) {
    list.push({ src: 'marketaux', type: 'json', url: 'https://api.marketaux.com/v1/news/all?symbols=' + encodeURIComponent(y) + '&filter_entities=true&language=en&limit=3&api_token=' + encodeURIComponent(env.NEWS_KEY) });
  }
  list.push({ src: 'yahoo', type: 'rss', url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=' + encodeURIComponent(y) + '&region=US&lang=en-US' });
  const q = au ? ('"ASX:' + ticker + '" OR "' + ticker + '.AX"') : ('"' + ticker + '" stock');
  list.push({ src: 'google', type: 'rss', url: 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + (au ? '&hl=en-AU&gl=AU&ceid=AU:en' : '&hl=en-US&gl=US&ceid=US:en') });
  return list;
}
// Returns { rows, tried, failed } — the counts matter: "the feed was down" and
// "this company genuinely had no news" must never look the same to the caller.
async function _newsFetchOne(env, exch, ticker, name) {
  const out = [], seen = new Set();
  let tried = 0, failed = 0;
  for (const s of _newsSources(env, exch, ticker)) {
    let items = [];
    tried++;
    try {
      const r = await fetch(s.url, { headers: { 'Accept': 'application/rss+xml, application/xml, text/xml, application/json', 'User-Agent': 'InsightTrading/1.0 (personal share-watchlist headline reader)' } });
      if (!r || !r.ok) { failed++; continue; }
      const txt = (await r.text()).slice(0, _NEWS.MAX_BODY);
      items = (s.type === 'json') ? _newsJsonItems(txt) : _rssItems(txt);
    } catch (e) { failed++; continue; }
    let got = 0;
    for (const it of items) {
      if (!it || !it.title) continue;
      // v387: a headline that never names the company is somebody else's news
      if (!_newsRelevant(ticker, name, it.title)) continue;
      // No date means we cannot say WHICH day it belongs to, and guessing "today"
      // would re-manufacture the same headline as fresh news every single poll.
      if (!it.ts) continue;
      if (_newsIsNoise(it.title)) continue;
      const day = _newsLocalDay(exch, it.ts);
      const id = _newsId(exch, ticker, day, it.title);
      if (seen.has(id)) continue;
      seen.add(id);
      const c = _newsClassify(it.title);
      const href = String(it.link || '');
      out.push({ id, exch, ticker, d: day, ts: it.ts, title: it.title.slice(0, 300),
        url: /^https?:\/\//i.test(href) ? href.slice(0, 500) : '',   // never store a javascript:/data: link
        src: s.src, kind: c.kind, weight: c.weight });
      got++;
      if (out.length >= _NEWS.PER_TICKER) break;
    }
    if (got >= _NEWS.ENOUGH || out.length >= _NEWS.PER_TICKER) break;  // don't ask the next source needlessly
  }
  return { rows: out, tried, failed };
}

// ---- the store ----
// Keyed on the binding itself, not a bare boolean: one isolate only ever sees
// one database, but tying the flag to the object means a swapped binding can
// never leave us talking to a store whose tables were never made.
let _newsReadyFor = null;
async function _newsEnsure(env) {
  if (!env || !env.MARKET_DB) return false;
  if (_newsReadyFor === env.MARKET_DB) return true;
  try {
    // One statement at a time on purpose: D1 runs batch() as a single implicit
    // transaction, and DDL inside one has been fragile. Sequential is slower
    // once per isolate and can't half-succeed invisibly.
    for (const ddl of [
      'CREATE TABLE IF NOT EXISTS news (id TEXT PRIMARY KEY, exch TEXT NOT NULL, ticker TEXT NOT NULL, d TEXT NOT NULL, ts TEXT NOT NULL, title TEXT NOT NULL, url TEXT, src TEXT, kind TEXT, weight REAL, fetched TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS news_tick ON news (exch,ticker,d)',
      'CREATE INDEX IF NOT EXISTS news_day ON news (exch,d)',
      'CREATE INDEX IF NOT EXISTS news_purge ON news (d)',
      'CREATE TABLE IF NOT EXISTS news_watch (exch TEXT NOT NULL, ticker TEXT NOT NULL, prio INTEGER NOT NULL DEFAULT 1, seen TEXT NOT NULL, polled TEXT, fails INTEGER NOT NULL DEFAULT 0, name TEXT, PRIMARY KEY (exch,ticker))',
      'CREATE INDEX IF NOT EXISTS news_watch_due ON news_watch (prio,polled)',
    ]) await env.MARKET_DB.prepare(ddl).run();
    // idempotent upgrade for a store created before the back-off counter existed
    try { await env.MARKET_DB.prepare('ALTER TABLE news_watch ADD COLUMN fails INTEGER NOT NULL DEFAULT 0').run(); } catch (e) {}
    try { await env.MARKET_DB.prepare('ALTER TABLE news_watch ADD COLUMN name TEXT').run(); } catch (e) {}   // v387: the company name, for the relevance test
    try { await env.MARKET_DB.prepare('ALTER TABLE news ADD COLUMN sens INTEGER').run(); } catch (e) {}        // w532: ASX official price-sensitive flag (1/0/NULL=unknown source)
    _newsReadyFor = env.MARKET_DB;
  } catch (e) { return false; }
  return true;
}
const _NEWS_INS = 'INSERT OR IGNORE INTO news (id,exch,ticker,d,ts,title,url,src,kind,weight,fetched) VALUES (?,?,?,?,?,?,?,?,?,?,?)';
async function _newsStore(env, rows) {
  if (!rows || !rows.length) return 0;
  const now = new Date().toISOString();
  const stmt = env.MARKET_DB.prepare(_NEWS_INS);
  let n = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const b = rows.slice(i, i + 50).map(r => stmt.bind(r.id, r.exch, r.ticker, r.d, r.ts, r.title, r.url, r.src, r.kind, r.weight, now));
    const res = await env.MARKET_DB.batch(b);
    for (const x of (res || [])) n += (x && x.meta && x.meta.changes) ? x.meta.changes : 0;
  }
  return n;
}
async function _newsPrune(env) {
  const today = new Date().toISOString().slice(0, 10);
  try { const m = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind('news_pruned').first(); if (m && m.v === today) return; } catch (e) { return; }
  const cut = new Date(Date.now() - _NEWS.KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  try { await env.MARKET_DB.prepare('DELETE FROM news WHERE d < ?').bind(cut).run(); } catch (e) {}
  const scut = new Date(Date.now() - 45 * 864e5).toISOString();   // shortlist the app stopped asking about
  try { await env.MARKET_DB.prepare('DELETE FROM news_watch WHERE seen < ?').bind(scut).run(); } catch (e) {}
  try { await _setMeta(env, 'news_pruned', today); } catch (e) {}
}
// One polling pass: take the stalest few off the shortlist, fetch, store, stamp.
// A ticker is stamped as polled EVEN IF it returned nothing, so a share nobody
// writes about can never block the queue.
async function _newsTick(env, max) {
  if (!_newsOn(env)) return { ok: false, error: 'news off (set NEWS_ON=1)' };
  if (!(await _newsEnsure(env))) return { ok: false, error: 'no news store' };
  // Capped low on purpose: each ticker costs up to 3 outbound requests, and a
  // Worker invocation has a finite subrequest budget.
  const n = Math.max(1, Math.min(20, parseInt(max, 10) || _NEWS.MAX_PER_FIRING));
  const cut = new Date(Date.now() - _NEWS.MIN_GAP_H * 3600e3).toISOString();
  let due = [];
  try {
    const r = await env.MARKET_DB.prepare("SELECT exch,ticker,fails,name FROM news_watch WHERE polled IS NULL OR polled < ? ORDER BY prio DESC, COALESCE(polled,'') ASC LIMIT ?").bind(cut, n).all();
    due = (r && r.results) || [];
  } catch (e) { return { ok: false, error: 'shortlist read failed' }; }
  let stored = 0, polled = 0, seenN = 0, errs = 0;
  const now = new Date().toISOString();
  // A ticker whose every source failed is NOT treated as "no news today" — it is
  // stamped only far enough forward to retry in a couple of hours, so a passing
  // outage can't quietly cost a share a whole day of coverage. But the wait
  // DOUBLES each consecutive failure (2h, 4h, 8h, 16h, then the normal 20h), so
  // a permanently unfetchable ticker can't camp at the head of the queue and
  // starve the shares that do work.
  const backoff = (fails) => {
    const h = Math.min(_NEWS.MIN_GAP_H, _NEWS.RETRY_H * Math.pow(2, Math.min(4, Math.max(0, fails | 0))));
    return new Date(Date.now() - (_NEWS.MIN_GAP_H - h) * 3600e3).toISOString();
  };
  for (const w of due) {
    let got = null;
    try { got = await _newsFetchOne(env, w.exch, w.ticker, w.name); } catch (e) { got = null; }
    const rows = (got && got.rows) || [];
    const dead = !got || (got.tried > 0 && got.failed >= got.tried);
    seenN += rows.length;
    try { stored += await _newsStore(env, rows); } catch (e) {}
    try {
      await env.MARKET_DB.prepare('UPDATE news_watch SET polled=?, fails=? WHERE exch=? AND ticker=?')
        .bind(dead ? backoff(w.fails) : now, dead ? ((w.fails | 0) + 1) : 0, w.exch, w.ticker).run();
    } catch (e) {}
    if (dead) errs++; else polled++;
  }
  try { await _setMeta(env, 'news_last', now + ' polled=' + polled + ' failed=' + errs + ' seen=' + seenN + ' new=' + stored); } catch (e) {}
  try { await _newsPrune(env); } catch (e) {}
  return { ok: true, polled, failed: errs, seen: seenN, stored };
}

// ═══ w395 SCAN ENGINE — the product. Never shipped to a browser. ═══════════
// Maintained as /root/worker_next/scan_engine.js and pasted in here whole. That
// file is now the SOURCE, not an output: v471 took the rule predicates out of
// index.html, so nothing can regenerate them from the app any more.
/**
 * Insight Trading — scan engine (w391)
 * ---------------------------------------------------------------------------
 * THIS FILE IS THE PRODUCT. It holds every rule predicate, every threshold and
 * every tuned weight that decides whether a signal fires. It runs only on the
 * server and is never shipped to a browser.
 *
 * Ported verbatim from the app by build_scan_engine.py — do not hand-edit. Edit
 * index.html, re-run the generator, re-run the agreement test, then deploy.
 *
 *   scanToday(shares, FACTS, COV, dataDate) → { ticker: [rule keys that fired] }
 *     (takes PRICE SERIES — never client-supplied indicators; see w392)
 *   scanReplay(shares, need, FACTS, COV, exch) → { days, from, to, G, C, fires }
 */

function _scPrep(ser){
  var n=ser.length, P=new Float64Array(n+1), V=new Float64Array(n+1), G=new Float64Array(n+1), L=new Float64Array(n+1), M=new Float64Array(n+1), VN=new Float64Array(n+1), R=new Float64Array(n);
  for(var i=0;i<n;i++){
    var vv=(ser[i].v>0?ser[i].v:0);
    P[i+1]=P[i]+ser[i].c; V[i+1]=V[i]+vv; VN[i+1]=VN[i]+(vv>0?1:0);
    var d=i>0?(ser[i].c-ser[i-1].c):0, pc=(i>0&&ser[i-1].c>0)?ser[i-1].c:0;
    G[i+1]=G[i]+(d>0?d:0); L[i+1]=L[i]+(d<0?-d:0);
    M[i+1]=M[i]+(pc>0?Math.abs(d/pc)*100:0);
  }
  // v436: Wilder's RSI(14) — the same smoothing the app's _rsi() uses, computed
  // once per share. (The old prefix-average version was Cutler's RSI, which the
  // app deliberately stopped using because it disagreed with broker charts.)
  var per=14;
  for(i=0;i<n;i++)R[i]=NaN;
  if(n>per){
    var ag=(G[per+1]-G[1])/per, al=(L[per+1]-L[1])/per;
    R[per]=(al>0)?(100-100/(1+ag/al)):(ag>0?100:50);
    for(i=per+1;i<n;i++){
      var dd=ser[i].c-ser[i-1].c;
      ag=(ag*(per-1)+(dd>0?dd:0))/per; al=(al*(per-1)+(dd<0?-dd:0))/per;
      R[i]=(al>0)?(100-100/(1+ag/al)):(ag>0?100:50);
    }
  }
  // v447 — three rolling views, each O(n) via monotonic deques:
  //   HI[i] = highest close of the PRIOR 250 days (excludes day i) — the
  //           yardstick for a true 52-week-high breakout. Valid from i>=200.
  //   R10[i] = the last 10 days' close-to-close range as a % of today's close.
  //   SQ[i] = the smallest R10 of the prior ~3 months (excludes today) — so
  //           "tightest range in 3 months" is one comparison. Valid i>=75.
  var HI=new Float64Array(n), R10=new Float64Array(n), SQ=new Float64Array(n);
  for(i=0;i<n;i++){HI[i]=NaN;R10[i]=NaN;SQ[i]=NaN;}
  var dqMax=[],dqMin=[],q;
  for(i=0;i<n;i++){
    if(i>=200){ // prior-window max: deque holds indices of a descending run
      var lo0=i-250;
      while(dqMax.length&&dqMax[0]<lo0)dqMax.shift();
      if(dqMax.length)HI[i]=ser[dqMax[0]].c;
    }
    while(dqMax.length&&ser[dqMax[dqMax.length-1]].c<=ser[i].c)dqMax.pop();
    dqMax.push(i);
  }
  var dq2=[],dq3=[];
  for(i=0;i<n;i++){
    while(dq2.length&&dq2[0]<i-9)dq2.shift();
    while(dq3.length&&dq3[0]<i-9)dq3.shift();
    while(dq2.length&&ser[dq2[dq2.length-1]].c<=ser[i].c)dq2.pop(); dq2.push(i);
    while(dq3.length&&ser[dq3[dq3.length-1]].c>=ser[i].c)dq3.pop(); dq3.push(i);
    if(i>=9&&ser[i].c>0)R10[i]=((ser[dq2[0]].c-ser[dq3[0]].c)/ser[i].c)*100;
  }
  var dq4=[];
  for(i=0;i<n;i++){
    if(i>=75){
      var lo1=i-63;
      while(dq4.length&&dq4[0]<lo1)dq4.shift();
      if(dq4.length)SQ[i]=R10[dq4[0]];
    }
    if(!isNaN(R10[i])){ while(dq4.length&&R10[dq4[dq4.length-1]]>=R10[i])dq4.pop(); dq4.push(i); }
  }
  return {P:P,V:V,G:G,L:L,M:M,VN:VN,R:R,HI:HI,R10:R10,SQ:SQ};
}

// ═══ APP-PARITY FIELDS ═════════════════════════════════════════════════════
// The app computes three of these quantities differently from the rule engine
// above. The difference is small but real, and it changes which shares a report
// picks — so the ported report selectors read these, while the rule engine
// keeps using its own. See build_engine_parity.py for the measurements.
//
//   appAvgVol — the app's computeVolAvg(): every bar inside a 90-day window,
//               EXCLUDING the most recent bar, counting only days that traded,
//               rounded. (The engine's own avgV is 62 bars.)
//   appVolPct — Math.round(((todayVolume - appAvgVol)/appAvgVol)*100)
//   appRsi    — the app's _rsi() rounds to a whole number; ours does not. The
//               underlying smoothing already matches (verified share-by-share),
//               so rounding ours reproduces the app's exactly.
function _scAppStats(ser,end,rsiRaw){
  var out={appAvgVol:0,appVolPct:null,appRsi:null};
  if(!ser||end<1)return out;
  // 90 calendar days back from the LAST BAR — not from the server's clock, so
  // two machines in different timezones cannot disagree about the window.
  var last=String(ser[end].d||'').slice(0,10);
  var cutoff='';
  if(last){
    var t=Date.parse(last+'T00:00:00Z');
    if(isFinite(t))cutoff=new Date(t-90*86400000).toISOString().slice(0,10);
  }
  var sum=0,n=0;
  for(var i=0;i<end;i++){                       // i<end excludes the last bar
    var d=String(ser[i].d||'').slice(0,10);
    if(cutoff&&d<cutoff)continue;
    var v=ser[i].v;
    if(isFinite(v)&&v>0){sum+=v;n++;}
  }
  out.appAvgVol=n>0?Math.round(sum/n):0;
  if(out.appAvgVol>0){
    var tv=ser[end].v;
    out.appVolPct=Math.round(((tv-out.appAvgVol)/out.appAvgVol)*100);
  }
  if(rsiRaw!=null&&isFinite(rsiRaw))out.appRsi=rsiRaw; // w404: app v506 uses raw RSI; the parity mirror follows the app
  return out;
}

// ═══ TECHNICAL FIELDS ══════════════════════════════════════════════════════
// Ported from the app's computeTechnicals() and countDownStreak(). Everything
// the report selectors read that _scStats does not already compute.
//
// `ohlc` is an optional map of date → {o,h,l}, filled by the worker from the
// bars table. Three fields are better with it and two are impossible without:
//   · volExpanding needs highs and lows (a 14-day average range)
//   · gapUp needs today's OPEN
//   · nearHigh/nearLow use real intraday extremes rather than closes
// Without it everything falls back to closing prices — which is exactly what
// the app itself does when it is working from saved data.
// w400: `ext` is an optional {hi52,lo52} — the year's extremes, computed once a
// night from real highs and lows because reading them per request is 1.3
// million rows. Supplied, they are used; absent, this walks the bars it has
// exactly as before, so every other caller (the live grading, the replay) is
// untouched.
function _scTech(ser,end,st,ohlc,ext){
  var t={},i;
  var px=ser[end].c;
  var hiOf=function(k){ var b=ohlc&&ohlc[ser[k].d]; return (b&&isFinite(b.h))?b.h:ser[k].c; };
  var loOf=function(k){ var b=ohlc&&ohlc[ser[k].d]; return (b&&isFinite(b.l))?b.l:ser[k].c; };

  // consecutive down days, counting back from today (mirrors countDownStreak)
  var dd=0;
  for(i=end;i>=1;i--){ if(ser[i].c<ser[i-1].c)dd++; else break; }
  t.daysDown=dd;

  t.aboveMA50=(st.ma50!=null&&px>st.ma50);
  t.aboveMA200=(st.ma200!=null&&px>st.ma200);

  // golden / death cross — yesterday's 50 and 200 against today's
  t.cross=null;
  if(st.ma50!=null&&st.ma200!=null&&st.ma50p!=null&&st.ma200p!=null){
    if(st.ma50p<=st.ma200p&&st.ma50>st.ma200)t.cross='golden';
    else if(st.ma50p>=st.ma200p&&st.ma50<st.ma200)t.cross='death';
    else t.cross=st.ma50>st.ma200?'bull':'bear';
  }

  // 52-week proximity — up to ~252 sessions, highs/lows where we have them
  var s0=Math.max(0,end-251), hi52=-Infinity, lo52=Infinity;
  if(ext&&ext.hi52>0&&ext.lo52>0){ hi52=ext.hi52; lo52=ext.lo52; }
  else { for(i=s0;i<=end;i++){ var h=hiOf(i), l=loOf(i); if(h>hi52)hi52=h; if(l<lo52)lo52=l; } }
  // v495 parity — the ROUNDED figure is for display, the TEST uses the exact
  // one. The app changed at v495; this did not, and 30 of 400 shares disagreed.
  var _pfhX=(hi52>0&&isFinite(hi52))?(((px-hi52)/hi52)*100):null;
  var _pflX=(lo52>0&&isFinite(lo52))?(((px-lo52)/lo52)*100):null;
  t.pctFromHigh=(_pfhX!=null)?Math.round(_pfhX):null;
  t.pctFromLow=(_pflX!=null)?Math.round(_pflX):null;
  t.nearHigh=(_pfhX!=null&&_pfhX>=-3);
  t.nearLow=(_pflX!=null&&_pflX<=3);

  t.rsiState=(st.appRsi==null)?null:(st.appRsi>=70?'overbought':st.appRsi<=30?'oversold':'neutral');

  // gap — today's OPEN against yesterday's close; without an open the app uses
  // a close-to-close proxy and says so, so we do the same
  t.gapPct=null; t.gapUp=false;
  if(end>=1){
    var y=ser[end-1].c;
    var ob=ohlc&&ohlc[ser[end].d];
    var openUsed=(ob&&isFinite(ob.o))?ob.o:px;
    // v495 parity — same shape: a 2.5% gap rounded to 3 and flagged as a 3% gap.
    if(y>0){ var _gX=((openUsed-y)/y)*100; t.gapPct=Math.round(_gX); t.gapUp=(_gX>=3); }
  }

  // volatility — mean daily range % over the last 14 sessions, and whether
  // today's range is expanding against it
  var ranges=[];
  for(i=Math.max(0,end-13);i<=end;i++){
    var hh=hiOf(i), ll=loOf(i), cc=ser[i].c;
    if(isFinite(hh)&&isFinite(ll)&&cc>0)ranges.push(((hh-ll)/cc)*100);
  }
  t.atrPct=null; t.volExpanding=false;
  if(ranges.length){
    var sum=0; for(i=0;i<ranges.length;i++)sum+=ranges[i];
    t.atrPct=Math.round((sum/ranges.length)*10)/10;
    t.volExpanding=(ranges[ranges.length-1]>t.atrPct*1.6);
  }

  // OBV over the last 20 sessions
  t.obvTrend=null;
  if(end>=20){
    var obv=0, first=0, s1=end-20;
    for(i=s1+1;i<=end;i++){ obv+=(ser[i].c>ser[i-1].c?ser[i].v:ser[i].c<ser[i-1].c?-ser[i].v:0); }
    t.obvTrend=obv>first?'rising':obv<first?'falling':'flat';
  }
  return t;
}

function _scStats(ser,pf,end,ohlc,ext){
  if(end<29)return null;
  var mean=function(A,w){ return (end+1-w<0)?null:(A[end+1]-A[end+1-w])/w; };
  var ma=function(w){ return mean(pf.P,w); };
  // v436 (audit): volume average matches the app's computeVolAvg — it EXCLUDES
  // today's bar, spans ~90 calendar days, and only counts days that traded.
  var VW=62, lo=Math.max(0,end-VW), vsum=pf.V[end]-pf.V[lo], vcnt=pf.VN[end]-pf.VN[lo];
  var avgV=(vcnt>0)?(vsum/vcnt):0;
  if(!(avgV>0))return null;
  var c=ser[end].c, p=ser[end-1].c;
  if(!(c>0)||!(p>0))return null;
  var st={c:c,chg:((c-p)/p)*100,volPct:((ser[end].v-avgV)/avgV)*100,avgV:avgV,
          ma20:ma(20),ma50:ma(50),ma200:(end>=199?ma(200):null),
          typ:(end>=20?(pf.M[end+1]-pf.M[1])/end:mean(pf.M,20))};
  st.volRatio=(avgV>0)?(ser[end].v/avgV):0;
  st.rsi=(pf.R&&!isNaN(pf.R[end]))?pf.R[end]:null;
  // v447 — inputs for the six new rules
  st.rsiPrev=(pf.R&&end>0&&!isNaN(pf.R[end-1]))?pf.R[end-1]:null;
  st.hiPrev=(pf.HI&&!isNaN(pf.HI[end]))?pf.HI[end]:null;
  st.r10=(pf.R10&&!isNaN(pf.R10[end]))?pf.R10[end]:null;
  st.sqBase=(pf.SQ&&!isNaN(pf.SQ[end]))?pf.SQ[end]:null;
  st.ma50p=(end>=50)?((pf.P[end]-pf.P[end-50])/50):null;      // yesterday's MAs, for CROSS detection
  st.ma200p=(end>=200)?((pf.P[end]-pf.P[end-200])/200):null;
  st.d120=(end>=120&&ser[end-120].c>0)?((c-ser[end-120].c)/ser[end-120].c)*100:null;
  var du=0,i;
  for(i=end;i>=1;i--){ if(ser[i].c>ser[i-1].c)du++; else break; }
  st.du=du; st.streak=du;
  // w429 — the down-streak mirror. Not yet wired to a rule (the backtest
  // found the down side does not clear the SOLID/PROMISING bar the way the
  // up side does), but stored for when there's enough data to revisit.
  var dd=0,j;
  for(j=end;j>=1;j--){ if(ser[j].c<ser[j-1].c)dd++; else break; }
  st.dd=dd;
  // accumulation: baseline from BEFORE the 10-day window, divided by TRADED days
  var s0=Math.max(1,end-9), preN=pf.VN[s0], baseAcc=(preN>=5)?(pf.V[s0]/preN):avgV;
  if(!(baseAcc>0))baseAcc=avgV;
  st.baseAcc=baseAcc;
  var acc=0;
  for(i=s0;i<=end;i++){ if(ser[i].c>ser[i-1].c&&ser[i].v>=1.5*baseAcc)acc++; }
  st.acc=acc;
  // volume streak: baseline is the whole history EXCLUDING the last 5 days,
  // so a fresh volume ramp cannot raise its own bar (matches the live volDays)
  var bEnd=Math.max(1,end-4), bs=pf.V[bEnd], bn=pf.VN[bEnd], baseVS=(bn>0?bs/bn:avgV);
  var vr=0; if(baseVS>0){ for(i=end;i>=0;i--){ if(ser[i].v>0&&ser[i].v>baseVS)vr++; else break; } }
  st.volDays=vr;
  st.score=Math.round(Math.min(10,Math.min(7,acc*0.7)+Math.min(1.5,du*0.4)+Math.min(1,vr*0.3)+(st.chg>0?Math.min(0.5,st.chg/10):0))*10)/10;
  st.d10=(end>=10&&ser[end-10].c>0)?((c-ser[end-10].c)/ser[end-10].c)*100:null;
  st.d5=(end>=5&&ser[end-5].c>0)?((c-ser[end-5].c)/ser[end-5].c)*100:null;
  st.d2=(end>=2&&ser[end-2].c>0)?((c-ser[end-2].c)/ser[end-2].c)*100:null;
  st.lowPx=(c<0.20);
  // v439: the app's own newsProxy test, computed as of THIS day — a sharp
  // single-day move or a volume spike in the recent window suggests something
  // was announced. An estimate, exactly as it is on the live table.
  var nsy=false, lo5=Math.max(1,end-4), bv=baseAcc;
  for(i=end;i>=lo5;i--){
    var pc2=ser[i-1].c;
    if(pc2>0&&Math.abs((ser[i].c-pc2)/pc2)*100>=8){ nsy=true; break; }
    if(bv>0&&ser[i].v>0&&(ser[i].v/bv)>=3){ nsy=true; break; }
  }
  st.newsy=nsy;
  // app-parity fields for the ported report selectors (see _scAppStats)
  try{ var _ap=_scAppStats(ser,end,st.rsi); st.appAvgVol=_ap.appAvgVol; st.appVolPct=_ap.appVolPct; st.appRsi=_ap.appRsi; }catch(e){ st.appAvgVol=0; st.appVolPct=null; st.appRsi=null; }
  // technical fields for the ported report selectors (see _scTech)
  try{ var _tc=_scTech(ser,end,st,ohlc||null,ext||null); for(var _k in _tc)st[_k]=_tc[_k]; }catch(e){}
  return st;
}

var _SCAN_RULES=[
  // v436 (audit): each rule now mirrors the LIVE scan's real test. Where a row
  // measures a threshold rather than a button, it is labelled as the threshold.
  {k:'smart', n:'🎯 Smart Money', t:function(s){ return s.chg>0&&s.volPct>=50&&s.streak>=2; }},
  {k:'vol',   n:'📈 Volume 2× normal', t:function(s){ return s.volPct>=100; }},
  {k:'unus',  n:'🔥 Unusual Activity', t:function(s){
      // the live scoreUnusual patterns that stored closes+volumes can express
      if(s.volRatio>=3&&Math.abs(s.chg)<2)return true;                 // spike on a FLAT day
      if(s.streak>=3&&s.volDays>=3&&Math.abs(s.chg)<6)return true;     // quiet build-up
      if(s.du>=3&&s.volRatio>=4)return true;                            // volume climax
      if(s.lowPx&&Math.abs(s.chg)>=15&&s.volRatio>=3)return true;       // penny blow-off
      return false; }},
  {k:'sharp', n:'🚨 Sharp Mover', t:function(s){
      var mv=Math.abs(s.chg);
      return mv>=8 && s.typ>0 && (mv/s.typ)>=3 && s.volRatio>=2; }},
  {k:'recov', n:'↩️ Recovery Watch', t:function(s){ return s.volPct>=100&&s.chg>=-1&&s.chg<=3; }},
  {k:'quiet', n:'🫧 Quiet Movers', t:function(s){
      if(!(s.chg>=-5&&s.chg<=5))return false;
      var coiling=(s.d5!=null&&s.d5>=3)||s.streak>=2||s.acc>=4;
      return coiling||s.volPct>=80; }},
  {k:'pull',  n:'🪜 Pullback in Uptrend', t:function(s){
      if(s.ma20==null||s.ma50==null)return false;
      var up=(s.ma200!=null)&&(s.c>s.ma200&&s.ma50>s.ma200); // w405: STRICT — no 200-day view means the uptrend cannot be verified, so the share cannot fire. Tony's call, 29 July: a missing test is not a pass. Matches app v508.
      if(!up)return false;
      if(!(s.rsi!=null&&s.rsi>=35&&s.rsi<=55))return false;
      var d20=((s.c-s.ma20)/s.ma20)*100; if(!(d20>=-5&&d20<=8))return false;
      var d50=((s.c-s.ma50)/s.ma50)*100; return !(d50<-7); }},
  {k:'strong',n:'🧱 Strong Trends', t:function(s){ return s.ma200!=null&&s.c>s.ma20&&s.ma20>s.ma50&&s.ma50>s.ma200; }},
  // w429 — real replay against stored history (250 trading days, ASX,
  // $250k floor): a 2+ day up-streak predicts a WORSE next-5-day return —
  // fading strength, not chasing it. Clears the app's own SOLID bar
  // (|t|>=2.5) at 2, 3 and 5+ days; PROMISING at 4. Same bar as everything
  // else on the app, same day-clustered significance test.
  {k:'streakfade',n:'📉 Fading Strength (2+ day up-streak)', t:function(s){ return s.streak>=2; }},
  // w430 — the down-streak counterpart. Deliberately NOT proven yet — the
  // 2+ day threshold (the only length distinctive enough to be a useful
  // filter) did not clear the SOLID/PROMISING bar in the backtest. Added
  // "too early", same as the six newer signals — the honest grading engine
  // will show its real tier as more days accumulate, not a pre-judged one.
  {k:'downstreak',n:'📈 Possible Bounce Setup (2+ day down-streak)', t:function(s){ return s.dd>=2; }},
  {k:'accum', n:'💎 Heavy Accumulation (6+/10)', t:function(s){ return s.acc>=6; }},
  {k:'hiscore',n:'⭐ Watch Score 7+', t:function(s){ return s.score>=7; }},
  {k:'score6', n:'⭐ Watch Score 6+', t:function(s){ return s.score>=6; }},
  {k:'score5', n:'⭐ Watch Score 5+', t:function(s){ return s.score>=5; }},
  // ═══ v447 — six newcomers. Every one starts TOO EARLY and earns its tier. ═══
  {k:'hi52',  n:'📏 New 52-week High', t:function(s){
      // the best-documented momentum effect: a close above the prior 250-day
      // high, with at least some volume behind it so a one-tick blip in a dead
      // stock doesn't count
      return s.hiPrev!=null&&s.hiPrev>0&&s.c>s.hiPrev&&s.volRatio>=1.2; }},
  {k:'gold',  n:'✝️ Golden Cross (50/200)', t:function(s){
      // the 50-day average crossing UP through the 200-day — TODAY, not "is
      // above" (that near-duplicates Strong Trends). Rare by design.
      return s.ma50!=null&&s.ma200!=null&&s.ma50p!=null&&s.ma200p!=null
        &&s.ma50>s.ma200&&s.ma50p<=s.ma200p; }},
  {k:'rsirec',n:'🌀 RSI Recovery (30↗)', t:function(s){
      // not "is oversold" — falling knives are oversold all the way down. The
      // signal is the RSI crossing back UP through 30: the bounce has begun.
      return s.rsiPrev!=null&&s.rsi!=null&&s.rsiPrev<30&&s.rsi>=30; }},
  {k:'squeeze',n:'🤏 Volatility Squeeze', t:function(s){
      // the last 10 days are the TIGHTEST 10-day range of the past ~3 months,
      // on drying-up volume — a coiled spring; contraction precedes expansion
      return s.r10!=null&&s.sqBase!=null&&s.r10<=s.sqBase*1.02&&s.r10<8&&s.volRatio>0&&s.volRatio<=0.9; }},
  {k:'rsl',   n:'🏁 Rel-Strength Leader', t:function(s){
      // top 10% of the WHOLE MARKET by 120-day return (the day's cut-off is
      // computed across all shares and stamped on each st before rules run),
      // and today not extended — buy leaders on a breather, not on a spike
      return s.d120!=null&&s.rslCut!=null&&s.d120>=s.rslCut&&s.chg<=2&&s.chg>=-6; }},
  {k:'newsvol',n:'📰 News + Volume 2×', t:function(s){
      // a CONFIRMED material headline (from the news store, not the estimate)
      // AND double volume the same day. Only fires where news coverage exists,
      // so it starts tiny and honest and grows with the shortlist.
      return s.newsFact===true&&s.volPct>=100; }}
];

// w391 — the browser's _scReplay, running on the server. `shares`, `need`,
// `FACTS`, `COV` and `exch` arrive as arguments instead of being read out of
// globals; every line that decides a signal is untouched.
function scanReplay(allShares, need, FACTS, COV, exch){
  var shares=(Array.isArray(allShares)?allShares:[]).filter(function(s){return Array.isArray(s.series)&&s.series.length>=30;});
  if(shares.length<50)return null;
  var seen={};
  shares.forEach(function(s){ for(var i=0;i<s.series.length;i++){ var d=s.series[i].d; seen[d]=(seen[d]||0)+1; } });
  var floor=Math.max(10,Math.round(shares.length*0.25));
  var cal=Object.keys(seen).filter(function(d){return seen[d]>=floor;}).sort();
  if(cal.length<12)return null;
  var days=cal.slice(0,Math.max(0,cal.length-5)).slice(-250);   // v443: up to a year
  if(!days.length)return null;
  need=(+need>0)?+need:0;    // v434 floor, supplied by the caller
  // w391: FACTS/COV come straight from the worker's own D1 news store — no
  // round trip, and the same shape the browser used to build from /news/days.
  FACTS=FACTS||null; COV=COV||null;
  var pfs=shares.map(function(s){return _scPrep(s.series);});
  var idxmaps=shares.map(function(s){ var m={}; for(var i=0;i<s.series.length;i++)m[s.series[i].d]=i; return m; });
  // ── w403: the honest tally, computed in the same pass ────────────────────
  // G above answers "what did this rule's picks do, against the average share".
  // On the ASX the average share is not a real thing: its median 5-day return
  // is 0.000% and its mean is +3.247%, because 540 sub-cent listings average
  // +30.8% a week. T answers the question that can actually be acted on —
  // against the same tradeable market, bought a day later, counted by days.
  var T_FLOOR=Math.max(need||0, 50000);   // dollars of average daily turnover
  var T_LAG=1;                            // buy at TOMORROW's close
  var T_W=5;                              // tiers are decided on the 5-day hold
  var TD={};                              // rule key -> array of daily basket excess
  var TN={};                              // rule key -> total picks counted
  var T_DAYS=0;
  var W=[5,10,20], G={all:{}}, usedDays=0, fires={};
  ['5','10','20'].forEach(function(w){ G.all[w]={n:0,sum:0,up:0}; });
  _SCAN_RULES.forEach(function(R){ G[R.k]={}; fires[R.k]=0; ['5','10','20'].forEach(function(w){ G[R.k][w]={n:0,sum:0,up:0}; }); });
  // 🏆 Top 20 needs a per-day ranking, so it is handled after the per-share pass
  G.top20={}; fires.top20=0; ['5','10','20'].forEach(function(w){ G.top20[w]={n:0,sum:0,up:0}; });
  // v431: 🧩 combos — every PAIR of rules that fired on the same share, same day.
  // Rule index space: 0..N-1 = _SCAN_RULES, N = 🏆 Top 20 (ranked, added below).
  var NR=_SCAN_RULES.length, C={};
  var cAdd=function(a,b,fwd){ var k=a+'|'+b, g=C[k]; if(!g){ g=C[k]={}; ['5','10','20'].forEach(function(w){ g[w]={n:0,sum:0,up:0}; }); }
    // combos only ever show mean/hit-rate, so no samples are kept (v436: this
    // was allocating tens of megabytes that nothing read)
    for(var wi=0;wi<3;wi++){ if(fwd[wi]==null)continue; var key=String(W[wi]); var c=g[key];
      c.n++; c.sum+=fwd[wi]; if(fwd[wi]>0)c.up++; } };
  for(var di=0;di<days.length;di++){
    var D=days[di], rows=[];
    for(var si=0;si<shares.length;si++){
      var ix=idxmaps[si][D]; if(ix==null)continue;
      var st=_scStats(shares[si].series,pfs[si],ix); if(!st)continue;
      if(need&&st.avgV*st.c<need)continue;
      st.newsFact=FACTS?((FACTS[shares[si].ticker+'|'+D]||0)>=0.5):false;   // v447/v448: MATERIAL confirmed headline that day
      // v448: the news split — fact for covered shares, estimate for the rest
      // w392: hasOwnProperty, or a ticker called 'toString' counts as covered
      st.newsEff=(COV&&Object.prototype.hasOwnProperty.call(COV,shares[si].ticker))?st.newsFact:st.newsy;
      var fwd=[null,null,null], ser=shares[si].series, ok=false;
      for(var wi=0;wi<3;wi++){ var w=W[wi]; if(ix+w<ser.length&&ser[ix+w].c>0){ fwd[wi]=((ser[ix+w].c-ser[ix].c)/ser[ix].c)*100; ok=true; } }
      if(!ok)continue;
      rows.push({st:st,fwd:fwd,_ser:ser,_ix:ix});   // w403 needs the series to look a day further on
    }
    if(rows.length<50)continue;
    usedDays++;
    // v447: the day's relative-strength cut-off — the 90th percentile of
    // 120-day returns across every share trading that day, stamped on each st
    // so 🏁 Rel-Strength Leader is graded against the same market it ran in.
    (function(){
      var ds=[]; for(var q1=0;q1<rows.length;q1++){ var v=rows[q1].st.d120; if(v!=null)ds.push(v); }
      if(ds.length>=30){ ds.sort(function(a,b){return a-b;});
        var cut=ds[Math.min(ds.length-1,Math.floor(ds.length*0.9))];
        for(var q2=0;q2<rows.length;q2++)rows[q2].st.rslCut=cut; }
    })();
    // v436 (audit): reservoir sampling. The old code kept the FIRST 60k samples,
  // so a big group's median described only the oldest days of the window while
  // its average described all of them — the mid-vs-market column was comparing
  // two different periods. A deterministic reservoir keeps a fair spread.
  var CAP=40000, _seed=20260727;
  var _rnd=function(){ _seed=(_seed*1103515245+12345)&0x7fffffff; return _seed/0x7fffffff; };
  var bump=function(o,x){ o.n++; o.sum+=x;
    if(x>0){ o.up++; o.wsum=(o.wsum||0)+x; }
    else { o.dn=(o.dn||0)+1; o.dsum=(o.dsum||0)+x; } };
  var add=function(g,fwd,newsy){ for(var wi=0;wi<3;wi++){ if(fwd[wi]==null)continue; var key=String(W[wi]); var c=g[key];
    bump(c,fwd[wi]);
    // v439: the same tallies again, split by whether the fire day looked
    // news-driven — so 📢 and 🔇 can be graded against their own market
    if(!c.nq)c.nq={news:{n:0,sum:0,up:0},quiet:{n:0,sum:0,up:0}};
    bump(c.nq[newsy?'news':'quiet'],fwd[wi]);
    if(!c.s)c.s=[];
    if(c.s.length<CAP)c.s.push(fwd[wi]);
    else { var j=Math.floor(_rnd()*c.n); if(j<CAP)c.s[j]=fwd[wi]; } } };
    for(var ri=0;ri<rows.length;ri++){
      add(G.all,rows[ri].fwd,rows[ri].st.newsEff!==undefined?rows[ri].st.newsEff:rows[ri].st.newsy);
      var hits=[];
      for(var ru=0;ru<NR;ru++){
        var R=_SCAN_RULES[ru];
        var hit=false; try{ hit=!!R.t(rows[ri].st); }catch(e){}
        if(hit){ add(G[R.k],rows[ri].fwd,rows[ri].st.newsEff!==undefined?rows[ri].st.newsEff:rows[ri].st.newsy); fires[R.k]++; hits.push(ru); }
      }
      rows[ri].hits=hits;
    }
    // ── w403 ───────────────────────────────────────────────────────────────
    // The same rows, but only what could actually be bought, with the day's
    // extremes clipped, bought a day late, and scored against the mean of that
    // same universe — which is precisely what buying the whole list earns, and
    // therefore the only benchmark a pick has to beat to be worth making.
    (function(){
      var U=[];
      for(var q=0;q<rows.length;q++){
        var R0=rows[q], S0=R0.st;
        if(!(S0.avgV*S0.c>=T_FLOOR))continue;
        var _sr=null, _ix=null;
        // rows[] carries no index back, so recover the forward return with the
        // lag from the share's own series via the day map built above
        _sr=R0._ser; _ix=R0._ix;
        if(_sr==null||_ix==null)continue;
        var a=_ix+T_LAG, b=_ix+T_LAG+T_W;
        if(!(b<_sr.length&&_sr[a]&&_sr[a].c>0&&_sr[b].c>0))continue;
        U.push({st:S0,f:((_sr[b].c-_sr[a].c)/_sr[a].c)*100});
      }
      if(U.length<50)return;
      // winsorise this day's cross-section at its own 1st / 99th percentile
      var vv=[]; for(var w1=0;w1<U.length;w1++)vv.push(U[w1].f);
      vv.sort(function(x,y){return x-y;});
      var lo=vv[Math.floor(vv.length*0.01)], hi=vv[Math.floor(vv.length*0.99)];
      var msum=0;
      for(var w2=0;w2<U.length;w2++){
        if(U[w2].f<lo)U[w2].f=lo; else if(U[w2].f>hi)U[w2].f=hi;
        msum+=U[w2].f;
      }
      var mkt=msum/U.length;
      T_DAYS++;
      var bag={}, cnt={};
      for(var w3=0;w3<U.length;w3++){
        var stx=U[w3].st, ex=U[w3].f-mkt;
        for(var w4=0;w4<NR;w4++){
          var RR=_SCAN_RULES[w4], hh=false;
          try{ hh=!!RR.t(stx); }catch(e){}
          if(!hh)continue;
          bag[RR.k]=(bag[RR.k]||0)+ex; cnt[RR.k]=(cnt[RR.k]||0)+1;
        }
      }
      // 🏆 Top 20 is a ranking, so it is taken from the same fair universe
      var rk=U.filter(function(x){return x.st.score>0;})
        .sort(function(x,y){ return (y.st.score-x.st.score)||(y.st.acc-x.st.acc); }).slice(0,20);
      for(var w5=0;w5<rk.length;w5++){ bag.top20=(bag.top20||0)+(rk[w5].f-mkt); cnt.top20=(cnt.top20||0)+1; }
      for(var k2 in bag){
        if(!TD[k2]){ TD[k2]=[]; TN[k2]=0; }
        TD[k2].push(bag[k2]/cnt[k2]); TN[k2]+=cnt[k2];
      }
    })();
    var ranked=rows.filter(function(x){return x.st.score>0;}).sort(function(a,b){return (b.st.score-a.st.score)||(b.st.acc-a.st.acc);}).slice(0,20);
    for(var t2=0;t2<ranked.length;t2++){ add(G.top20,ranked[t2].fwd,ranked[t2].st.newsEff!==undefined?ranked[t2].st.newsEff:ranked[t2].st.newsy); fires.top20++; ranked[t2].hits.push(NR); }
    for(var pi=0;pi<rows.length;pi++){
      var hs=rows[pi].hits; if(hs.length<2)continue;
      for(var a1=0;a1<hs.length-1;a1++)for(var b1=a1+1;b1<hs.length;b1++)cAdd(hs[a1],hs[b1],rows[pi].fwd);
    }
  }
  if(!usedDays)return null;
  // ── w403: turn each rule's daily series into an edge and an error bar ─────
  // Newey-West with 4 lags. Buying every day and holding five means today's
  // result shares four days with yesterday's, so a plain standard error is too
  // small by construction — this is the standard correction for exactly that.
  var T={};
  (function(){
    var nwT=function(x){
      var n=x.length; if(n<20)return null;
      var m=0,i; for(i=0;i<n;i++)m+=x[i]; m/=n;
      var e=[]; for(i=0;i<n;i++)e.push(x[i]-m);
      var g0=0; for(i=0;i<n;i++)g0+=e[i]*e[i]; g0/=n;
      var lrv=g0, L=Math.min(T_W-1,n-2), l,g;
      for(l=1;l<=L;l++){ g=0; for(i=l;i<n;i++)g+=e[i]*e[i-l]; g/=n; lrv+=2*(1-l/(L+1))*g; }
      if(!(lrv>0))lrv=g0;
      var se=Math.sqrt(lrv/n);
      return {mean:m,se:se,t:se>0?m/se:0,days:n};
    };
    for(var k in TD){
      var q=nwT(TD[k]); if(!q)continue;
      T[k]={n:TN[k],days:q.days,perDay:Math.round((TN[k]/q.days)*10)/10,
            edge:Math.round(q.mean*1000)/1000,t:Math.round(q.t*100)/100};
    }
  })();
  return {days:usedDays,from:days[0],to:days[days.length-1],G:G,C:C,fires:fires,exch:exch,
          T:T,tDays:T_DAYS,tFloor:T_FLOOR,tLag:T_LAG,tW:T_W,tv:404};
}

// w392 — one day, from PRICE SERIES, never from numbers the caller hands us.
//
// The previous version of this function took a ready-made stats object per
// share. That made the endpoint a decision oracle: ask "does it fire at 49?",
// then "at 51?", and binary-search every threshold. Measured: all of them,
// exactly, in three requests. So the caller no longer gets to state the
// indicators — they send the same price history the replay already needs, and
// we work the indicators out here.
//
// A ticker is sanitised before it is used as a key, and the map has no
// prototype, so a share called __proto__ cannot re-parent the answer.
function _scTicker(t){ return String(t||'').toUpperCase().replace(/[^A-Z0-9.]/g,'').slice(0,16); }
// ── w426: BACKTEST ACCUM & SCORE — Tony's order, 30 Jul. Two client-side
// numbers (the ⭐ SCORE and 🔥 ACCUM columns) have been shown on every share,
// every day, and NEVER been through the year-long replay PN Edge already
// goes through. This ports the exact client formulas (accumDays, daysUp,
// volDays, watchScore10 — verbatim, checked against the live index.html
// line by line) and replays them the SAME way scanReplay already does:
// next-day-close buy, one observation per day (not per share), against the
// $250k tradeable universe, with the SAME day-clustered t-stat (_clusterT)
// the main grading engine already uses. No new methodology — the existing,
// proven one, pointed at two numbers that had never been checked.
function _accScoreAt(series, ix){
  if(ix<10 || !series[ix] || series[ix].c<=0) return null;
  const upToIx = series.slice(0, ix+1);
  const older5 = upToIx.slice(0, -5);
  let vs=0, vn=0; (older5.length?older5:upToIx).forEach(function(x){ if(x.v>0){vs+=x.v; vn++;} });
  const avgV5 = vn>0 ? vs/vn : 0;
  let volDays=0;
  if(avgV5>0){ for(let k=ix; k>=0; k--){ if(series[k].v>0 && series[k].v>avgV5) volDays++; else break; } }
  let daysUp=0;
  for(let k=ix; k>=1; k--){ if(series[k].c>series[k-1].c) daysUp++; else break; }
  const startIdx = Math.max(1, ix-9);
  const olderAcc = series.slice(0, startIdx);
  let bsum=0, bn=0; (olderAcc.length?olderAcc:upToIx).forEach(function(x){ if(x.v>0){bsum+=x.v; bn++;} });
  const baseVolAcc = bn>0 ? bsum/bn : 0;
  let accum=0;
  if(baseVolAcc>0){
    for(let k=startIdx; k<=ix; k++){
      if(k<1) continue;
      const priceUp = series[k].c > series[k-1].c;
      const heavyVol = series[k].v>0 && (series[k].v/baseVolAcc)>=1.5;
      if(priceUp && heavyVol) accum++;
    }
  }
  const chgPct = ix>=1 && series[ix-1].c>0 ? ((series[ix].c-series[ix-1].c)/series[ix-1].c)*100 : 0;
  const accPts=Math.min(7,accum*0.7), psPts=Math.min(1.5,daysUp*0.4), vsPts=Math.min(1,volDays*0.3);
  const mo=chgPct>0?Math.min(0.5,chgPct/10):0;
  const score=Math.round(Math.min(10,accPts+psPts+vsPts+mo)*10)/10;
  return {accum:accum, daysUp:daysUp, volDays:volDays, chgPct:chgPct, score:score};
}
function _scoreBand(x){ return x>=7?'Strong':x>=4?'Building':x>=2?'Early':'Minimal'; }

// ── w428: BACKTEST PRICE STREAKS (up 1-5+, down 1-5+) — Tony's order, 31 Jul.
// Same isolation logic that made this worth building separately from Accum:
// Accum conflated price AND volume into one number, so a null result never
// said which half (if either) mattered. This tests price alone. Exact same
// machinery as the Accum/Score replay — day iteration, $250k floor, 5-day
// forward window, day-clustered _clusterT — just a different rule.
// ── w431: SYSTEMATIC OPPOSITE-SIGNAL SWEEP — Tony's order, 31 Jul. The real
// version of "capitalize on the opposite": instead of one ad-hoc test (price
// streaks), test whether the EXTREME end of several well-known bullish
// indicators (not their absence — that's just what every rule's own edge
// already measures) predicts a WORSE forward return than the middle of
// their own range, the same way an overextended up-streak did. Reuses the
// exact _scPrep/_scStats/calendar machinery scanReplay already trusts —
// computed ONCE per share/day and shared across every metric tested, same
// efficiency discipline as scanReplay's own single pass. Five candidates,
// each picked because it is a real, named "overbought" concept in technical
// analysis, not a blind data-mine: RSI, distance above the 200-day MA,
// volume vs normal, 6-month change, and 10-day change (a different
// timescale from the streak rule already live).
function _oppositeSweep(allShares, floorDollars){
  var shares=(Array.isArray(allShares)?allShares:[]).filter(function(s){return Array.isArray(s.series)&&s.series.length>=40;});
  if(shares.length<50)return null;
  var seen={};
  shares.forEach(function(s){ for(var i=0;i<s.series.length;i++){ var d=s.series[i].d; seen[d]=(seen[d]||0)+1; } });
  var floor=Math.max(10,Math.round(shares.length*0.25));
  var cal=Object.keys(seen).filter(function(d){return seen[d]>=floor;}).sort();
  if(cal.length<12)return null;
  var days=cal.slice(0,Math.max(0,cal.length-5)).slice(-250);
  if(!days.length)return null;
  var need=Math.max(floorDollars||250000, 50000);
  var pfs=shares.map(function(s){return _scPrep(s.series);});
  var idxmaps=shares.map(function(s){ var m={}; for(var i=0;i<s.series.length;i++)m[s.series[i].d]=i; return m; });

  var METRICS=[
    {k:'rsi', label:'RSI', get:function(st){return st.rsi;}, buckets:[
      {lo:-1e9,hi:30,t:'<30 (oversold)'},{lo:30,hi:50,t:'30-50'},{lo:50,hi:70,t:'50-70'},
      {lo:70,hi:80,t:'70-80 (overbought)'},{lo:80,hi:1e9,t:'80+ (extreme)'}]},
    {k:'ma200dist', label:'% above 200-day MA', get:function(st){ return (st.ma200!=null&&st.ma200>0)?((st.c-st.ma200)/st.ma200)*100:null; }, buckets:[
      {lo:-1e9,hi:0,t:'below MA200'},{lo:0,hi:10,t:'0-10% above'},{lo:10,hi:25,t:'10-25% above'},
      {lo:25,hi:50,t:'25-50% above'},{lo:50,hi:1e9,t:'50%+ above (extreme)'}]},
    {k:'volratio', label:'Volume vs normal', get:function(st){return st.volRatio;}, buckets:[
      {lo:0,hi:1,t:'<1x'},{lo:1,hi:2,t:'1-2x'},{lo:2,hi:4,t:'2-4x'},
      {lo:4,hi:8,t:'4-8x'},{lo:8,hi:1e9,t:'8x+ (extreme spike)'}]},
    {k:'d120', label:'6-month change', get:function(st){return st.d120;}, buckets:[
      {lo:-1e9,hi:0,t:'negative'},{lo:0,hi:25,t:'0-25%'},{lo:25,hi:50,t:'25-50%'},
      {lo:50,hi:100,t:'50-100%'},{lo:100,hi:1e9,t:'100%+ (doubled+)'}]},
    {k:'d10', label:'10-day change', get:function(st){return st.d10;}, buckets:[
      {lo:-1e9,hi:0,t:'negative'},{lo:0,hi:10,t:'0-10%'},{lo:10,hi:20,t:'10-20%'},
      {lo:20,hi:35,t:'20-35%'},{lo:35,hi:1e9,t:'35%+ (extreme)'}]},
  ];

  var B={};
  METRICS.forEach(function(M){ B[M.k]={}; M.buckets.forEach(function(bk){ B[M.k][bk.t]={dayMap:{},n:0,up:0}; }); });
  var usedDays=0;
  for(var di=0;di<days.length;di++){
    var D=days[di], rowsByMetric={};
    METRICS.forEach(function(M){ rowsByMetric[M.k]=[]; });
    for(var si=0;si<shares.length;si++){
      var ix=idxmaps[si][D]; if(ix==null)continue;
      var st=_scStats(shares[si].series,pfs[si],ix); if(!st)continue;
      if(st.avgV*st.c<need)continue;
      var ser=shares[si].series;
      var fwd5=(ix+5<ser.length&&ser[ix+5].c>0)?((ser[ix+5].c-ser[ix].c)/ser[ix].c)*100:null;
      if(fwd5==null)continue;
      METRICS.forEach(function(M){
        var v=M.get(st); if(v==null||isNaN(v))return;
        var bk=null;
        for(var bi=0;bi<M.buckets.length;bi++){ var b=M.buckets[bi]; if(v>=b.lo&&v<b.hi){bk=b.t;break;} }
        if(bk==null)return;
        rowsByMetric[M.k].push({bucket:bk,fwd5:fwd5});
      });
    }
    var anyRows=false;
    METRICS.forEach(function(M){ if(rowsByMetric[M.k].length>=30)anyRows=true; });
    if(!anyRows)continue;
    usedDays++;
    METRICS.forEach(function(M){
      var rows=rowsByMetric[M.k]; if(rows.length<30)return;
      var msum=0; for(var r=0;r<rows.length;r++)msum+=rows[r].fwd5;
      var dayMean=msum/rows.length;
      for(var r=0;r<rows.length;r++){
        var exc=rows[r].fwd5-dayMean;
        var bkt=B[M.k][rows[r].bucket]; if(!bkt)return;
        if(!bkt.dayMap[D])bkt.dayMap[D]=[0,0];
        bkt.dayMap[D][0]++; bkt.dayMap[D][1]+=exc; bkt.n++; if(exc>0)bkt.up++;
      }
    });
  }
  if(usedDays<20)return null;
  var out={usedDays:usedDays, floor:need, metrics:{}};
  METRICS.forEach(function(M){
    out.metrics[M.k]={label:M.label, buckets:{}};
    M.buckets.forEach(function(bk){
      var b=B[M.k][bk.t]; var ct=_clusterT(b.dayMap);
      out.metrics[M.k].buckets[bk.t]={n:b.n, hitRate:b.n?+(100*b.up/b.n).toFixed(1):0, tstat:+ct.t.toFixed(2), days:ct.days};
    });
  });
  return out;
}
function _streakAt(series, ix){
  if(ix<1 || !series[ix] || series[ix].c<=0) return null;
  let up=0; for(let k=ix; k>=1; k--){ if(series[k].c>series[k-1].c) up++; else break; }
  let down=0; for(let k=ix; k>=1; k--){ if(series[k].c<series[k-1].c) down++; else break; }
  return {up:up, down:down};
}
function _streakBucket(st){
  if(st.up>0) return 'up'+Math.min(5,st.up);
  if(st.down>0) return 'down'+Math.min(5,st.down);
  return 'flat';
}
function _streakReplay(allShares, floorDollars){
  const shares=(Array.isArray(allShares)?allShares:[]).filter(function(s){return Array.isArray(s.series)&&s.series.length>=40;});
  if(shares.length<50) return null;
  const seen={};
  shares.forEach(function(s){ for(let i=0;i<s.series.length;i++){ const d=s.series[i].d; seen[d]=(seen[d]||0)+1; } });
  const floor=Math.max(10,Math.round(shares.length*0.25));
  const cal=Object.keys(seen).filter(function(d){return seen[d]>=floor;}).sort();
  if(cal.length<12) return null;
  const days=cal.slice(0,Math.max(0,cal.length-5)).slice(-250);
  if(!days.length) return null;
  const idxmaps=shares.map(function(s){ const m={}; for(let i=0;i<s.series.length;i++)m[s.series[i].d]=i; return m; });
  const need=Math.max(floorDollars||250000, 50000);
  const BUCKETS=['up1','up2','up3','up4','up5','down1','down2','down3','down4','down5','flat'];
  const B={}; BUCKETS.forEach(function(k){ B[k]={dayMap:{},n:0,up:0}; });
  let usedDays=0;
  for(let di=0; di<days.length; di++){
    const D=days[di]; const rows=[];
    for(let si=0; si<shares.length; si++){
      const ix=idxmaps[si][D]; if(ix==null) continue;
      const ser=shares[si].series;
      const st=_streakAt(ser, ix); if(!st) continue;
      let vs=0,vn=0; for(let q=Math.max(0,ix-89);q<=ix;q++){ if(ser[q].v>0){vs+=ser[q].v;vn++;} }
      const avgV90=vn>0?vs/vn:0; if(avgV90*ser[ix].c < need) continue;
      const fwd5 = (ix+5<ser.length && ser[ix+5].c>0) ? ((ser[ix+5].c-ser[ix].c)/ser[ix].c)*100 : null;
      if(fwd5==null) continue;
      rows.push({bucket:_streakBucket(st), fwd5:fwd5});
    }
    if(rows.length<30) continue;
    usedDays++;
    let msum=0; for(let r=0;r<rows.length;r++)msum+=rows[r].fwd5;
    const dayMean=msum/rows.length;
    for(let r=0;r<rows.length;r++){
      const exc=rows[r].fwd5-dayMean;
      const b=B[rows[r].bucket]; if(!b)continue;
      if(!b.dayMap[D])b.dayMap[D]=[0,0];
      b.dayMap[D][0]++; b.dayMap[D][1]+=exc; b.n++; if(exc>0)b.up++;
    }
  }
  if(usedDays<20) return null;
  const out={usedDays:usedDays, floor:need, buckets:{}};
  BUCKETS.forEach(function(k){ const b=B[k]; const ct=_clusterT(b.dayMap);
    out.buckets[k]={n:b.n, hitRate:b.n?+(100*b.up/b.n).toFixed(1):0, tstat:+ct.t.toFixed(2), days:ct.days}; });
  return out;
}
function _accScoreReplay(allShares, floorDollars){
  const shares=(Array.isArray(allShares)?allShares:[]).filter(function(s){return Array.isArray(s.series)&&s.series.length>=40;});
  if(shares.length<50) return null;
  const seen={};
  shares.forEach(function(s){ for(let i=0;i<s.series.length;i++){ const d=s.series[i].d; seen[d]=(seen[d]||0)+1; } });
  const floor=Math.max(10,Math.round(shares.length*0.25));
  const cal=Object.keys(seen).filter(function(d){return seen[d]>=floor;}).sort();
  if(cal.length<12) return null;
  const days=cal.slice(0,Math.max(0,cal.length-5)).slice(-250);
  if(!days.length) return null;
  const idxmaps=shares.map(function(s){ const m={}; for(let i=0;i<s.series.length;i++)m[s.series[i].d]=i; return m; });
  const need=Math.max(floorDollars||250000, 50000);
  const AB={}; for(let i=0;i<=10;i++)AB[i]={dayMap:{},n:0,up:0};      // accum bucket 0..10
  const SB={}; ['Minimal','Early','Building','Strong'].forEach(function(b){ SB[b]={dayMap:{},n:0,up:0}; });
  let usedDays=0;
  for(let di=0; di<days.length; di++){
    const D=days[di]; const rows=[];
    for(let si=0; si<shares.length; si++){
      const ix=idxmaps[si][D]; if(ix==null) continue;
      const ser=shares[si].series;
      const st=_accScoreAt(ser, ix); if(!st) continue;
      // liquidity: same $250k tradeable-universe ruler the main engine uses
      let vs=0,vn=0; for(let q=Math.max(0,ix-89);q<=ix;q++){ if(ser[q].v>0){vs+=ser[q].v;vn++;} }
      const avgV90=vn>0?vs/vn:0; if(avgV90*ser[ix].c < need) continue;
      const fwd5 = (ix+5<ser.length && ser[ix+5].c>0) ? ((ser[ix+5].c-ser[ix].c)/ser[ix].c)*100 : null;
      if(fwd5==null) continue;
      rows.push({st:st, fwd5:fwd5});
    }
    if(rows.length<30) continue;
    usedDays++;
    let msum=0; for(let r=0;r<rows.length;r++)msum+=rows[r].fwd5;
    const dayMean=msum/rows.length;   // that day's own $250k-universe mean — same risk-adjustment pattern as the main engine
    for(let r=0;r<rows.length;r++){
      const exc=rows[r].fwd5-dayMean;
      const ab=AB[Math.min(10,rows[r].st.accum)];
      if(!ab.dayMap[D])ab.dayMap[D]=[0,0];
      ab.dayMap[D][0]++; ab.dayMap[D][1]+=exc; ab.n++; if(exc>0)ab.up++;
      const sb=SB[_scoreBand(rows[r].st.score)];
      if(!sb.dayMap[D])sb.dayMap[D]=[0,0];
      sb.dayMap[D][0]++; sb.dayMap[D][1]+=exc; sb.n++; if(exc>0)sb.up++;
    }
  }
  if(usedDays<20) return null;
  const out={usedDays:usedDays, floor:need, byAccum:{}, byScoreBand:{}};
  for(let i=0;i<=10;i++){ const ab=AB[i]; const ct=_clusterT(ab.dayMap);
    out.byAccum[i]={n:ab.n, hitRate:ab.n?+(100*ab.up/ab.n).toFixed(1):0, tstat:+ct.t.toFixed(2), days:ct.days}; }
  ['Minimal','Early','Building','Strong'].forEach(function(b){ const sb=SB[b]; const ct=_clusterT(sb.dayMap);
    out.byScoreBand[b]={n:sb.n, hitRate:sb.n?+(100*sb.up/sb.n).toFixed(1):0, tstat:+ct.t.toFixed(2), days:ct.days}; });
  return out;
}

function scanToday(shares, FACTS, COV, dataDate){
  var out=Object.create(null);
  if(!Array.isArray(shares)||!shares.length)return out;
  var sts=[];
  for(var i=0;i<shares.length;i++){
    var s=shares[i];
    try{
      if(!s||!Array.isArray(s.series)||s.series.length<30)continue;
      var tk=_scTicker(s.ticker); if(!tk)continue;
      var end=s.series.length-1;
      var st=_scStats(s.series,_scPrep(s.series),end); if(!st)continue;
      st._tk=tk;
      var d=s.series[end].d;
      st.newsFact=FACTS?((FACTS[tk+'|'+d]||0)>=0.5):false;
      st.newsEff=(COV&&Object.prototype.hasOwnProperty.call(COV,tk))?st.newsFact:!!st.newsy;
      sts.push(st);
    }catch(e){}
  }
  // the day's market-wide relative-strength cut-off, derived from the day's own
  // population exactly as the replay derives it, so 🏁 means the same thing
  var ds=[]; for(var q=0;q<sts.length;q++){ if(sts[q].d120!=null)ds.push(sts[q].d120); }
  if(ds.length>=30){ ds.sort(function(a,b){return a-b;});
    var cut=ds[Math.min(ds.length-1,Math.floor(ds.length*0.9))];
    for(var q2=0;q2<sts.length;q2++)sts[q2].rslCut=cut; }
  for(var si=0;si<sts.length;si++){
    var hits=[];
    for(var ru=0;ru<_SCAN_RULES.length;ru++){
      var hit=false; try{ hit=!!_SCAN_RULES[ru].t(sts[si]); }catch(e){}
      if(hit)hits.push(_SCAN_RULES[ru].k);
    }
    out[sts[si]._tk]=hits;
  }
  // 🏆 Top 20 is a ranking across the day, not a predicate on a share
  var ranked=sts.filter(function(x){return x.score>0;})
    .sort(function(a,b){return (b.score-a.score)||(b.acc-a.acc);}).slice(0,20);
  for(var t=0;t<ranked.length;t++)out[ranked[t]._tk].push('top20');
  return out;
}


// ═══ HELPERS THE SELECTORS CALL ════════════════════════════════════════════
// Sliced verbatim out of index.html by build_engine_helpers.py. These are the
// app's own functions, not re-implementations — which is the only way the
// server and the app can be relied on to agree.
function typicalDailyMove(series){
  if(!Array.isArray(series)||series.length<4)return 0;
  let sum=0,n=0;
  for(let i=1;i<series.length;i++){
    const p=series[i-1].c, c=series[i].c;
    if(p>0){sum+=Math.abs((c-p)/p)*100;n++;}
  }
  return n>0?sum/n:0;
}

function volSurgeRating(volPct,chgPct){
  if(volPct==null||!isFinite(volPct))return null;
  // Intensity tier from volume alone.
  let tier;
  if(volPct>=1000)     tier={key:'extreme',word:'Extreme',mult:'10×+ average — very rare, usually news or a big event'};
  else if(volPct>=500) tier={key:'redhot', word:'Intense',mult:'6×–11× average — major unusual activity'};
  else if(volPct>=300) tier={key:'hot',    word:'Hot',    mult:'4×–6× average — strong surge'};
  else if(volPct>=150) tier={key:'warm',   word:'Warm',   mult:'2.5×–4× average — clearly above normal'};
  else if(volPct>=60)  tier={key:'mild',   word:'Mild',   mult:'~1.6×–2.5× average — a little busier than usual'};
  else if(volPct>=-30) return{key:'normal',dir:'flat',label:'😐 Normal',color:'#8fa6c9',bg:'rgba(143,166,201,.10)',blurb:'around its typical daily volume'};
  else                 return{key:'cold',  dir:'flat',label:'❄ Quiet', color:'#6b9bd1',bg:'rgba(107,155,209,.12)',blurb:'well below average — unusually quiet'};
  // Direction from the day's price move.
  const up = (chgPct!=null&&isFinite(chgPct)) ? chgPct>0.05 : null;
  const dn = (chgPct!=null&&isFinite(chgPct)) ? chgPct<-0.05 : null;
  let dir,emoji,color,bg,dirWord;
  if(up){ dir='up';   emoji='🟢🔥'; color='#3fb950'; bg='rgba(63,185,80,.14)';  dirWord='buying'; }
  else if(dn){ dir='down'; emoji='🔴🔥'; color='#ff6b6b'; bg='rgba(255,107,107,.14)'; dirWord='selling'; }
  else { dir='flat'; emoji='🔥'; color='#f0b849'; bg='rgba(240,184,73,.13)'; dirWord='activity'; } // no/near-zero move or unknown
  const label = dir==='up'   ? `🟢 ${tier.word} (buying)`
              : dir==='down' ? `🔴 ${tier.word} (selling)`
              :                `🔥 ${tier.word}`;
  return {key:tier.key,dir,label,color,bg,
    blurb:`${tier.mult} · ${dir==='up'?'price UP — heavy buying':dir==='down'?'price DOWN — heavy selling':'flat/unknown move'}`};
}

function scoreUnusual(s){
  const ser=s.series;
  if(!Array.isArray(ser)||ser.length<6)return null;
  const n=ser.length;
  const today=ser[n-1], prev=ser[n-2];
  const older=ser.slice(0,-5).slice(-63); /* v715 */
  let bsum=0,bn=0;older.forEach(x=>{if(x.v>0){bsum+=x.v;bn++;}});
  const baseVol=bn>0?bsum/bn:0;
  const ratio=(baseVol>0&&today.v>0)?today.v/baseVol:0;
  const dayMovePct=(prev.c>0)?((today.c-prev.c)/prev.c)*100:0;
  const hits=[];

  // 1) Volume spike with little price move
  if(ratio>=3 && Math.abs(dayMovePct)<2)
    hits.push({k:'vol-no-move',label:'Volume spike, flat price',w:2});

  // 2) Pre-move drift: last 5 days gently up on rising volume, no news flag yet
  const last5=ser.slice(-6);
  let ups=0, volRising=0;
  for(let i=1;i<last5.length;i++){
    if(last5[i].c>last5[i-1].c)ups++;
    if(last5[i].v>last5[i-1].v)volRising++;
  }
  if(ups>=3 && volRising>=3 && s.newsFlag!=='likely' && Math.abs(dayMovePct)<6)
    hits.push({k:'pre-drift',label:'Quiet drift on rising volume',w:3});

  // 3) Ramp then fade: a big up day in the last 5, now well below that peak
  const window=ser.slice(-6);
  let peak=0,peakIdx=-1;
  for(let i=0;i<window.length;i++){if(window[i].c>peak){peak=window[i].c;peakIdx=i;}}
  if(peakIdx>=0 && peakIdx<window.length-1 && peak>0){
    const fade=((peak-today.c)/peak)*100;
    // was there a sharp run up into that peak?
    const beforePeak=peakIdx>0?window[peakIdx-1].c:0;
    const rampUp=beforePeak>0?((peak-beforePeak)/beforePeak)*100:0;
    if(rampUp>=8 && fade>=6)
      hits.push({k:'ramp-fade',label:'Ramp then fade',w:2});
  }

  // 4) Volume climax after a run: multi-day up streak AND today's volume ≫ base
  if(s.daysUp>=3 && ratio>=4)
    hits.push({k:'vol-climax',label:'Volume climax after run',w:2});

  // 5) Thin-stock large move: low price + big move + big relative volume
  if(s.price>0 && s.price<0.20 && Math.abs(dayMovePct)>=15 && ratio>=3)
    hits.push({k:'thin-move',label:'Thin-stock large move',w:2});

  if(!hits.length)return null;
  const score=hits.reduce((a,h)=>a+h.w,0);
  return {score,hits,ratio:Math.round(ratio*10)/10,dayMovePct:Math.round(dayMovePct*10)/10};
}

function accumDays(s,window){
  const ser=s.series;
  if(!Array.isArray(ser)||ser.length<3)return 0;
  const W=window||10;
  // baseline avg volume from the part of the series BEFORE the window we count
  const older=ser.slice(0,-W);
  let bsum=0,bn=0;(older.length?older:ser).slice(-63).forEach(x=>{if(x.v>0){bsum+=x.v;bn++;}}); /* v700: 3-month baseline */
  const baseVol=bn>0?bsum/bn:(s.avgVol||0);
  if(baseVol<=0)return 0;
  let _endA=ser.length; while(_endA>1&&!(ser[_endA-1].v>baseVol*0.01))_endA--; // v696: window ends at the last REAL session (dust pre-open bars excluded)
  const startIdx=Math.max(1,_endA-W); // first index of the window (need a prior day)
  let count=0;
  for(let i=startIdx;i<_endA;i++){
    const c=ser[i].c, p=ser[i-1].c, v=ser[i].v;
    const priceUp = p>0 && c>p;                 // closed higher than the prior day
    const heavyVol = v>0 && (v/baseVol)>=1.5;   // ≥50% above average
    if(priceUp && heavyVol)count++;
  }
  return count;
}

function watchScore10(s){
  const parts=[];
  // Accumulation backbone: 0.7 pts per qualifying day, up to 7.
  const acc=(typeof accumDays==='function')?accumDays(s,10):(s.accum10||0);
  const accPts=Math.min(7,acc*0.7);
  if(acc>0)parts.push(`Accumulation ${acc}/10 days (${accPts.toFixed(1)})`);
  // Price streak: 0.4 pts per consecutive up-day, up to 1.5.
  const psPts=Math.min(1.5,(s.daysUp||0)*0.4);
  if(s.daysUp>0)parts.push(`${s.daysUp}-day price streak (${psPts.toFixed(1)})`);
  // Volume streak: 0.3 pts per consecutive above-avg day, up to 1.
  const vsPts=Math.min(1,(s.volDays||0)*0.3);
  if(s.volDays>0)parts.push(`${s.volDays}-day volume streak (${vsPts.toFixed(1)})`);
  // Today's momentum: up to 0.5 for a solid green day.
  const mo=s.chgPct>0?Math.min(0.5,s.chgPct/10):0;
  if(mo>0)parts.push(`Up ${s.chgPct.toFixed(1)}% today (${mo.toFixed(1)})`);
  const raw=accPts+psPts+vsPts+mo;
  const score=Math.round(Math.min(10,raw)*10)/10; // one decimal, capped at 10
  return {score,parts,acc};
}

// ═══════════ w528: SCAN-GRADE ENGINE ═══════════
// The app's 50-field per-share grading, ported verbatim from index.html v757
// and PROVEN equivalent (240/240 real-share runs + forced edge cases; see
// claude_w528-server-grading-stage1.md). accumDays/watchScore10 are shared
// with the pick lanes above — accumDays parity-fixed this version (v700).
// Settings are the app DEFAULTS (vol window Auto→90, range window 20):
// server grades are global; a device with changed settings may differ, and
// that is a settings difference, not a bug.
// grading_port.mjs — worker-side grading engine (stage 1, NOT deployed)
// Identical maths to the app v757, packaged for the worker.
// Input: rows in D1-native shape [{d,o,h,l,c,v}] oldest→newest, quote, dataDate.
// ── Settings shims: server-grading defaults (Auto vol window, 20-session range) ──
let volAvgWindow=0;
let rangeWindow=20;
const VOLWIN_STORE='x', RANGEWIN_STORE='x';
const VOLWIN_LABELS={0:'Auto',22:'1-month',66:'3-month',132:'6-month',252:'1-year'};
function qField(q,names){
  // pull the first present field from a quote object, case-insensitively
  for(const n of names){
    if(q[n]!=null)return q[n];
    const lc=n.toLowerCase(), uc=n.charAt(0).toUpperCase()+n.slice(1);
    if(q[lc]!=null)return q[lc];
    if(q[uc]!=null)return q[uc];
  }
  return undefined;
}

function countStreak(history){
  // Count consecutive most-recent days where close > prior day's close.
  // History Quotes have no "previous" field, so compare to the prior row.
  if(!Array.isArray(history)||history.length<2)return 0;
  const getDate=q=>String(qField(q,['dateStamp','date','Date'])||'');
  const getClose=q=>parseFloat(qField(q,['close','Close','c']));
  const h=history.slice().sort((a,b)=>{const da=getDate(a),db=getDate(b);return da<db?1:da>db?-1:0;}); // newest first
  let streak=0;
  for(let i=0;i<h.length-1;i++){
    const close=getClose(h[i]), prevClose=getClose(h[i+1]);
    if(isNaN(close)||isNaN(prevClose))break;
    if(close>prevClose)streak++; else break;
  }
  return streak;
}

function effVolWindow(){ return (typeof volAvgWindow==='number'&&volAvgWindow>0)?volAvgWindow:90; }

function effVolWindowLabel(){ return (typeof volAvgWindow==='number'&&volAvgWindow>0)?(VOLWIN_LABELS[volAvgWindow]||(volAvgWindow+'d')):'3-month'; }

function _engineVolAvg(history,bars){
  if(!Array.isArray(history)||history.length<2)return 0;
  const getDate=q=>String(qField(q,['dateStamp','date','Date'])||'');
  const getVol=q=>parseFloat(qField(q,['volume','Volume','v']));
  const h=history.slice().sort((a,b)=>{const da=getDate(a),db=getDate(b);return da<db?1:da>db?-1:0;});
  const past=h.slice(1);                       // drop today, like the engine
  const take=past.slice(0,Math.max(1,bars||90));
  let sum=0,n=0;
  for(const q of take){ const v=getVol(q); if(!isNaN(v)&&v>0){sum+=v;n++;} }
  return n>0?Math.round(sum/n):0;
}

function computeVolAvg(history,limitDays){
  // Average daily volume over the window, EXCLUDING today's bar. If limitDays
  // given, only bars within that many days are averaged (the 3-month reference).
  if(!Array.isArray(history)||history.length<2)return 0;
  const getDate=q=>String(qField(q,['dateStamp','date','Date'])||'');
  const getVol=q=>parseFloat(qField(q,['volume','Volume','v']));
  let h=history.slice().sort((a,b)=>{const da=getDate(a),db=getDate(b);return da<db?1:da>db?-1:0;});
  const past=h.slice(1); // drop today
  let rows=past;
  if(limitDays){
    // v532 (audit A3): anchor on the NEWEST BAR, never on Date.now(). With
    // stale or restored data the clock-anchored window silently shrank — and
    // past ~90 days old it returned 0, switching every volume flag off with
    // no message at all.
    const anchor=getDate(h[0]).slice(0,10)||new Date().toISOString().slice(0,10);
    const cutoff=new Date(new Date(anchor+'T12:00:00Z').getTime()-limitDays*86400000).toISOString().slice(0,10);
    rows=past.filter(q=>getDate(q).slice(0,10)>=cutoff);
  }
  let sum=0,n=0;
  for(const q of rows){
    const v=getVol(q);
    if(!isNaN(v)&&v>0){sum+=v;n++;}
  }
  return n>0?Math.round(sum/n):0;
}

function _sortedCloses(history){
  // v231: no caching here — a session-long cache retained a second copy of every
  // share's history and pushed low-RAM machines into memory thrash. The prepare
  // loop now sorts once per share explicitly and passes the rows around instead.
  const gd=q=>String(qField(q,['d','dateStamp','date','Date'])||''); // v695: pantry rows are {d,c,v} - without 'd' every server-store row carried a blank date
  const gc=q=>parseFloat(qField(q,['close','Close','c']));
  const gh=q=>parseFloat(qField(q,['high','High','h']));
  const gl=q=>parseFloat(qField(q,['low','Low','l']));
  const gv=q=>parseFloat(qField(q,['volume','Volume','v']));
  const go=q=>parseFloat(qField(q,['open','Open','o']));
  // Plain string compare — ISO dates sort correctly and it's ~20× faster than localeCompare.
  const rows=history.slice().filter(q=>isFinite(gc(q))).sort((a,b)=>{const da=gd(a),db=gd(b);return da<db?-1:da>db?1:0;}); // oldest→newest
  return rows.map(q=>({d:gd(q).slice(0,10),o:go(q),c:gc(q),hi:gh(q),lo:gl(q),v:gv(q)}));
}

function _sma(arr,n){if(arr.length<n)return null;let s=0;for(let i=arr.length-n;i<arr.length;i++)s+=arr[i];return s/n;}

function _rsi(closes,period){
  if(closes.length<period+1)return null;
  // v341: Wilder's RSI (the standard used by virtually every charting platform),
  // replacing a simple last-N average (Cutler's variant) so values match a broker's
  // chart. Seed with the simple average of the first `period` changes, then apply
  // Wilder's smoothing across every later change: avg = (avg*(period-1)+x)/period.
  let gain=0,loss=0;
  for(let i=1;i<=period;i++){ const d=closes[i]-closes[i-1]; if(d>=0)gain+=d; else loss-=d; }
  let ag=gain/period, al=loss/period;
  for(let i=period+1;i<closes.length;i++){ const d=closes[i]-closes[i-1];
    ag=(ag*(period-1)+(d>0?d:0))/period;
    al=(al*(period-1)+(d<0?-d:0))/period;
  }
  if(al===0)return ag===0?50:100; // no losses: flat → neutral, gains → 100
  // v506 — RAW, no rounding. The server's st.rsi is the raw float, and rounding
  // before a threshold test made every device-side band one point wider than
  // the same band on the server (0.499 max deviation, measured). Rounding is a
  // display concern; every display site now rounds for itself.
  const rs=ag/al;return 100-(100/(1+rs));
}

function newsProxy(history){
  if(!Array.isArray(history)||history.length<2)return 'unknown';
  const getDate=q=>String(qField(q,['dateStamp','date','Date'])||'');
  const getClose=q=>parseFloat(qField(q,['close','Close','c']));
  const getVol=q=>parseFloat(qField(q,['volume','Volume','v']));
  const h=history.slice().sort((a,b)=>{const da=getDate(a),db=getDate(b);return da<db?1:da>db?-1:0;}); // newest first
  const last5=h.slice(0,6); // today + up to 5 prior days
  if(last5.length<2)return 'unknown';
  // baseline volume = average of the days beyond the recent window
  const older=h.slice(6,6+63); /* v715: 3-month baseline */
  let bsum=0,bn=0;older.forEach(q=>{const v=getVol(q);if(!isNaN(v)&&v>0){bsum+=v;bn++;}});
  const baseVol=bn>0?bsum/bn:0;
  for(let i=0;i<last5.length-1;i++){
    const c=getClose(last5[i]), p=getClose(last5[i+1]);
    const v=getVol(last5[i]);
    if(!isNaN(c)&&!isNaN(p)&&p>0){
      const move=Math.abs((c-p)/p)*100;
      if(move>=8)return 'likely';                 // sharp single-day move
    }
    if(baseVol>0&&!isNaN(v)&&v/baseVol>=3)return 'likely'; // big volume spike
  }
  return 'quiet';
}

function blockDirection(s){
  if(!s.volCalced||s.avgVol<=0)return '';
  const ratio=s.volume/s.avgVol;
  if(ratio<1.5)return ''; // not an unusual-volume day
  if(s.chgPct>=0.5)return 'up';   // accumulation
  if(s.chgPct<=-0.5)return 'down'; // distribution
  return '';
}

function computeTechnicals(s,history,preRows){
  const rows=preRows||_sortedCloses(history);
  if(rows.length<5)return;
  // Retain the history so range-window changes can recompute instantly without
  // re-fetching. Kept compact (last ~70 rows is plenty for a 3-month range).
  // Retain history so range-window changes AND charts can use it without re-fetch.
  // Keep up to ~260 sessions (about a year) so the chart's 6M/max views have data.
  try{ if(history && history.length) s._history = history.slice(-260); }catch(e){}
  const closes=rows.map(r=>r.c);
  const px=s.price||closes[closes.length-1];

  // Moving averages
  s.ma20=_sma(closes,20); s.ma50=_sma(closes,50); s.ma200=_sma(closes,200);
  s.aboveMA50=(s.ma50!=null&&px>s.ma50);
  s.aboveMA200=(s.ma200!=null&&px>s.ma200);

  // Golden / death cross — 50 crossing 200, checked over the last few days
  if(closes.length>=201){
    const prev50=_sma(closes.slice(0,-1),50), prev200=_sma(closes.slice(0,-1),200);
    if(s.ma50!=null&&s.ma200!=null&&prev50!=null&&prev200!=null){
      if(prev50<=prev200 && s.ma50>s.ma200)s.cross='golden';
      else if(prev50>=prev200 && s.ma50<s.ma200)s.cross='death';
      else s.cross=s.ma50>s.ma200?'bull':'bear';
    }
  }

  // 52-week high / low proximity (uses up to ~252 sessions of history)
  const yr=rows.slice(-252);
  const hi52=Math.max(...yr.map(r=>isFinite(r.hi)?r.hi:r.c));
  const lo52=Math.min(...yr.map(r=>isFinite(r.lo)?r.lo:r.c));
  s.hi52=hi52; s.lo52=lo52;
  // v495 — the ROUNDED figure is for display; the TEST uses the exact one. A
  // share 3.4% below its high rounded to -3 and read as "within 3%".
  const _pfhX=hi52>0?(((px-hi52)/hi52)*100):null;
  const _pflX=lo52>0?(((px-lo52)/lo52)*100):null;
  s.pctFromHigh=_pfhX!=null?Math.round(_pfhX):null;   // 0 = at high, negative = below
  s.pctFromLow=_pflX!=null?Math.round(_pflX):null;    // 0 = at low, positive = above
  s.nearHigh=(_pfhX!=null&&_pfhX>=-3);                // within 3% of 52w high
  s.nearLow=(_pflX!=null&&_pflX<=3);                  // within 3% of 52w low

  // ── TRADING RANGE (selectable window) ───────────────────────────────────
  // The band a share has "normally" traded in over the chosen window (3 days,
  // 1 week, 1 month, or 3 months). We report the floor, the ceiling, where the
  // price sits inside the band right now, and how STABLE/tight that band is.
  // A tight sideways band = a real range; a wide/trending one is flagged so.
  // IMPORTANT: "near the low" is highlighted as WORTH RESEARCHING, never a buy
  // signal — a floor can hold (bounce) or break (keep falling), and end-of-day
  // data cannot tell which in advance.
  const rw = (typeof rangeWindow==='number' && rangeWindow>=3) ? rangeWindow : 20;
  const win=rows.slice(-rw);
  s.rangeWinUsed=win.length;
  const minNeeded = rw<=5 ? 3 : Math.min(10, rw);   // short windows need fewer bars
  if(win.length>=minNeeded){
    const lows=win.map(r=>isFinite(r.lo)?r.lo:r.c);
    const highs=win.map(r=>isFinite(r.hi)?r.hi:r.c);
    const rLow=Math.min(...lows), rHigh=Math.max(...highs);
    s.rangeLow=rLow; s.rangeHigh=rHigh;
    const band=rHigh-rLow;
    // Position of current price inside the band: 0% = at the floor, 100% = at the ceiling.
    s.rangePos = band>0 ? Math.round(((px-rLow)/band)*100) : 50;
    if(s.rangePos<0)s.rangePos=0; if(s.rangePos>100)s.rangePos=100;
    // Band width as a % of price — how wide the range is relative to the share.
    s.rangeWidthPct = px>0 ? Math.round((band/px)*100) : null;
    // STABILITY: how much the daily closes wander vs the band. A low wander
    // relative to a modest band = a stable, sideways range. We grade it.
    const cl=win.map(r=>r.c);
    const mean=cl.reduce((a,b)=>a+b,0)/cl.length;
    const sd=Math.sqrt(cl.map(c=>(c-mean)**2).reduce((a,b)=>a+b,0)/cl.length);
    const cov = mean>0 ? (sd/mean)*100 : 999;   // coefficient of variation, %
    // Trend check: is it drifting rather than ranging? Compare first third vs last third.
    const third=Math.max(2,Math.floor(cl.length/3));
    const firstAvg=cl.slice(0,third).reduce((a,b)=>a+b,0)/third;
    const lastAvg=cl.slice(-third).reduce((a,b)=>a+b,0)/third;
    const driftPct = firstAvg>0 ? Math.abs((lastAvg-firstAvg)/firstAvg)*100 : 0;
    // Grade: tight & sideways => 'stable'; some wander => 'loose'; trending/wide => 'trending'.
    if(driftPct>12 || (s.rangeWidthPct!=null && s.rangeWidthPct>60)) s.rangeStability='trending';
    else if(cov<=6 && driftPct<=6) s.rangeStability='stable';
    else s.rangeStability='loose';
    // "Near the low" = in the bottom fifth of a range that is actually a range
    // (stable or loose, not trending). Highlighted for research, NOT a buy.
    s.nearRangeLow = (s.rangePos<=20 && s.rangeStability!=='trending');
    s.nearRangeHigh = (s.rangePos>=80 && s.rangeStability!=='trending');
  }

  // RSI (14) — classic momentum oscillator
  s.rsi=_rsi(closes,14);
  s.rsiState=s.rsi==null?null:(s.rsi>=70?'overbought':s.rsi<=30?'oversold':'neutral');

  // Gap — today's open vs yesterday's close
  if(rows.length>=2){
    const y=rows[rows.length-2].c, o=rows[rows.length-1].c; // if opens absent, close-to-close proxy
    const tOpen=parseFloat(qField(history.find(q=>String(qField(q,['dateStamp','date','Date'])||'').slice(0,10)===rows[rows.length-1].d)||{},['open','Open','o']));
    const openUsed=isFinite(tOpen)?tOpen:o;
    // v495 — the rounded figure is for display; the tests use the exact one.
    // A 2.5% gap rounded to 3 and flagged as a 3%+ gap up.
    const _gapX=y>0?(((openUsed-y)/y)*100):null;
    s.gapPct=_gapX!=null?Math.round(_gapX):null;
    s.gapUp=(_gapX!=null&&_gapX>=3); s.gapDown=(_gapX!=null&&_gapX<=-3);
  }

  // Volatility — average daily range % over last 14 sessions, and expansion flag
  const recent=rows.slice(-14);
  const ranges=recent.filter(r=>isFinite(r.hi)&&isFinite(r.lo)&&r.c>0).map(r=>((r.hi-r.lo)/r.c)*100);
  if(ranges.length){s.atrPct=Math.round((ranges.reduce((a,b)=>a+b,0)/ranges.length)*10)/10;
    const lastRange=ranges[ranges.length-1];
    s.volExpanding=(lastRange>s.atrPct*1.6);
  }

  // OBV trend — on-balance volume rising or falling over last 20 sessions
  if(rows.length>=21){
    let obv=0; const seq=rows.slice(-21);
    const obvArr=[0];
    for(let i=1;i<seq.length;i++){obv+= (seq[i].c>seq[i-1].c? seq[i].v : seq[i].c<seq[i-1].c? -seq[i].v : 0);obvArr.push(obv);}
    s.obvTrend=obvArr[obvArr.length-1]>obvArr[0]?'rising':obvArr[obvArr.length-1]<obvArr[0]?'falling':'flat';
  }

  // Relative strength vs index (set later if index loaded) — placeholder marker
  s.techCalced=true;
}

function _setPatternFlags(s,hist){
  // v246: one shared routine for the Signals-column flags — previously only
  // live-load helpers computed these, so signals never appeared from saved data.
  // v248: plus the pattern pack — Breakout / Dist? / Vol record / MA cross.
  try{
    const avg90=_engineVolAvg(hist,90)||s.avg3mo||s.avgVol||0; // v532 (A2): engine-identical 90 BARS
    if(!(avg90>0))return;
    if(!s.avg3mo)s.avg3mo=avg90;
    const ratio=s.volume/avg90;
    s.unusualEod=ratio>1.5&&Math.abs(s.chgPct)>2;
    s.blockTrade=ratio>2.0;
    try{ if(typeof blockDirection==='function')s.blockDir=blockDirection(s); }catch(e){}
    s.dirBuy=s.chgPct>0&&s.chgPct<8&&s.volume>5000&&ratio>1.8;
    s.instBuy=s.chgPct>0&&s.volume>30000&&ratio>1.5;
    try{
      const rows=_sortedCloses(hist);
      const n=rows.length;
      s.sigDist = s.chgPct<0 && s.chgPct>-25 && s.volume>5000 && ratio>1.8;
      if(n>=60){
        const lastC=rows[n-1].c, price=(s.price>0?s.price:lastC);
        // compare against PRIOR days only — today tying a flat history is not a record
        // v534 (audit A4): FIXED lookbacks, matching the grading engine (w415).
        // These used to scan the whole stored history, so "breakout" silently
        // meant "highest ever stored" — which got harder every time the pantry
        // deepened (and had nearly killed 🥇 Vol record off entirely once
        // three years were stored). Now: a ONE-YEAR price high, a THREE-MONTH
        // volume record — stable definitions that mean the same thing forever.
        let maxC=0,maxV=0;
        for(let i=Math.max(0,n-1-250);i<n-1;i++){ if(rows[i].c>maxC)maxC=rows[i].c; }
        for(let i=Math.max(0,n-1-60);i<n-1;i++){ if(rows[i].v>maxV)maxV=rows[i].v; }
        s.sigBreakout = price>0 && maxC>0 && price>maxC*1.0005 && ratio>1.5;
        s.sigVolRecord = s.volume>10000 && maxV>0 && s.volume>=maxV*1.05;
        const ma=(len,off)=>{ let t=0,k=0; for(let i=n-1-off;i>=0&&k<len;i--,k++)t+=rows[i].c; return k===len?t/len:0; };
        const m20a=ma(20,0),m50a=ma(50,0),m20b=ma(20,1),m50b=ma(50,1);
        s.sigCross = m20a>0&&m50a>0&&m20b>0&&m50b>0 && m20a>m50a && m20b<=m50b;
      } else { s.sigBreakout=false; s.sigVolRecord=false; s.sigCross=false; }
    }catch(e){}
  }catch(e){}
}

function _liveTodayFix(s, rows, avgV){
  // v692 — the saved series often ends YESTERDAY (today's bar only joins it at
  // the nightly download), while s.volume/chgPct are TODAY's live numbers. The
  // volume streak and 10-day accumulation walked only the series, so "2.6x
  // average today" could sit beside "0 days above avg". If the live bar is not
  // in the series yet, count today as the first step of both walks.
  try{
    var last=(rows&&rows.length)?rows[rows.length-1]:null;
    var liveV=+s.volume||0;
    if(!last||!liveV||!(avgV>0))return;
    // v695: healed rows could carry volume 0 (feed had no volume yet). The walk
    // then broke at the NEWEST bar and reported a 0-day streak beside 2.6x
    // volume. Skip terminal volumeless bars and recompute from real data.
    var k=rows.length-1; while(k>=0 && !((+rows[k].v||+rows[k].volume||0)>0)) k--;
    if(k<rows.length-1){
      var run=0, kk=k;
      while(kk>=0){ var vv=(+rows[kk].v||+rows[kk].volume||0); if(vv>0&&vv>avgV){run++;kk--;} else break; }
      s.volDays=run;
      try{ if(typeof accumDays==='function'&&typeof s.accum10==='number'){ s.accum10=accumDays({series:rows.slice(0,k+1).map(function(r){return {d:r.d||r.dateStamp||'',c:(+r.c||+r.close||0),v:(+r.v||+r.volume||0)};})},10); } }catch(_){}
    }
    if(+last.v===liveV)return;              // series already carries today's bar
    if(s.chgPct==null)return;               // no live day to add
    if(liveV>avgV) s.volDays=(s.volDays||0)+1; else s.volDays=0;
    if(typeof s.accum10==='number'){
      var heavy=(liveV/avgV)>=1.5, held=(+s.chgPct)>=-5;
      if(heavy&&held) s.accum10=Math.min(10,(s.accum10||0)+1);
    }
  }catch(_){ }
}






function _scanGradeShare(rows, quote, dataDate){
  const s=Object.assign({}, quote);
  // INPUT CONTRACT: rows carry a `date` key (SELECT d AS date …), matching what
  // /history/series serves the device. countStreak and computeVolAvg resolve
  // dates via qField(['dateStamp','date','Date']) — WITHOUT 'd' — so raw pantry
  // rows silently break them (the v695 class of bug; _sortedCloses was fixed,
  // these two were not). Normalize defensively so the contract cannot be
  // violated without this line catching it.
  const hist=rows.map(r=>(r.date!=null||r.d==null)?r:Object.assign({date:r.d},r));
  if(!Array.isArray(hist)||hist.length<2) return {ok:false, s};
  s.daysUp=countStreak(hist);s.streakCalced=true;
  s.newsFlag=newsProxy(hist);
  const srows=_sortedCloses(hist);
  try{ s.series=srows.map(r=>({d:r.d,c:r.c,v:r.v})); }catch(e){}
  const avg3=computeVolAvg(hist,effVolWindow());
  if(avg3>0){s.avg3mo=avg3;s.avgVol=avg3;s.volPct=Math.round(((s.volume-avg3)/avg3)*100);s.volCalced=true;s.volWindow=effVolWindowLabel();}
  _setPatternFlags(s,hist);
  try{
    if((s.chgAbs===0||s.chgAbs==null)&&(s.chgPct===0||s.chgPct==null)&&srows.length>=2&&s.price>0){
      const _dd=dataDate||null;
      const _lastD=srows[srows.length-1].d;
      const _prevC=(_dd&&_lastD===_dd&&srows.length>=2)?srows[srows.length-2].c:srows[srows.length-1].c;
      if(_prevC>0&&_prevC!==s.price){ s.chgAbs=s.price-_prevC; s.chgPct=((s.price-_prevC)/_prevC)*100; _setPatternFlags(s,hist); }
    }
  }catch(e){}
  try{
    const rows2=srows;
    const older=rows2.slice(0,-5);
    let vs=0,vn=0; older.slice(-63).forEach(x=>{const v=x.v; if(v>0){vs+=v;vn++;}});
    const avgV=vn>0?vs/vn:(s.avgVol||0);
    let vrun=0;
    if(avgV>0){ let k=rows2.length-1; while(k>=0&&!(rows2[k].v>avgV*0.01))k--; for(;k>=0;k--){ if(rows2[k].v>0 && rows2[k].v>avgV)vrun++; else break; } }
    s.volDays=vrun; s.volStreakCalced=true; _liveTodayFix(s,rows2,avgV);
  }catch(e){}
  computeTechnicals(s,hist,srows);
  s.accum10=accumDays(s,10);
  s.watchScore=watchScore10(s).score;
  return {ok:true, s};
}

// ── w528: nightly scan-grade builder ────────────────────────────────────────
// Grades EVERY pantry ticker (>=2 bars in the 365-day window) with the app's
// exact maths and stores one compact row per ticker in scan_grades. Cursor-
// stepped (meta sg_cursor_EXCH) with a CPU time guard so a cron that runs out
// resumes on the next firing; st.scanGrades only sets when the pass completes.
async function _scanGradesEnsure(env){
  await env.MARKET_DB.prepare('CREATE TABLE IF NOT EXISTS scan_grades (exch TEXT NOT NULL, ticker TEXT NOT NULL, d TEXT NOT NULL, g TEXT NOT NULL, PRIMARY KEY (exch,ticker))').run();
}
function _sgQuoteFrom(rows){
  // EOD quote exactly as the equivalence harness constructed it: last close /
  // last volume, change from the prior close.
  const last=rows[rows.length-1], prev=rows.length>=2?rows[rows.length-2]:null;
  return { price:last.c, volume:last.v,
    chgAbs:(prev&&prev.c>0)?(last.c-prev.c):0,
    chgPct:(prev&&prev.c>0)?(((last.c-prev.c)/prev.c)*100):0 };
}
async function _scanGradeStep(env, exch, budgetMs){
  await _scanGradesEnsure(env);
  const mx = await env.MARKET_DB.prepare('SELECT MAX(d) AS d FROM bars WHERE exch=?').bind(exch).first();
  const day = mx && mx.d; if(!day) return { error:'no bars for '+exch };
  const curK='sg_cursor_'+exch, dayK='sg_day_'+exch;
  let cur=parseInt(await _getMeta(env,curK)||'0',10)||0;
  const stampedDay=await _getMeta(env,dayK);
  if(stampedDay!==day){ cur=0; await _setMeta(env,dayK,day); }   // new day → restart
  // w554: only tickers that TRADED on the day - a share with no bar today cannot be tonight's pick.
  const tickers=(await env.MARKET_DB.prepare('SELECT DISTINCT ticker FROM bars WHERE exch=? AND d=? ORDER BY ticker').bind(exch,day).all()).results.map(r=>r.ticker);
  const total=tickers.length;
  if(cur>=total){ return { done:true, day, cursor:cur, total }; }
  const t0=Date.now(); const lim=budgetMs||4000;
  const fromD=new Date(day+'T00:00:00Z'); fromD.setUTCDate(fromD.getUTCDate()-365);
  const from=fromD.toISOString().slice(0,10);
  let graded=0; const CH=40;
  while(cur<total && (Date.now()-t0)<lim){
    const batch=tickers.slice(cur,cur+CH);
    const marks=batch.map(()=>'?').join(',');
    const res=await env.MARKET_DB.prepare('SELECT ticker,d AS date,o,h,l,c,v FROM bars WHERE exch=? AND d>=? AND ticker IN ('+marks+') ORDER BY ticker,d').bind(exch,from,...batch).all();
    const by={}; for(const r of res.results){ (by[r.ticker]=by[r.ticker]||[]).push(r); }
    const ins=[];
    for(const tk of batch){
      const rows=by[tk]||[];
      if(rows.length<2) continue;                 // same bar as the app: <2 rows → not graded
      try{
        const g=_scanGradeShare(rows,_sgQuoteFrom(rows),day);
        if(!g.ok) continue;
        delete g.s.series;                        // redundant with bars; keep rows compact
        delete g.s._history;
        ins.push(env.MARKET_DB.prepare('INSERT INTO scan_grades (exch,ticker,d,g) VALUES (?,?,?,?) ON CONFLICT(exch,ticker) DO UPDATE SET d=excluded.d, g=excluded.g').bind(exch,tk,day,JSON.stringify(g.s)));
        graded++;
      }catch(e){}
    }
    if(ins.length) await env.MARKET_DB.batch(ins);
    cur+=batch.length;
  }
  await _setMeta(env,curK,String(cur));
  return { done: cur>=total, day, cursor:cur, total, graded };
}




// The liquidity floor is USER-SET and stays visible by design (v480), so it is
// not hidden on the server — it arrives as context instead of being read off a
// global filter object.
function _liqPassCtx(s,cap){
  if(!cap||cap==='any')return true;
  var liq=((s.avgVol>0?s.avgVol:(s.volume||0))*(s.price||0));
  var need=cap==='l50'?50e3:cap==='l250'?250e3:cap==='l1m'?1e6:0;
  return liq>=need;
}

// ═══ THE ADAPTER ═══════════════════════════════════════════════════════════
// Assembles a share object shaped exactly as the app's, out of the engine's own
// stats plus the day's bar from D1. This is what lets the twelve report
// selectors run UNMODIFIED — the entire point of cutting them across rather
// than rewriting them.
//
// If a field is missing the selectors do not fail; they read `undefined` and
// quietly pick differently. So every field is set explicitly, and the adapter
// is checked field-by-field against a real app share rather than eyeballed.
function _scShare(ticker,exch,ser,st,bar,name){
  var end=ser.length-1, px=st.c;
  var prev=(end>=1)?ser[end-1].c:px;
  return {
    ticker:ticker, exchange:exch, name:name||'', type:'Ordinary',
    series:ser,
    price:px, close:px, prevClose:prev,
    chgPct:st.chg, chgAbs:(px-prev),
    volume:ser[end].v, avgVol:st.appAvgVol, avg3mo:st.appAvgVol, volPct:st.appVolPct,
    volCalced:(st.appVolPct!=null), streakCalced:true, volStreakCalced:true, techCalced:true,
    daysUp:st.du, daysDown:st.daysDown, volDays:st.volDays, accum10:st.acc,
    watchScore:st.score,
    ma20:st.ma20, ma50:st.ma50, ma200:st.ma200, rsi:st.appRsi,
    aboveMA50:st.aboveMA50, aboveMA200:st.aboveMA200,
    nearHigh:st.nearHigh, nearLow:st.nearLow,
    pctFromHigh:st.pctFromHigh, pctFromLow:st.pctFromLow,
    cross:st.cross, rsiState:st.rsiState, obvTrend:st.obvTrend,
    gapUp:st.gapUp, gapPct:st.gapPct, atrPct:st.atrPct, volExpanding:st.volExpanding,
    // today's bar, which Gap Report and Quiet Movers read for the open and high
    _q:bar?{d:ser[end].d,c:px,v:ser[end].v,o:bar.o,h:bar.h,l:bar.l}:null,
    mc:px*(ser[end].v||0)
  };
}


// ═══ THE TWELVE REPORT SELECTORS ═══════════════════════════════════════════
// Sliced verbatim out of index.html by build_engine_selectors.py — the same
// functions the app runs, not re-implementations. Two mechanical edits only:
// SPEED_PRESETS travels with them, and _liqPass (which read the app's filter
// state) becomes _liqPassOf, which reads the floor off the array it is handed
// so that one request's liquidity setting can never reach another's.
var SPEED_PRESETS={
  strict:{moveMult:4,   volRatio:3, minMove:12, label:'strict'},
  normal:{moveMult:3,   volRatio:2, minMove:8,  label:'normal'},
  loose: {moveMult:2,   volRatio:1.5,minMove:5,  label:'loose'}
};

// The liquidity floor rides on the array, not on a module variable — a module
// variable in a Worker outlives the request that set it.
function _liqPassOf(s,shares){
  return _liqPassCtx(s,(shares&&shares.cap)||'any');
}

function _selTechnical(have){
  // Rank: reward fresh golden cross, near-high momentum, healthy RSI, rising OBV
  have.forEach(s=>{
    let sc=0;
    if(s.cross==='golden')sc+=5; else if(s.cross==='bull')sc+=1.5; else if(s.cross==='death')sc-=4;
    if(s.nearHigh)sc+=2.5; if(s.nearLow)sc-=1;
    if(s.aboveMA200)sc+=1.5;
    if(s.rsiState==='oversold')sc+=1.5; if(s.rsiState==='overbought')sc-=1;
    if(s.obvTrend==='rising')sc+=1.5; if(s.obvTrend==='falling')sc-=1;
    if(s.gapUp)sc+=1; if(s.volExpanding)sc+=0.5;
    s.techScore=Math.round(sc*10)/10;
  });
  return have.slice().sort((a,b)=>(b.techScore||0)-(a.techScore||0));
}

function _selAllSignals(shares){
  const P=SPEED_PRESETS.normal;
  const scored=[];
  const totals={sharp:0,unusual:0,surge:0,pstreak:0,vstreak:0,accum:0,score:0};
  for(const s of shares){
    if(!(s.price>0))continue;
    const sigs=[];
    // 🚨 sharp mover (same maths as the Sharp Mover Detector, normal sensitivity)
    if(s.volCalced){
      const move=Math.abs(s.chgPct||0);
      if(move>=P.minMove){
        const typical=typicalDailyMove(s.series)||move;
        const moveMult=typical>0?move/typical:0;
        const volRatio=s.avgVol>0?s.volume/s.avgVol:0;
        if(moveMult>=P.moveMult&&volRatio>=P.volRatio){sigs.push('🚨 sharp');totals.sharp++;}
      }
    }
    // 🔍 unusual activity (any of the five patterns)
    const u=(typeof scoreUnusual==='function')?scoreUnusual(s):null;
    if(u&&u.score>0){sigs.push('🔍 unusual');totals.unusual++;}
    // core signals
    if(s.volCalced&&s.volPct>=50){sigs.push('📊 vol+50%');totals.surge++;}
    if((s.daysUp||0)>=3){sigs.push('📈 streak3+');totals.pstreak++;}
    if((s.volDays||0)>=3){sigs.push('🔵 volstrk3+');totals.vstreak++;}
    if((s.accum10||0)>=5){sigs.push('🔥 accum5+');totals.accum++;}
    if((s.watchScore||0)>=7){sigs.push('⭐ 7+/10');totals.score++;}
    // Keep anything sharp/unusual, or with 2+ core signals stacking up.
    if(sigs.length&&(sigs.some(x=>x.includes('sharp')||x.includes('unusual'))||sigs.length>=2)){
      s.allSigN=sigs.length;s.allSigList=sigs.join(' · ');
      scored.push(s);
    }else{s.allSigN=0;s.allSigList='';}
  }
  scored.sort((a,b)=>b.allSigN-a.allSigN||(b.watchScore||0)-(a.watchScore||0));
  return {rows:scored,totals:totals};
}

function _selUnusual(shares){
  const scored=[];
  for(const s of shares){
    const r=scoreUnusual(s);
    if(r){s.unusualScore=r.score;s.unusualHits=r.hits;s.unusualMeta=r;scored.push(s);}
    else{s.unusualScore=0;s.unusualHits=null;}
  }
  scored.sort((a,b)=>b.unusualScore-a.unusualScore || b.volPct-a.volPct);
  return scored;
}

function _selVolumeSurge(shares){
  const rows=[];
  for(const s of shares){
    if(!(s.price>0)||!s.volCalced||!isFinite(s.volPct))continue;
    const r=(typeof volSurgeRating==='function')?volSurgeRating(s.volPct,s.chgPct):null;
    if(!r)continue;
    s._surgeKey=r.key; s._surgeLabel=r.label;
    try{ const w=watchScore10(s); s.watchScore=w.score; }catch(e){}
    rows.push({s,r});
  }
  rows.sort((a,b)=>b.s.volPct-a.s.volPct);
  return rows;
}

async function _selTopTen(shares){
  const scored=[];
  for(let _j=0;_j<shares.length;_j++){
    if((_j&255)===0&&_j>0)await new Promise(_r=>setTimeout(_r,0)); // v335: chunk the scoring pass too — keep the phone responsive
    const s=shares[_j];
    if(!(s.price>0))continue;
    const r=watchScore10(s);
    s.watchScore=r.score;      // /10 for the table column + sorting
    s.watchParts=r.parts;
    if(r.score>0)scored.push({s,r});
  }
  scored.sort((a,b)=>b.r.score-a.r.score || (b.r.acc-a.r.acc));
  return scored;
}

function _selGaps(shares){
  let priced=0,noOpen=0;
  const rows=[];
  for(const s of shares){
    if(!(s.price>0))continue; priced++;
    if(!_liqPassOf(s,shares))continue;
    const q=s._q||null;
    const o=(q&&q.o!=null&&isFinite(q.o)&&q.o>0)?q.o:null;
    if(o==null){noOpen++;continue;}
    // yesterday's close: series (freshened = today is last row), else derive from day change
    let pc=null;
    if(Array.isArray(s.series)&&s.series.length>=2){
      const L=s.series[s.series.length-1],P=s.series[s.series.length-2];
      if(q&&q.d&&L&&L.d===q.d){ if(P&&P.c>0)pc=P.c; }
      else if(L&&L.c>0)pc=L.c;
    }
    if(!(pc>0)&&s.chgAbs!=null&&isFinite(s.chgAbs)){const g=s.price-s.chgAbs;if(g>0)pc=g;}
    if(!(pc>0)||pc<0.05)continue;                        // micro-price tick noise isn't a gap
    if(((s.volume||0)*(s.price||0))<20000)continue;      // near-zero turnover — not meaningful
    const gapPct=((o-pc)/pc)*100;
    if(Math.abs(gapPct)<3||Math.abs(gapPct)>60)continue; // 3%+ is a real gap; >60% ≈ data glitch
    const kept=(o!==pc)?((s.price-pc)/(o-pc)):0;         // 1 = kept the whole gap, 0 = back to yesterday
    let bucket,seq;
    if(gapPct>0){ bucket=kept>=0.75?'heldUp':(kept<=0.35?'fadedUp':'partUp'); seq=bucket==='heldUp'?0:(bucket==='partUp'?1:2); }
    else{ bucket=kept<=0.35?'downRec':(kept>=0.75?'downWeak':'downPart'); seq=bucket==='downRec'?3:(bucket==='downPart'?4:5); }
    s._gapPct=Math.round(gapPct*10)/10; s._gapKept=Math.max(-99,Math.min(199,Math.round(kept*100))); s._gapBucket=bucket;
    try{ const r=watchScore10(s); s.watchScore=r.score; }catch(e){}
    rows.push({s,seq,gap:gapPct});
  }
  rows.sort((a,b)=>a.seq-b.seq||Math.abs(b.gap)-Math.abs(a.gap));
  return {rows:rows,priced:priced,noOpen:noOpen};
}

function _selSmartCandidates(shares,minDays,scanAll){
  minDays=minDays||2;
  const CAND=60;
  let candidates=shares
    .filter(s=>s.price>0 && (scanAll? Math.abs(s.chgPct)>0.5 : s.chgPct>0.5)
      && s.volCalced && isFinite(s.volPct) && s.volPct>=30
      && (scanAll? true : (s.streakCalced && s.daysUp>=minDays)))
    .sort((a,b)=>b.volPct-a.volPct)
    .slice(0,CAND);
  let gate=scanAll?'all+vol':'vol+up+streak';
  if(!candidates.length){
    // Relax the streak gate (keep up+volume) in case the streak data is thin
    candidates=shares
      .filter(s=>s.price>0 && (scanAll? Math.abs(s.chgPct)>0.5 : s.chgPct>0.5) && s.volCalced && isFinite(s.volPct) && s.volPct>=30)
      .sort((a,b)=>b.volPct-a.volPct).slice(0,CAND);
    gate=scanAll?'all+vol':'vol+up';
  }
  if(!candidates.length){
    candidates=shares.filter(s=>s.price>0 && (scanAll? s.chgPct!==0 : s.chgPct>0))
      .sort((a,b)=>(b.volume||0)-(a.volume||0)).slice(0,CAND);
    gate=scanAll?'all-only':'up-only';
  }
  return {candidates:candidates,gate:gate};
}

function _selPullback(shares){
  const scored=[];
  for(const s of shares){
    if(!(s.price>0))continue;
    if(s.ma20==null||s.ma50==null)continue;                       // need at least a 50-day structure
    const px=s.price;
    // established uptrend: prefer 200-day confirmation, else fall back to the 50-day
    const up=(s.ma200!=null)?(px>s.ma200 && s.ma50>s.ma200):(px>s.ma50);
    if(!up)continue;
    // momentum cooled into the buy-the-dip band
    if(!(s.rsi!=null && s.rsi>=35 && s.rsi<=55))continue;
    // pulled back to hug the 20-day line
    const dMa20=((px-s.ma20)/s.ma20)*100;
    if(!(dMa20>=-5 && dMa20<=8))continue;
    // shallow, healthy pullback — not collapsed through the 50-day
    const dMa50=((px-s.ma50)/s.ma50)*100;
    if(dMa50<-7)continue;
    const near=Math.abs(dMa20);
    const rsiMid=Math.abs(s.rsi-45);
    const trend=(s.ma200!=null&&s.ma200>0)?((s.ma50-s.ma200)/s.ma200)*100:0;
    const score=Math.max(0,3-near/3)+Math.max(0,2-rsiMid/5)+Math.min(2,Math.max(0,trend)/5)+(s.aboveMA50?1:0)+Math.min(2,(s.accum10||0)*0.2);
    s._pbDma20=Math.round(dMa20*10)/10; s._pbRsi=Math.round(s.rsi);
    try{ const r=watchScore10(s); s.watchScore=r.score; }catch(e){}
    scored.push({s,score});
  }
  scored.sort((a,b)=>b.score-a.score);
  return scored;
}

function _selStrongTrends(shares){
  let have200=0,nearStack=0;
  const scored=[];
  for(const s of shares){
    if(!(s.price>0))continue;
    if(!_liqPassOf(s,shares))continue;
    const px=s.price;
    if(s.ma200!=null&&s.ma200>0)have200++;
    const short=(s.ma20!=null&&s.ma50!=null&&px>s.ma20&&s.ma20>s.ma50);
    if(short&&!(s.ma200!=null&&s.ma200>0))nearStack++;
    if(!(s.ma20!=null&&s.ma50!=null&&s.ma200!=null&&s.ma200>0))continue;
    if(!(px>s.ma20&&s.ma20>s.ma50&&s.ma50>s.ma200))continue;   // the full stack
    const trend=((s.ma50-s.ma200)/s.ma200)*100;                // slope of the big structure
    const ext=((px-s.ma20)/s.ma20)*100;                        // stretch above the 20-day
    const score=Math.min(4,Math.max(0,trend)/4)
              + Math.max(0,2-Math.abs(ext)/4)                  // orderly beats overstretched
              + Math.min(2,(s.accum10||0)*0.2)
              + (s.nearHigh?1:0)
              + ((s.rsi!=null&&s.rsi>=50&&s.rsi<=70)?1:0);     // healthy, not overbought
    s._tsTrend=Math.round(trend*10)/10; s._tsExt=Math.round(ext*10)/10;
    try{ const r=watchScore10(s); s.watchScore=r.score; }catch(e){}
    scored.push({s,score});
  }
  scored.sort((a,b)=>b.score-a.score);
  return {rows:scored,have200:have200,nearStack:nearStack};
}

function _selRecovery(shares){
  // Primary: been falling 2+ consecutive days, volume elevated, price stabilising
  let rows=shares.filter(s=>{
    if(!(s.price>0))return false;
    if(!s.volCalced||!isFinite(s.volPct))return false;
    const falling=(s.streakCalced&&(s.daysDown||0)>=2);   // v447: the primary branch finally works — daysUp<=-2 was never true
    const volumeUp=(s.volPct>=50);
    const stabilising=(s.chgPct>=-2);  // not accelerating downward
    return falling&&volumeUp&&stabilising;
  });
  // Fallback: very high volume + small price move = possible basing after a fall
  if(rows.length<5){
    rows=shares.filter(s=>{
      if(!(s.price>0))return false;
      if(!s.volCalced||!isFinite(s.volPct))return false;
      return s.volPct>=100&&s.chgPct>=-1&&s.chgPct<=3;
    });
  }
  // Sort: shares turning positive today first, then by volume lift
  rows.sort((a,b)=>{
    const aUp=(a.chgPct>0)?1:0,bUp=(b.chgPct>0)?1:0;
    if(bUp!==aUp)return bUp-aUp;
    return (b.volPct||0)-(a.volPct||0);
  });
  return rows.slice(0,40);
}

function _selQuietMovers(shares){
  const LO=-5,HI=5;                     // "small net move today" band
  const scored=[]; let fadeCount=0;
  for(const s of shares){
    if(!(s.price>0))continue;
    const chg=s.chgPct||0;
    if(!(chg>=LO&&chg<=HI))continue;    // must be a small move today
    // recent trend (5-day gain from the close series)
    let gain5=0;
    if(Array.isArray(s.series)&&s.series.length>=6){
      const c0=s.series[s.series.length-1].c, c5=s.series[s.series.length-6].c;
      if(c5>0)gain5=((c0-c5)/c5)*100;
    }
    const upStreak=!!(s.streakCalced&&s.daysUp>=2);
    const accum=(s.accum10!=null&&s.accum10>=4);
    const coiling=(gain5>=3)||upStreak||accum;                 // quietly building
    // intraday fade: high well above the close while the day finished flat/down
    let fade=0; const hi=(s._q&&s._q.h)||0, cl=s.price;
    if(hi>0&&cl>0){ const hp=((hi-cl)/cl)*100; if(hp>=3 && chg<=1.5) fade=hp; }
    const volUp=!!(s.volCalced&&s.volPct>=80);                 // heavy volume, flat price
    if(!(coiling||fade>0||volUp))continue;                     // needs SOMETHING underneath
    if(fade>0)fadeCount++;
    try{ const r=watchScore10(s); s.watchScore=r.score; }catch(e){}
    s._qmFade=Math.round(fade*10)/10; s._qmGain5=Math.round(gain5*10)/10;
    const score=Math.min(3,(accum?s.accum10*0.3:0))
              + Math.min(2,Math.max(0,gain5)/5)
              + (upStreak?1:0)
              + Math.min(2,(s.volCalced?Math.max(0,s.volPct):0)/150)
              + Math.min(2.5,fade/3);
    scored.push({s,score});
  }
  scored.sort((a,b)=>b.score-a.score);
  return {rows:scored,fadeCount:fadeCount};
}

function _selSharpMovers(shares,sensitivity){
  const P=SPEED_PRESETS[sensitivity]||SPEED_PRESETS.normal;
  const scored=[];
  for(const s of shares){
    if(!(s.price>0&&s.volCalced))continue;
    const move=Math.abs(s.chgPct);
    if(move<P.minMove)continue;                 // floor: ignore tiny moves regardless
    const typical=typicalDailyMove(s.series)||move; // fallback if no series
    const moveMult=typical>0?move/typical:0;    // today's move ÷ its normal daily move
    const volRatio=s.avgVol>0?s.volume/s.avgVol:0;
    // Require BOTH the move and the volume to be abnormal for this share.
    if(moveMult<P.moveMult||volRatio<P.volRatio)continue;
    // Abnormality score: how many "typical days" of move, times how many times
    // normal volume — a single number capturing "how hard is this speeding".
    const score=Math.round(moveMult*Math.min(volRatio,10)*10)/10;
    s.speedScore=score;
    s.speedMoveMult=Math.round(moveMult*10)/10;
    s.speedVolRatio=Math.round(volRatio*10)/10;
    scored.push(s);
  }
  scored.sort((a,b)=>b.speedScore-a.speedScore);
  return scored;
}

// The names the worker dispatches on. Kept next to the functions so adding a
// report cannot leave the dispatch table behind.
var _SCAN_SELECTORS={
  technical:_selTechnical, allSignals:_selAllSignals, unusual:_selUnusual,
  volumeSurge:_selVolumeSurge, topTen:_selTopTen, gaps:_selGaps,
  smart:_selSmartCandidates, pullback:_selPullback, strongTrends:_selStrongTrends,
  recovery:_selRecovery, quietMovers:_selQuietMovers, sharpMovers:_selSharpMovers
};

// The rule keys the server knows about, so the app can check the two agree.
function scanRuleKeys(){ return _SCAN_RULES.map(function(x){return x.k;}).concat(['top20']); }

// ── w391/w392: the news facts the 📰 rule needs, read from our own store ──
// Runs only on a cache MISS. It was running unconditionally, including on the
// deliberately-cheap probe, at 200,000 D1 row-reads a time.
async function _scanNewsMaps(env, exch){
  try{
    if(!env.MARKET_DB || !_newsOn(env))return { FACTS:null, COV:null };
    if(!(await _newsEnsure(env)))return { FACTS:null, COV:null };
    const from = new Date(Date.now() - 420*864e5).toISOString().slice(0,10);
    const r = await env.MARKET_DB.prepare(
      'SELECT ticker,d,MAX(weight) AS w FROM news WHERE exch=? AND d>=? GROUP BY ticker,d LIMIT 200000'
    ).bind(_newsExch(exch), from).all();
    const rows = (r && r.results) || [];
    if(!rows.length)return { FACTS:null, COV:null };
    const FACTS = Object.create(null), COV = Object.create(null);
    for(const x of rows){
      const k = x.ticker + '|' + x.d, w = +x.w || 0;
      if(!(FACTS[k] >= w))FACTS[k] = w;
      COV[x.ticker] = 1;
    }
    return { FACTS, COV };
  }catch(e){ return { FACTS:null, COV:null }; }   // dormant news → the rule never fires
}




// ═══ w401 — BACKING THE PANTRY UP, AND GETTING IT BACK ═════════════════════
// Monthly NDJSON: one JSON object per line, one file per exchange per month.
// ~90,000 rows and ~6 MB for an ASX month — a size a browser can hold, write to
// disk, and hand straight back. One 120 MB file would have been tidier and
// unusable.
function _pantryLine(x) {
  return JSON.stringify({ t: x.ticker, d: x.d, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v });
}

// What months exist and how big they are. A full scan of the store, so it runs
// on a button press rather than anywhere near a customer request.
async function pantryMonths(env) {
  const out = [];
  try {
    const r = await env.MARKET_DB.prepare(
      'SELECT exch, substr(d,1,7) AS ym, COUNT(*) AS rows, COUNT(DISTINCT d) AS days, MIN(d) AS f, MAX(d) AS t ' +
      'FROM bars GROUP BY exch, ym ORDER BY exch, ym DESC').all();
    for (const x of ((r && r.results) || [])) {
      out.push({ exch: x.exch, ym: x.ym, rows: x.rows, days: x.days, from: x.f, to: x.t });
    }
  } catch (e) {}
  return out;
}

async function pantryExport(env, exch, ym) {
  // ym is YYYY-MM. The range is [ym-01, next month) — string comparison, which
  // is exactly right for ISO dates and needs no date arithmetic.
  const from = ym + '-01';
  let y = +ym.slice(0, 4), m = +ym.slice(5, 7) + 1;
  if (m > 12) { m = 1; y++; }
  const to = y + '-' + String(m).padStart(2, '0') + '-01';
  const r = await env.MARKET_DB.prepare(
    'SELECT ticker, d, o, h, l, c, v FROM bars WHERE exch=? AND d>=? AND d<? ORDER BY d, ticker')
    .bind(exch, from, to).all();
  const rows = (r && r.results) || [];
  const lines = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) lines[i] = _pantryLine(rows[i]);
  return { text: lines.join('\n'), n: rows.length, from, to };
}

// Rows back in. Same shape that came out, upserted — so a restore over a store
// that already holds the day is a no-op rather than a duplicate.
async function pantryImport(env, exch, lines) {
  const sql = 'INSERT INTO bars (exch,ticker,d,o,h,l,c,v) VALUES (?,?,?,?,?,?,?,?) ' +
    'ON CONFLICT(exch,ticker,d) DO UPDATE SET o=excluded.o,h=excluded.h,l=excluded.l,c=excluded.c,v=excluded.v';
  const stmt = env.MARKET_DB.prepare(sql);
  const batch = [];
  let bad = 0;
  for (let i = 0; i < lines.length; i++) {
    const s = String(lines[i] || '').trim();
    if (!s) continue;
    let x = null;
    try { x = JSON.parse(s); } catch (e) { bad++; continue; }
    if (!x || !x.t || !x.d) { bad++; continue; }
    batch.push(stmt.bind(exch, String(x.t).slice(0, 16), String(x.d).slice(0, 10),
      +x.o, +x.h, +x.l, +x.c, +x.v));
  }
  let written = 0;
  const CHUNK = 200;
  for (let i = 0; i < batch.length; i += CHUNK) {
    const part = batch.slice(i, i + CHUNK);
    if (part.length) { await env.MARKET_DB.batch(part); written += part.length; }
  }
  return { written, skipped: bad };
}

// The automatic copy — only if a bucket is bound. Absent, every path above
// still works and the status says plainly that it is not configured, rather
// than erroring or half-succeeding.
function _r2On(env) { return !!(env && env.PANTRY_R2); }
async function pantryToR2(env, exch, date) {
  if (!_r2On(env)) return { ok: false, why: 'no R2 bucket bound' };
  try {
    const r = await env.MARKET_DB.prepare(
      'SELECT ticker, d, o, h, l, c, v FROM bars WHERE exch=? AND d=?').bind(exch, date).all();
    const rows = (r && r.results) || [];
    if (!rows.length) return { ok: false, why: 'no rows for ' + exch + ' ' + date };
    const body = rows.map(_pantryLine).join('\n');
    await env.PANTRY_R2.put('bars/' + exch + '/' + date + '.ndjson', body, {
      httpMetadata: { contentType: 'application/x-ndjson' }
    });
    await _setMeta(env, 'r2_' + exch, date);
    return { ok: true, exch, date, rows: rows.length, bytes: body.length };
  } catch (e) { return { ok: false, why: String(e).slice(0, 120) }; }
}

// ═══ w400 — THE 52-WEEK TABLE ══════════════════════════════════════════════
// One row per share: the extremes a year of real highs and lows gives you.
// Built after the day's ingest, read back per request as a single indexed
// lookup. The alternative — reading a year of bars for every share on every
// request — is about 1.3 million rows, which is why this exists.
async function _tech52Init(env) {
  try {
    await env.MARKET_DB.prepare(
      'CREATE TABLE IF NOT EXISTS tech52 (exch TEXT, ticker TEXT, d TEXT, hi52 REAL, lo52 REAL, atr14 REAL, rngLast REAL, PRIMARY KEY (exch,ticker))').run();
    return true;
  } catch (e) { return false; }
}

// The date 252 stored trading days back. Counting DISTINCT days rather than
// subtracting 52 weeks of calendar time, because holidays and suspensions make
// those two different windows — and the app counts ROWS, not dates.
async function _tech52Cutoff(env, exch, n) {
  try {
    const r = await env.MARKET_DB.prepare(
      'SELECT d FROM (SELECT DISTINCT d FROM bars WHERE exch=? ORDER BY d DESC LIMIT ?) ORDER BY d ASC LIMIT 1').bind(exch, n).first();
    return (r && r.d) || null;
  } catch (e) { return null; }
}

async function buildTech52(env, exch) {
  if (!env.MARKET_DB) return { ok: false, error: 'no store' };
  if (!(await _tech52Init(env))) return { ok: false, error: 'could not create the table' };
  const latest = await _getMeta(env, 'latest_' + exch);
  if (!latest) return { ok: false, error: 'no latest day for ' + exch };
  const from52 = await _tech52Cutoff(env, exch, _DEEP_DAYS);
  const from14 = await _tech52Cutoff(env, exch, 14);
  if (!from52 || !from14) return { ok: false, error: 'not enough stored days' };

  // the year's extremes
  const ext = Object.create(null);
  try {
    const r = await env.MARKET_DB.prepare(
      'SELECT ticker, MAX(h) AS hi, MIN(l) AS lo, COUNT(*) AS n FROM bars WHERE exch=? AND d>=? GROUP BY ticker').bind(exch, from52).all();
    for (const x of ((r && r.results) || [])) {
      if (x && x.ticker) ext[x.ticker] = { hi: x.hi, lo: x.lo, n: x.n };
    }
  } catch (e) { return { ok: false, error: 'the 52-week query failed' }; }

  // the fortnight's average daily range, and the latest day's own range —
  // together these are the volatility-expansion test
  try {
    const r = await env.MARKET_DB.prepare(
      'SELECT ticker, AVG(CASE WHEN c>0 THEN ((h-l)/c)*100 END) AS atr, ' +
      'MAX(CASE WHEN d=? AND c>0 THEN ((h-l)/c)*100 END) AS rng ' +
      'FROM bars WHERE exch=? AND d>=? GROUP BY ticker').bind(latest, exch, from14).all();
    for (const x of ((r && r.results) || [])) {
      if (x && x.ticker && ext[x.ticker]) { ext[x.ticker].atr = x.atr; ext[x.ticker].rng = x.rng; }
    }
  } catch (e) { return { ok: false, error: 'the 14-day query failed' }; }

  const rows = Object.keys(ext);
  if (!rows.length) return { ok: false, error: 'nothing to write' };
  const stmt = env.MARKET_DB.prepare(
    'INSERT INTO tech52 (exch,ticker,d,hi52,lo52,atr14,rngLast) VALUES (?,?,?,?,?,?,?) ' +
    'ON CONFLICT(exch,ticker) DO UPDATE SET d=excluded.d,hi52=excluded.hi52,lo52=excluded.lo52,atr14=excluded.atr14,rngLast=excluded.rngLast');
  const CHUNK = 200; let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK).map(function (t) {
      const e = ext[t];
      return stmt.bind(exch, t, latest, e.hi, e.lo, (e.atr != null ? e.atr : null), (e.rng != null ? e.rng : null));
    });
    if (batch.length) { await env.MARKET_DB.batch(batch); written += batch.length; }
  }
  // Stamped LAST, and with the day it covers. w399 refuses the two deep reports
  // unless this matches latest_<exch>, so a half-finished rebuild declines
  // rather than quietly serving yesterday's 52-week highs.
  await _setMeta(env, 'tech52_' + exch, latest);
  return { ok: true, exch, d: latest, from52, from14, written };
}

// ═══ w395 — WHICH SHARES A REPORT PICKS, DECIDED HERE ══════════════════════
// The ten reports whose answer does not depend on history the pantry does not
// have yet. Measured, not assumed: with only closing prices to work from, no
// share enters or leaves ANY report, but 🔬 Technical Signals and 🧱 Strong
// Trends come back in a different ORDER because both read the 52-week high and
// the volatility expansion into a score. Those two stay on the device until the
// store holds a year, and this list is what enforces it.
const REPORTS_OPEN = ['allSignals', 'unusual', 'volumeSurge', 'topTen', 'gaps',
  'smart', 'pullback', 'recovery', 'quietMovers', 'sharpMovers'];
// w399: these two rank partly on the 52-week high, so they need a year of daily
// highs behind them. They are no longer held back by a hard-coded list — the
// server counts what it actually holds for that exchange and decides. A
// constant would have to be flipped by hand every time the store grew, and
// forgetting is silent: the reports just stay off, working perfectly, forever.
const REPORTS_DEEP = ['technical', 'strongTrends'];
const REPORTS_HELD = { technical: '52-week highs', strongTrends: '52-week highs' };

// The day's opens and highs, straight out of our own store. The app's upload
// carries closes and volumes only, and 🕳 Gap Report is defined on the OPEN, so
// this is not an optimisation — it is the only honest source for it. Reading it
// here rather than accepting it in the payload is the same rule that closed the
// w392 oracle: never let the caller assert an input to a threshold.
async function _reportBars(env, exch, date) {
  const map = Object.create(null);
  if (!env.MARKET_DB || !date) return map;
  try {
    const r = await env.MARKET_DB.prepare(
      'SELECT ticker, o, h, l FROM bars WHERE exch=? AND d=?').bind(exch, date).all();
    const rows = (r && r.results) || [];
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i];
      if (x && x.ticker) map[String(x.ticker)] = { o: +x.o, h: +x.h, l: +x.l };
    }
  } catch (e) {}
  return map;
}

// w400: the last fortnight of highs and lows, per ticker and keyed by date —
// about 60,000 rows, against 1.3 million for a year. This is what the
// volatility test walks; the year's extremes come from the tech52 table.
async function _reportRecent(env, exch, days) {
  const map = Object.create(null);
  if (!env.MARKET_DB) return map;
  const from = await _tech52Cutoff(env, exch, days || 14);
  if (!from) return map;
  try {
    const r = await env.MARKET_DB.prepare(
      'SELECT ticker, d, o, h, l FROM bars WHERE exch=? AND d>=?').bind(exch, from).all();
    for (const x of ((r && r.results) || [])) {
      if (!x || !x.ticker) continue;
      const t = String(x.ticker);
      if (!map[t]) map[t] = Object.create(null);
      map[t][String(x.d)] = { o: +x.o, h: +x.h, l: +x.l };
    }
  } catch (e) {}
  return map;
}

// w400: one row per share — the extremes a year of real highs and lows gives.
async function _reportExt(env, exch) {
  const map = Object.create(null);
  if (!env.MARKET_DB) return map;
  try {
    const r = await env.MARKET_DB.prepare(
      'SELECT ticker, hi52, lo52 FROM tech52 WHERE exch=?').bind(exch).all();
    for (const x of ((r && r.results) || [])) {
      if (x && x.ticker && x.hi52 > 0 && x.lo52 > 0) map[String(x.ticker)] = { hi52: +x.hi52, lo52: +x.lo52 };
    }
  } catch (e) {}
  return map;
}

// The shape every report answers in: an ordered list of tickers, plus the
// counts and labels the scan prints alongside them. Order is part of the
// answer — five of these rank on watch score.
function _reportShape(r) {
  if (!r) return { tickers: [], extras: null };
  const list = Array.isArray(r) ? r : (Array.isArray(r.rows) ? r.rows
    : (Array.isArray(r.candidates) ? r.candidates : []));
  const tickers = list.map(function (x) {
    return (x && x.s && x.s.ticker) ? x.s.ticker : (x && x.ticker) ? x.ticker : String(x);
  });
  let extras = null;
  if (r && !Array.isArray(r)) {
    extras = {};
    ['priced', 'noOpen', 'gate', 'have200', 'nearStack', 'fadeCount'].forEach(function (k) {
      if (r[k] !== undefined) extras[k] = r[k];
    });
    if (r.totals) extras.totals = r.totals;
    if (!Object.keys(extras).length) extras = null;
  }
  return { tickers: tickers, extras: extras };
}

async function runReports(shares, want, opts, bars, recent, ext) {
  const pool = [];
  for (let i = 0; i < shares.length; i++) {
    const s = shares[i];
    const ser = (s && Array.isArray(s.series)) ? s.series : null;
    if (!ser || ser.length < 30) continue;
    const tk = String(s.ticker || '').slice(0, 16);
    if (!tk) continue;
    let st = null;
    // the bars keyed by date, which is the shape _scStats wants: the last
    // fortnight where we have it, plus today's, plus the year's extremes as a
    // precomputed pair rather than 252 more rows
    const b = bars[tk] || null;
    const ohlc = Object.create(null);
    const rec = (recent && recent[tk]) || null;
    if (rec) { for (const k in rec) ohlc[k] = rec[k]; }
    if (b && isFinite(b.o)) ohlc[ser[ser.length - 1].d] = b;
    const xt = (ext && ext[tk]) || null;
    try { st = _scStats(ser, _scPrep(ser), ser.length - 1, ohlc, xt); } catch (e) { st = null; }
    if (!st) continue;
    try { pool.push(_scShare(tk, opts.exch, ser, st, b, String(s.name || '').slice(0, 60))); } catch (e) {}
  }
  pool.cap = opts.cap;
  const out = Object.create(null);
  for (let i = 0; i < want.length; i++) {
    const k = want[i];
    const fn = _SCAN_SELECTORS[k];
    if (!fn) continue;
    const args = (k === 'sharpMovers') ? [opts.sensitivity]
      : (k === 'smart') ? [opts.minDays, opts.scanAll] : [];
    let r = null;
    try {
      r = fn.apply(null, [pool.slice()].concat(args));
      if (r && typeof r.then === 'function') r = await r;
    } catch (e) { r = null; }
    out[k] = _reportShape(r);
  }
  return { picks: out, graded: pool.length };
}


// ── /admin/panel — one page, no framework, no secrets stored ───────────────
// Plain language on purpose: this is the page Tony uses, and "cursor" and
// "backfill" are not words that tell him whether it worked.
const ADMIN_PANEL_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Insight — pantry</title>
<style>
 body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1420;color:#e8ecf4;margin:0;padding:24px}
 .w{max-width:640px;margin:0 auto}
 h1{font-size:20px;margin:0 0 4px} p.sub{color:#9aa7bd;margin:0 0 20px}
 label{display:block;font-size:13px;color:#9aa7bd;margin:16px 0 4px}
 input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #2a3550;background:#151c2c;color:#e8ecf4;font-size:16px}
 button{margin-top:14px;padding:11px 18px;border-radius:8px;border:0;background:#3d7dff;color:#fff;font-size:15px;cursor:pointer}
 button:disabled{opacity:.5;cursor:default}
 button.g{background:#243049;margin-right:8px}
 table{width:100%;border-collapse:collapse;margin-top:18px;font-size:14px}
 th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #223}
 th{color:#9aa7bd;font-weight:600}
 .bar{height:8px;border-radius:4px;background:#243049;overflow:hidden;margin-top:5px}
 .bar i{display:block;height:100%;background:#4ac07a}
 .msg{margin-top:16px;padding:11px 13px;border-radius:8px;background:#151c2c;border:1px solid #2a3550;white-space:pre-wrap}
 .err{border-color:#7a2b3a;background:#2a151c}
</style></head><body><div class="w">
<h1>The pantry</h1>
<p class="sub">How much market history the server has stored, and a button to fetch more.</p>
<label for="k">Your admin password</label>
<input id="k" type="password" autocomplete="current-password" placeholder="the ADMIN_KEY you set in Cloudflare">
<div><button class="g" id="chk">Show me what is stored</button><button id="go" disabled>Fetch 10 more days</button><button id="all" disabled>Fill until full</button></div>
<div style="margin-top:8px"><input id="repDay" type="date" style="padding:6px;border-radius:6px;border:1px solid #444;background:#111;color:#eee"> <button class="g" id="repGo">Repair this day\'s bars</button></div>
<p style="font-size:12px;opacity:.75;margin:4px 0 0">Re-pulls one day\'s full file and upserts it — for a day that was stamped done while short (e.g. 14 Aug 2026 stuck at 1,951 bars). Safe to repeat; existing rows just update.</p>
<div style="margin-top:8px"><button class="g" id="mailGo">Email me today\'s picks now</button></div>
<p style="font-size:12px;opacity:.75;margin:4px 0 0">Sends the nightly picks email on demand (needs the RESEND_KEY and PICKS_EMAIL_TO secrets). The automatic one goes out each evening once the pick lanes have decided.</p>
<div><button class="g" id="t52" disabled style="margin-top:8px">Build the 52-week table</button></div>
<div><button class="g" id="warmNow" disabled style="margin-top:8px">Grade today\'s shares right now</button></div>
<div><button class="g" id="backtestAS" disabled style="margin-top:8px">Backtest Score and Accum</button></div>
<div><button class="g" id="backtestStreaks" disabled style="margin-top:8px">Backtest price streaks (up/down)</button></div>
<div><button class="g" id="oppositeSweep" disabled style="margin-top:8px">Backtest opposite-signal sweep (RSI/MA/vol/6mo/10d)</button></div>
<div><button class="g" id="evidenceTop7" disabled style="margin-top:8px">Best-evidence top 7, real shares (5d/10d/30d)</button></div>
<div style="margin-top:14px;font-weight:600;opacity:.85">Backtests \u2014 current</div>
<div><button class="g" id="dipLadderPB100k" disabled style="margin-top:8px">Dip-ladder: $100,000 pool, 10 open positions, DIP vs NO-DIP \u2014 FULL stored history (~2.9 yrs)</button></div>
<div><button class="g" id="deepDataAudit" disabled style="margin-top:8px">Deep DATA AUDIT: scan every stored share for consolidations, bad bars, gaps, flat runs, bad ticks (read-only)</button></div>
<div><button class="g" id="benchmarkBands" disabled style="margin-top:8px">BENCHMARK: what the same shares paid a passive holder \u2014 buy-and-hold, monthly rebalance, and 200 random-entry runs</button></div>
<div><button class="g" id="trailExitTest" disabled style="margin-top:8px">TRAILING EXIT: no take-profit, let winners run \u2014 10% vs 15% trail, dip vs market, $100k/10 positions, full history</button></div>
<div><button class="g" id="trailWideSweep" disabled style="margin-top:8px">TRAILING SWEEP: 15/20/25/30% trail, dip entry, both bands \u2014 with the concentration check on every cell</button></div>
<div><button class="g" id="trailNetSweep" disabled style="margin-top:8px">AFTER COSTS: the same 15/20/25/30% trailing sweep with $3 brokerage each way and 0.5% slippage on market-order fills</button></div>
<div><button class="g" id="headToHead" disabled style="margin-top:8px">DECIDE: 15/15 vs 20/15 vs 20% TRAIL \u2014 same money, same entry, same window, all after costs</button></div>
<div><button class="g" id="run50k" disabled style="margin-top:8px">$50,000 RUN: the chosen setup \u2014 20% trail, no take-profit, $0.20-$0.99, 5% dip, top 4, score 7+ \u2014 dollars and margin</button></div>
<div><button class="g" id="slipStress" disabled style="margin-top:8px">STRESS TEST: the chosen setup at 0.5% / 1% / 1.5% / 2% slippage \u2014 where does the edge die? plus the worst drawdown</button></div>
<div><button class="g" id="pullTest" disabled style="margin-top:8px">PULLBACK ENTRY: wait 5 days, buy a 5-10% dip \u2014 head to head against buying the dip on the day</button></div>
<div><button class="g" id="marketVsDip" disabled style="margin-top:8px">MARKET vs DIP ENTRY: does buying on the day survive the spread? (1% / 1.5% / 2% slippage, both entries)</button></div>
<div><button class="g" id="smallMargins" disabled style="margin-top:8px">SMALL MARGINS: 3% / 4% / 5% / 7% take-profit on $50,000 \u2014 how many times can the money be turned over, and do the costs eat it?</button></div>
<div><button class="g" id="dipLadderPBDipVsMkt" disabled style="margin-top:8px">Dip-ladder: 20%/15%, top-4/day, over $0.15-$1.75 and $0.20-$0.99 \u2014 DIP entry vs NO-DIP (market) entry</button></div>
<div><button class="g" id="dipLadderPB2015Top4" disabled style="margin-top:8px">Dip-ladder: 20%/15%, top-4/day (isolates target/stop vs the 15/15 baseline), over $0.20-$1.50 and $0.20-$0.99</button></div>
<div><button class="g" id="dipLadderCompoundingPriceBands" disabled style="margin-top:8px">Dip-ladder: SAME 15/15, split into 5 share-price bands (\u2264$0.20, $0.20-$0.99, $1-$1.99, $2-$5, &gt;$5)</button></div>
<div><button class="g" id="dipLadderCompounding" disabled style="margin-top:8px">Dip-ladder: 15/15 COMPOUNDING from $50,000 over ~2.7 years</button></div>
<div><button class="g" id="dipLadderCompounding2015" disabled style="margin-top:8px">Dip-ladder: 20%/15% on the ORIGINAL unrestricted compounding test (no price filter, vs the 15/15 baseline)</button></div>
<div><button class="g" id="dipLadderCompounding10yr" disabled style="margin-top:8px">Dip-ladder: 15/15 COMPOUNDING over 10 years (needs the backfill to finish first)</button></div>
<details style="margin-top:14px">
<summary style="cursor:pointer;opacity:.7;padding:6px 0">Older tests (25) \u2014 answered already, kept so any result can be reproduced</summary>
<div style="padding-left:10px;border-left:2px solid #243049;margin-top:6px">
<div><button class="g" id="dipLadderBT" disabled style="margin-top:8px">Dip-ladder backtest: 6wk, 2wk entry \u00d7 4 levels, trail+ladder+scale-out</button></div>
<div><button class="g" id="dipLadderRecurBT" disabled style="margin-top:8px">Dip-ladder backtest: 12mo, buying every week</button></div>
<div><button class="g" id="dipLadderFixedTS" disabled style="margin-top:8px">Dip-ladder backtest: 12mo, fixed target/stop (10/10 vs 5/10), no repeat buys</button></div>
<div><button class="g" id="dipLadderFixedTSMulti" disabled style="margin-top:8px">Dip-ladder backtest: 12mo, fixed target/stop (10/10 vs 5/10), multiple buys allowed</button></div>
<div><button class="g" id="dipLadderVsApp" disabled style="margin-top:8px">Dip-ladder: NEW 10%/10% vs the app's OWN current best-practice defaults</button></div>
<div><button class="g" id="dipLadderVsAppV2" disabled style="margin-top:8px">Dip-ladder: NEW 15%/15% vs app defaults (current selection rules)</button></div>
<div><button class="g" id="dipLadderVsAppV2_2500" disabled style="margin-top:8px">Dip-ladder: same, but $2,500 per trade</button></div>
<div><button class="g" id="dipLadderTop4" disabled style="margin-top:8px">Dip-ladder backtest: top 4 by evidence, fixed target/stop (10/10 vs 7/10)</button></div>
<div><button class="g" id="dipLadderScored" disabled style="margin-top:8px">Dip-ladder backtest: top 4, solid + 7-rated-and-above only (10/10 vs 7/10)</button></div>
<div><button class="g" id="dipLadderCapped" disabled style="margin-top:8px">Dip-ladder backtest: real position cap (8 max), fixed known capital (10/10 vs 7/10)</button></div>
<div><button class="g" id="dipLadderGrid" disabled style="margin-top:8px">Dip-ladder: grid search target \u00d7 stop, ETFs/hybrids/bonds excluded</button></div>
<div><button class="g" id="dipLadderGridExt" disabled style="margin-top:8px">Dip-ladder: grid search, EXTENDED range (target 15-40%, stop 10-30%)</button></div>
<div><button class="g" id="dipLadderGridFar" disabled style="margin-top:8px">Dip-ladder: grid search, FAR range (target 30-80%, stop 25-60%)</button></div>
<div><button class="g" id="dipLadderGridDiag" disabled style="margin-top:8px">Dip-ladder: WHY does wider keep winning? (exit-reason breakdown)</button></div>
<div><button class="g" id="dipLadderCapCost" disabled style="margin-top:8px">Dip-ladder: capital cost of widening (real cap, hold time, fewer round-trips)</button></div>
<div><button class="g" id="dipLadderCapCost3yr" disabled style="margin-top:8px">Dip-ladder: capital cost of widening, LONG WINDOW (~2.7 years, all stored history)</button></div>
<div><button class="g" id="dipLadderCapCostNarrow" disabled style="margin-top:8px">Dip-ladder: capital cost, 10/15 vs 15/15 vs 20/20 (1 year)</button></div>
<div><button class="g" id="dipLadderCapCostNarrow3yr" disabled style="margin-top:8px">Dip-ladder: capital cost, 10/15 vs 15/15 vs 20/20 (~2.7 years)</button></div>
<div><button class="g" id="dipLadderCompoundingMkt" disabled style="margin-top:8px">Dip-ladder: same, but NO DIP (market entry)</button></div>
<div><button class="g" id="dipLadderCompoundingD25" disabled style="margin-top:8px">Dip-ladder: same, but -2.5% dip entry</button></div>
<div><button class="g" id="dipLadderCompoundingScore5" disabled style="margin-top:8px">Dip-ladder: same as -5% dip, but score 5+ instead of 7+</button></div>
<div><button class="g" id="dipLadderCompoundingScore4" disabled style="margin-top:8px">Dip-ladder: same, but score 4+ (testing how low it can go)</button></div>
<div><button class="g" id="dipLadderCompoundingWatchScore" disabled style="margin-top:8px">Dip-ladder: SAME test, filtered by Watch Score instead of report-card score</button></div>
<div><button class="g" id="dipLadderPB1010" disabled style="margin-top:8px">Dip-ladder: 10%/10%, top-6/day, over $0.20-$1.50 and $0.20-$0.99</button></div>
<div><button class="g" id="dipLadderPB2015" disabled style="margin-top:8px">Dip-ladder: 20%/15%, top-6/day, over $0.20-$1.50 and $0.20-$0.99</button></div>
</div>
</details>
<div><a href="/admin/new-rules-report" target="_blank" style="display:inline-block;margin-top:8px;padding:8px 14px;border-radius:7px;background:#D9A441;color:#1a1200;font-weight:700;text-decoration:none;">🎯 Open the daily New-Rules Picks report (15/15 · -5% dip · score 7+ · $0.20-$0.99 \u2014 auto-runs daily on the LATEST session)</a></div>
<div><a href="/admin/new-rules-report?mode=trail" target="_blank" style="display:inline-block;margin-top:8px;padding:8px 14px;border-radius:7px;background:#2f6f4f;color:#eaffef;font-weight:700;text-decoration:none;">🎯 Open the daily TRAILING Picks report (20% trailing stop \u00b7 no take-profit \u00b7 -5% dip \u00b7 score 7+ \u00b7 $0.20-$0.99 \u2014 the rules the 1 Aug testing chose)</a></div>
<div><button class="g" id="evidenceNoETF" disabled style="margin-top:8px">Same, WITH vs WITHOUT ETFs compared (6 replays, slower)</button></div>
<div><button class="g" id="evidenceNoNonEq" disabled style="margin-top:8px">Same, WITHOUT ETFs+hybrids+bonds compared (6 replays, slower)</button></div>
<p class="sub" style="margin:6px 0 0;font-size:12px">Replays both against the stored year, the same way PN Edge is graded: does a higher number actually predict a better next-5-day return, or has it never been checked before now.</p>
<p class="sub" style="margin:6px 0 0;font-size:12px">Normally happens by itself after the market closes. Press this if you just updated the server today and do not want to wait for tonight\'s close.</p>
<h2 style="font-size:16px;margin:22px 0 4px">Backing it up</h2>
<p class="sub" style="margin-bottom:10px">The pantry lives in one place. These files are the copy — keep them somewhere that is not Cloudflare.</p>
<div><button class="g" id="bkList" disabled>Show me the months</button><button id="bkAll" disabled>Download every month</button></div>
<div id="bkOut"></div>
<div style="margin-top:14px"><label for="bkFile" style="margin-top:0">Put a backup file back</label>
<input id="bkFile" type="file" accept=".ndjson,.json,.txt" style="padding:7px">
<button class="g" id="bkRestore" disabled style="margin-top:8px">Restore from this file</button></div>
<div id="bkRestoreOut"></div>
<div id="out"></div>
<div id="dlWrap" style="display:none;margin-top:6px"><button class="g" id="dlLast" style="font-size:12px">⬇ Download last result as text file (for printing / reading the full list)</button></div>
<script>
 var K=function(){return document.getElementById('k').value.trim();};
 var out=document.getElementById('out');
 function say(t,bad){
  out.innerHTML='<div class="msg'+(bad?' err':'')+'">'+t+'</div>';
  window._lastSayText=String(t).replace(/<[^>]*>/g,''); // strip any stray HTML, keep plain text for the download
  var dw=document.getElementById('dlWrap'); if(dw)dw.style.display=(bad?'none':'block'); // no point offering a download of an error line
 }
 document.getElementById('dlLast').onclick=function(){
  var txt=window._lastSayText||''; if(!txt)return;
  var blob=new Blob([txt],{type:'text/plain'});
  var a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='insight-backtest-'+new Date().toISOString().slice(0,10)+'.txt';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
 };
 function draw(d,extraMsg){
  var h='<table><tr><th>Exchange</th><th>Days stored</th><th>Oldest day</th><th>Progress</th></tr>';
  for(var i=0;i<d.length;i++){var x=d[i];
   var pc=x.target?Math.min(100,Math.round(x.days/x.target*100)):0;
   var rdy=x.ready?'<span style="color:#4ac07a">all 12 reports</span>'
        :(x.deep?'<span style="color:#e0b055">10 of 12 — days enough, 52-week table not built</span>'
                :'<span style="color:#e0b055">10 of 12 — needs '+(x.deepNeeded||252)+' days</span>');
   h+='<tr><td>'+x.exch+'</td><td>'+x.days+' of '+(x.target||'?')+'<div style="font-size:11px;color:#9aa7bd">'+rdy+'</div></td><td>'+(x.oldest||'—')+
      '</td><td>'+pc+'%<div class="bar"><i style="width:'+pc+'%"></i></div></td></tr>';}
  h+='</table>';
  var errBlocks=[];
  for(var j=0;j<d.length;j++){var xx=d[j];
   if(xx.lastBackfillError){
    var le=xx.lastBackfillError;
    errBlocks.push('<div class="msg err" style="margin-top:8px;text-align:left;white-space:pre-wrap;">'+
     '<b>'+xx.exch+' \u2014 what EODData actually sent back on the day the crawl last stopped</b>\\n'+
     'HTTP status: '+(le.httpStatus==null?'(no response received)':le.httpStatus)+'\\n'+
     'Date it choked on: '+(le.date||'?')+'\\n'+
     'Raw response (first 300 chars): '+((le.rawSnippet==null)?'(none captured)':(le.rawSnippet===''?'(EODData sent an empty body with this status code)':le.rawSnippet))+
     '</div>');
   }
  }
  var msgBlock=extraMsg?('<div class="msg" style="margin-top:8px;">'+extraMsg+'</div>'):'';
  out.innerHTML=h+errBlocks.join('')+msgBlock;
 }
 function call(path,cb){
  var k=K(); if(!k){say('Type your admin password first.',1);return;}
  fetch(path,{headers:{'X-Insight-Admin':k}}).then(function(r){return r.json().then(function(j){return {s:r.status,j:j};});})
   .then(function(r){ if(r.s!==200){say((r.j&&r.j.error)||('error '+r.s),1);return;} cb(r.j); })
   .catch(function(e){say('Could not reach the server: '+e,1);});
 }
 document.getElementById('mailGo').onclick=function(){
  say('Sending the picks email\u2026');
  call('/admin/mailtest',function(j){ say(j&&j.ok?('Sent \u2014 '+(j.picks||0)+' picks for '+(j.day||'')+'.'):((j&&j.error)||'failed'), j&&j.ok?0:1); });
 };
 document.getElementById('repGo').onclick=function(){
  var d=(document.getElementById('repDay')||{}).value||'';
  if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(d)){say('Pick a date first.',1);return;}
  say('Re-pulling '+d+'\u2026');
  call('/admin/ingest?date='+encodeURIComponent(d)+'&exch=ASX',function(j){
    say(j&&j.ok?('Repaired '+d+': '+ (j.count||0) +' bars upserted.'):(j&&j.error||'failed'), j&&j.ok?0:1);
  });
 };
 document.getElementById('chk').onclick=function(){
  say('Reading the store…');
  call('/admin/status',function(j){ draw(j.depth||[]); ['go','all','t52','warmNow','backtestAS','backtestStreaks','oppositeSweep','evidenceTop7','evidenceNoETF','evidenceNoNonEq','dipLadderBT','dipLadderRecurBT','dipLadderFixedTS','dipLadderFixedTSMulti','dipLadderVsApp','dipLadderVsAppV2','dipLadderVsAppV2_2500','dipLadderTop4','dipLadderScored','dipLadderCapped','dipLadderGrid','dipLadderGridExt','dipLadderGridFar','dipLadderGridDiag','dipLadderCapCost','dipLadderCapCost3yr','dipLadderCapCostNarrow','dipLadderCapCostNarrow3yr','dipLadderCompounding','dipLadderCompoundingMkt','dipLadderCompoundingD25','dipLadderCompoundingScore5','dipLadderCompoundingScore4','dipLadderCompoundingWatchScore','dipLadderCompounding10yr','dipLadderCompoundingPriceBands','dipLadderPB1010','dipLadderPB2015','dipLadderPB2015Top4','dipLadderCompounding2015','dipLadderPBDipVsMkt','dipLadderPB100k','deepDataAudit','benchmarkBands','trailExitTest','trailWideSweep','trailNetSweep','headToHead','run50k','slipStress','pullTest','marketVsDip','smallMargins','bkList','bkAll','bkRestore'].forEach(function(id){ var e=document.getElementById(id); if(e)e.disabled=false; }); });
 };

 // Fill until full — rounds of ten, driven from here rather than from a bigger
 // number on the server. Each round is its own small request, which is what
 // makes Stop instant and makes a cut-off request impossible to mistake for
 // success.
 var stopNow=false, rounds=0;
 var MAX_ROUNDS=40;                       // a forgotten tab must not run all night
 // w398: compare EVERY exchange's day count and oldest day, not the earliest
 // date across all of them. The crawler works on one exchange per round, so a
 // round that walked New York backwards left the ASX untouched — and since the
 // ASX held the earlier date, a single minimum never moved and the loop decided
 // there was nothing left to fetch. It stopped hardest when it was working.
 function sigOf(d){
  var s=[];
  for(var i=0;i<d.length;i++)s.push(d[i].exch+':'+d[i].days+':'+(d[i].oldest||''));
  s.sort();
  return s.join(' | ');
 }
 function whereOf(d){
  var s=[];
  for(var i=0;i<d.length;i++)s.push(d[i].exch+' back to '+(d[i].oldest||'?')+' ('+d[i].days+' of '+(d[i].target||'?')+')');
  return s.join(', ');
 }
 function full(d){ for(var i=0;i<d.length;i++){ if(!d[i].target||d[i].days<d[i].target)return false; } return d.length>0; }
 function askJSON(path){
  return new Promise(function(res,rej){
   var k=K(); if(!k){rej('no password');return;}
   fetch(path,{headers:{'X-Insight-Admin':k}})
    .then(function(r){return r.json().then(function(j){ return r.status===200?res(j):rej((j&&j.error)||('error '+r.status)); });})
    .catch(function(e){rej(String(e));});
  });
 }
 function setBusy(on){
  document.getElementById('chk').disabled=on;
  document.getElementById('go').disabled=on;
  var a=document.getElementById('all');
  a.textContent=on?'Stop':'Fill until full';
  a.style.background=on?'#7a2b3a':'#3d7dff';
 }


 // ── backup ────────────────────────────────────────────────────────────────
 var bkOut=function(h){ var e=document.getElementById('bkOut'); if(e)e.innerHTML=h; };
 var MONTHS=[];
 function fetchFile(path,name,cb){
  var k=K(); if(!k){bkOut('<div class="msg err">Type your admin password first.</div>');return;}
  fetch(path,{headers:{'X-Insight-Admin':k}}).then(function(r){
   if(r.status!==200){ cb('server said '+r.status); return; }
   var n=r.headers.get('X-Pantry-Rows')||'?';
   return r.blob().then(function(b){
    var u=URL.createObjectURL(b), a=document.createElement('a');
    a.href=u; a.download=name; document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(u); a.remove(); },1500);
    cb(null,n);
   });
  }).catch(function(e){ cb(String(e)); });
 }
 function drawMonths(){
  var h='<table><tr><th>Exchange</th><th>Month</th><th>Days</th><th>Prices</th><th></th></tr>';
  for(var i=0;i<MONTHS.length;i++){ var m=MONTHS[i];
   h+='<tr><td>'+m.exch+'</td><td>'+m.ym+'</td><td>'+m.days+'</td><td>'+m.rows.toLocaleString()+'</td>'+
      '<td><button class="g" data-ex="'+m.exch+'" data-ym="'+m.ym+'" style="padding:5px 10px;font-size:13px">Download</button></td></tr>';
  }
  h+='</table><div class="msg" id="bkMsg">One file per month. Keep them off Cloudflare — your own disk, a USB stick, a cloud drive.</div>';
  bkOut(h);
  var bs=document.querySelectorAll('#bkOut button[data-ym]');
  for(var j=0;j<bs.length;j++)bs[j].onclick=function(){
   var ex=this.getAttribute('data-ex'), ym=this.getAttribute('data-ym'), b=this;
   b.disabled=true; b.textContent='…';
   fetchFile('/admin/pantry/export?exch='+ex+'&ym='+ym,'pantry-'+ex+'-'+ym+'.ndjson',function(err,n){
    b.textContent=err?'failed':('saved '+n);
    if(err)b.disabled=false;
   });
  };
 }
 document.getElementById('bkList').onclick=function(){
  bkOut('<div class="msg">Looking…</div>');
  call('/admin/pantry/months',function(j){ MONTHS=j.months||[]; drawMonths(); });
 };
 document.getElementById('bkAll').onclick=function(){
  if(!MONTHS.length){ bkOut('<div class="msg err">Press "Show me the months" first.</div>'); return; }
  var i=0, b=this; b.disabled=true;
  var step=function(){
   if(i>=MONTHS.length){ b.disabled=false; document.getElementById('bkMsg').textContent='All '+MONTHS.length+' files saved. Your browser may have asked permission for multiple downloads.'; return; }
   var m=MONTHS[i++];
   document.getElementById('bkMsg').textContent='Saving '+m.exch+' '+m.ym+' ('+i+' of '+MONTHS.length+')…';
   fetchFile('/admin/pantry/export?exch='+m.exch+'&ym='+m.ym,'pantry-'+m.exch+'-'+m.ym+'.ndjson',function(err){
    setTimeout(step, err?1500:700);
   });
  };
  step();
 };
 // ── restore ───────────────────────────────────────────────────────────────
 document.getElementById('bkRestore').onclick=function(){
  var out=document.getElementById('bkRestoreOut');
  var say=function(t,bad){ out.innerHTML='<div class="msg'+(bad?' err':'')+'">'+t+'</div>'; };
  var f=document.getElementById('bkFile').files[0];
  if(!f){ say('Choose a backup file first.',1); return; }
  var m=/pantry-([A-Z]+)-(\\d{4}-\\d{2})/.exec(f.name||'');
  if(!m){ say('That does not look like a pantry backup file (expected a name like pantry-ASX-2026-07.ndjson).',1); return; }
  var ex=m[1], b=this; b.disabled=true;
  say('Reading '+f.name+'…');
  var rd=new FileReader();
  rd.onload=function(){
   var lines=String(rd.result||'').split('\\n').filter(function(x){return x.trim();});
   var i=0, done=0, CH=4000;
   var k=K();
   var step=function(){
    if(i>=lines.length){ b.disabled=false; say('Done — '+done.toLocaleString()+' prices put back for '+ex+'. Nothing was overwritten with anything different: rows already there were simply rewritten as they were.'); return; }
    var part=lines.slice(i,i+CH); i+=CH;
    say('Putting back '+Math.min(i,lines.length).toLocaleString()+' of '+lines.length.toLocaleString()+'…');
    fetch('/admin/pantry/import?exch='+ex,{method:'POST',headers:{'X-Insight-Admin':k,'Content-Type':'text/plain'},body:part.join('\\n')})
     .then(function(r){return r.json();})
     .then(function(j){ if(!j||!j.ok){ b.disabled=false; say('Stopped: '+((j&&j.error)||'the server refused'),1); return; } done+=j.written||0; setTimeout(step,120); })
     .catch(function(e){ b.disabled=false; say('Stopped: '+e,1); });
   };
   step();
  };
  rd.readAsText(f);
 };
 document.getElementById('t52').onclick=function(){
  var b=this; b.disabled=true; say('Building the 52-week table. This reads a year of prices for every share — give it a minute.');
  call('/admin/tech52',function(j){
   var lines=[];
   (j.built||[]).forEach(function(x){
    lines.push(x.ok?(x.exch+': '+x.written+' shares, up to '+x.d):(x.exch||'?')+': '+(x.error||'failed'));
   });
   say(lines.join('\\n')||'Nothing was built.');
   call('/admin/status',function(s){ draw(s.depth||[]); b.disabled=false; });
  });
 };
 document.getElementById('warmNow').onclick=function(){
  var b=this; b.disabled=true; say('Grading today\\'s shares now — usually takes a few seconds to a minute.');
  call('/admin/warm-now',function(j){
   var lines=(j.warmed&&j.warmed.floors)?j.warmed.floors:[];
   say('Done for '+j.exch+' '+j.date+'. '+(lines.length?('windows: '+lines.join(', ')):'')+'\\nEveryone\\'s next look at the app today should be instant.');
   b.disabled=false;
  });
 };
 document.getElementById('backtestAS').onclick=function(){
  var b=this; b.disabled=true; say('Replaying Score and Accum against the stored year — this reads a lot of history, may take a minute or two.');
  call('/admin/backtest-accum-score',function(j){
   if(!j||!j.result){ say('No result came back.'); b.disabled=false; return; }
   var r=j.result, lines=['Universe: $250k+ tradeable shares, '+r.usedDays+' trading days used ('+j.exch+', from '+j.from+')',''];
   lines.push('ACCUM (0-10 qualifying days) -> next-5-day return vs that day\\'s own market:');
   for(var i=0;i<=10;i++){ var a=r.byAccum[i]; if(a&&a.n>0) lines.push('  '+i+': n='+a.n+' hit-rate='+a.hitRate+'% t-stat='+a.tstat+' ('+a.days+' days)'); }
   lines.push(''); lines.push('SCORE band -> next-5-day return vs that day\\'s own market:');
   ['Minimal','Early','Building','Strong'].forEach(function(bd){ var s2=r.byScoreBand[bd]; if(s2&&s2.n>0) lines.push('  '+bd+': n='+s2.n+' hit-rate='+s2.hitRate+'% t-stat='+s2.tstat+' ('+s2.days+' days)'); });
   say(lines.join('\\n'));
   b.disabled=false;
  });
 };
 document.getElementById('backtestStreaks').onclick=function(){
  var b=this; b.disabled=true; say('Replaying price streaks against the stored year — this reads a lot of history, may take a minute or two.');
  call('/admin/backtest-streaks',function(j){
   if(!j||!j.result){ say('No result came back.'); b.disabled=false; return; }
   var r=j.result, lines=['Universe: $250k+ tradeable shares, '+r.usedDays+' trading days used ('+j.exch+', from '+j.from+')',''];
   lines.push('UP streaks -> next-5-day return vs that day\\'s own market:');
   for(var i=1;i<=5;i++){ var u=r.buckets['up'+i]; if(u&&u.n>0) lines.push('  '+i+(i===5?'+':'')+' day'+(i===1?'':'s')+': n='+u.n+' hit-rate='+u.hitRate+'% t-stat='+u.tstat+' ('+u.days+' days)'); }
   lines.push(''); lines.push('DOWN streaks -> next-5-day return vs that day\\'s own market:');
   for(var i=1;i<=5;i++){ var dn=r.buckets['down'+i]; if(dn&&dn.n>0) lines.push('  '+i+(i===5?'+':'')+' day'+(i===1?'':'s')+': n='+dn.n+' hit-rate='+dn.hitRate+'% t-stat='+dn.tstat+' ('+dn.days+' days)'); }
   var fl=r.buckets.flat; if(fl&&fl.n>0){ lines.push(''); lines.push('FLAT (no streak) -> n='+fl.n+' hit-rate='+fl.hitRate+'% t-stat='+fl.tstat+' ('+fl.days+' days)'); }
   say(lines.join('\\n'));
   b.disabled=false;
  });
 };
 document.getElementById('oppositeSweep').onclick=function(){
  var b=this; b.disabled=true; say('Sweeping RSI, distance from the 200-day MA, volume, 6-month and 10-day change against the stored year — this reads a lot of history, may take a minute or two.');
  call('/admin/opposite-sweep',function(j){
   if(!j||!j.result){ say('No result came back.'); b.disabled=false; return; }
   var r=j.result, lines=['Universe: $250k+ tradeable shares, '+r.usedDays+' trading days used ('+j.exch+', from '+j.from+')',''];
   var order=['rsi','ma200dist','volratio','d120','d10'];
   for(var m=0;m<order.length;m++){
     var M=r.metrics[order[m]]; if(!M)continue;
     lines.push(M.label+' -> next-5-day return vs that day\\'s own market:');
     for(var bk in M.buckets){ var b2=M.buckets[bk]; if(b2&&b2.n>0) lines.push('  '+bk+': n='+b2.n+' hit-rate='+b2.hitRate+'% t-stat='+b2.tstat+' ('+b2.days+' days)'); }
     lines.push('');
   }
   say(lines.join('\\n'));
   b.disabled=false;
  });
 };
 document.getElementById('evidenceTop7').onclick=function(){
  var b=this; b.disabled=true; say('Replaying the whole year — each day, which shares had the strongest PROVEN signal firing, and what did the real shares do next. Running 5d, then 10d, then 30d. This is a full-universe replay done three times, may take a couple of minutes.');
  var holds=[5,10,30], results={}, lines=[];
  var next=function(i){
   if(i>=holds.length){
    lines.push('=== BEST-EVIDENCE TOP 7, EACH ACTUAL WINDOW ===','');
    for(var h=0;h<holds.length;h++){
     var hh=holds[h], r=results[hh]; if(!r){ lines.push(hh+'d: no result'); continue; }
     var A=r.aggregate;
     lines.push(hh+'d window — '+r.totalPicks+' picks across '+r.daysWithPicks+' days:');
     lines.push('  mean next-'+hh+'d move '+(A.meanOut>=0?'+':'')+A.meanOut+'%  vs market '+(A.marketAvg>=0?'+':'')+A.marketAvg+'%  edge '+(A.edge>=0?'+':'')+A.edge+'%  t-stat '+A.tstat+' ('+A.days+' days, day-clustered)  hit-rate '+A.hitRate+'%');
     lines.push('  real shares, most-picked first (name: appearances, avg move, win%):');
     var bt=r.byTicker; // w434: uncapped — the download button below handles length, no need to truncate what's shown
     for(var t=0;t<bt.length;t++){ var it=bt[t]; lines.push('    '+it.ticker+': '+it.n+'x  '+(it.avgOut>=0?'+':'')+it.avgOut+'%  '+it.winRate+'% win'); }
     lines.push('');
    }
    say(lines.join('\\n'));
    b.disabled=false;
    return;
   }
   var hold=holds[i];
   call('/admin/evidence-top7?hold='+hold+'&n=7',function(j){
    if(!j||!j.result){ lines.push(hold+'d: no result came back'); results[hold]=null; }
    else results[hold]=j.result;
    next(i+1);
   });
  };
  next(0);
 };
 document.getElementById('evidenceNoETF').onclick=function(){
  var b=this; b.disabled=true; say('Replaying the whole year TWICE per window — once with the full universe, once with ~200 known ETFs/ETPs excluded — to see whether the evidence edge was leaning on funds rather than individual companies. Six full-universe replays total, this will take a few minutes. Leave this page open.');
  var holds=[5,10,30], withETF={}, withoutETF={}, lines=[];
  var jobs=[]; holds.forEach(function(h){ jobs.push({h:h,ex:0}); jobs.push({h:h,ex:1}); });
  var next=function(i){
   if(i>=jobs.length){
    lines.push('=== WITH ETFs vs WITHOUT ETFs — does the evidence edge survive? ===','');
    for(var h=0;h<holds.length;h++){
     var hh=holds[h], rw=withETF[hh], rn=withoutETF[hh];
     if(!rw||!rn){ lines.push(hh+'d: incomplete result'); continue; }
     var Aw=rw.aggregate, An=rn.aggregate;
     lines.push(hh+'d window:');
     lines.push('  WITH ETFs:    '+rw.totalPicks+' picks, '+Aw.days+' days, edge '+(Aw.edge>=0?'+':'')+Aw.edge+'%  t-stat '+Aw.tstat+'  hit-rate '+Aw.hitRate+'%');
     lines.push('  WITHOUT ETFs: '+rn.totalPicks+' picks, '+An.days+' days, edge '+(An.edge>=0?'+':'')+An.edge+'%  t-stat '+An.tstat+'  hit-rate '+An.hitRate+'%');
     var edgeDiff=An.edge-Aw.edge, tDiff=An.tstat-Aw.tstat;
     lines.push('  DIFFERENCE removing ETFs: edge '+(edgeDiff>=0?'+':'')+edgeDiff.toFixed(3)+'%  t-stat '+(tDiff>=0?'+':'')+tDiff.toFixed(2)+(An.tstat>=2?'  — still SOLID on companies alone':(An.tstat>=1?'  — drops to PROMISING territory without ETFs':'  — the edge does NOT hold up without ETFs')));
     lines.push('  real shares WITHOUT ETFs, most-picked first (name: appearances, avg move, win%):');
     var bt=rn.byTicker;
     for(var t=0;t<bt.length;t++){ var it=bt[t]; lines.push('    '+it.ticker+': '+it.n+'x  '+(it.avgOut>=0?'+':'')+it.avgOut+'%  '+it.winRate+'% win'); }
     lines.push('');
    }
    lines.push('Exclusion list: ~200 tickers from ASX'+"'"+'s official June 2020 ETF snapshot (Vanguard/iShares/BetaShares/SPDR/VanEck/ETFS families) plus HVLU/HNDQ confirmed individually. Not exhaustive of every fund launched since — a newer, smaller ETF could still slip through — but covers the large, liquid families most likely to actually clear this backtest'+"'"+'s $250k floor.');
    say(lines.join('\\n'));
    b.disabled=false;
    return;
   }
   var job=jobs[i];
   call('/admin/evidence-top7?hold='+job.h+'&n=7'+(job.ex?'&excludeETF=1':''),function(j){
    if(j&&j.result){ if(job.ex)withoutETF[job.h]=j.result; else withETF[job.h]=j.result; }
    next(i+1);
   });
  };
  next(0);
 };
 document.getElementById('evidenceNoNonEq').onclick=function(){
  var b=this; b.disabled=true; say('Replaying the whole year TWICE per window — once with the full universe, once with ETFs AND hybrid/preference shares AND government bonds excluded — to see whether the evidence edge is genuinely a company-specific footprint. Six full-universe replays total, this will take a few minutes. Leave this page open.');
  var holds=[5,10,30], withAll={}, clean={}, lines=[];
  var jobs=[]; holds.forEach(function(h){ jobs.push({h:h,ex:0}); jobs.push({h:h,ex:1}); });
  var next=function(i){
   if(i>=jobs.length){
    lines.push('=== full universe vs ETFs+hybrids+bonds EXCLUDED — is this a genuine company-specific footprint? ===','');
    for(var h=0;h<holds.length;h++){
     var hh=holds[h], rw=withAll[hh], rn=clean[hh];
     if(!rw||!rn){ lines.push(hh+'d: incomplete result'); continue; }
     var Aw=rw.aggregate, An=rn.aggregate;
     lines.push(hh+'d window:');
     lines.push('  FULL universe:      '+rw.totalPicks+' picks, '+Aw.days+' days, edge '+(Aw.edge>=0?'+':'')+Aw.edge+'%  t-stat '+Aw.tstat+'  hit-rate '+Aw.hitRate+'%');
     lines.push('  ETFs+hybrids+bonds excluded: '+rn.totalPicks+' picks, '+An.days+' days, edge '+(An.edge>=0?'+':'')+An.edge+'%  t-stat '+An.tstat+'  hit-rate '+An.hitRate+'%');
     var edgeDiff=An.edge-Aw.edge, tDiff=An.tstat-Aw.tstat;
     lines.push('  DIFFERENCE removing non-equity: edge '+(edgeDiff>=0?'+':'')+edgeDiff.toFixed(3)+'%  t-stat '+(tDiff>=0?'+':'')+tDiff.toFixed(2)+(An.tstat>=2?'  \u2014 still SOLID on genuine companies alone':(An.tstat>=1?'  \u2014 drops to PROMISING territory':'  \u2014 the edge does NOT hold up on companies alone')));
     lines.push('  real companies only, most-picked first (name: appearances, avg move, win%):');
     var bt=rn.byTicker;
     for(var t=0;t<bt.length;t++){ var it=bt[t]; lines.push('    '+it.ticker+': '+it.n+'x  '+(it.avgOut>=0?'+':'')+it.avgOut+'%  '+it.winRate+'% win'); }
     lines.push('');
    }
    lines.push('Exclusion: ~200 known ETFs/ETPs (ASX June 2020 snapshot + HVLU/HNDQ) PLUS a structural rule for hybrids/preference shares/notes (3-char company code + P/H/G + series letter, e.g. CBAPK, NABPI \u2014 confirmed against ASX'+"'"+'s own naming-convention page) PLUS government bonds (GSB/GSI prefix, e.g. GSBG27 \u2014 confirmed against ASX'+"'"+'s own eAGB list). The hybrid/bond rule is structural, not a static list, so it will catch new issuances automatically \u2014 but any rule carries a small edge-case risk a curated list does not.');
    say(lines.join('\\n'));
    b.disabled=false;
    return;
   }
   var job=jobs[i];
   call('/admin/evidence-top7?hold='+job.h+'&n=7'+(job.ex?'&excludeNonEquity=1':''),function(j){
    if(j&&j.result){ if(job.ex)clean[job.h]=j.result; else withAll[job.h]=j.result; }
    next(i+1);
   });
  };
  next(0);
 };
 document.getElementById('dipLadderBT').onclick=function(){
  var b=this; b.disabled=true; say('Running the dip-ladder backtest — 6 weeks back, first 2 weeks as an entry window, four levels per candidate, tracked through the full window with a trailing stop + profit ladder + scale-out. One replay, may take a moment.');
  call('/admin/dip-ladder-backtest',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var r=j.result, P=r.params, lines=[];
   lines.push('=== DIP-LADDER BACKTEST — '+j.exch+' ===','');
   lines.push('Window: '+r.windowStartDate+' \u2192 '+r.entryEndDate+' (entry window ends) \u2192 '+r.windowEndDate+' (window ends)');
   lines.push('Entry window: '+P.entryWeeks+' week'+(P.entryWeeks===1?'':'s')+' \u00b7 total window: '+P.totalWeeks+' weeks \u00b7 top '+P.topN+' by evidence, each day');
   lines.push('$'+P.amountPerLevel.toLocaleString()+' per level \u00d7 4 levels ('+P.levels.map(function(l){return l===0?'market':l+'%';}).join(', ')+') per candidate');
   lines.push('Exit rules: '+P.trailPct+'% trailing stop \u00b7 profit ladder every '+P.ladderStep+'% (margin '+P.ladderMargin+'%, no separate margin was specified so this defaults to 0 \u2014 flagging that assumption, not hiding it) \u00b7 one-time '+P.scalePct+'% scale-out at +'+P.scaleTrigger+'%, remainder keeps riding the ladder');
   lines.push('','Candidates found: '+r.candidateCount+' (first appearance only \u2014 a ticker re-picked on a later day within the entry window is not bought again)','');
   lines.push('=== PER LEVEL ===');
   r.perLevelSummary.forEach(function(s){
    var lbl=s.level===0?'Market':(s.level+'% dip');
    lines.push(lbl+': '+s.filled+'/'+r.candidateCount+' filled'+(s.notFilled?(' ('+s.notFilled+' never reached that level)'):'')+
      (s.filled?('  \u00b7  invested $'+s.invested.toLocaleString()+'  \u00b7  proceeds $'+s.proceeds.toLocaleString()+'  \u00b7  P/L '+(s.pl>=0?'+':'')+'$'+s.pl.toLocaleString()+' ('+(s.plPct>=0?'+':'')+s.plPct+'%)  \u00b7  '+s.winRate+'% win rate'):''));
   });
   lines.push('','=== PER CANDIDATE ===');
   r.candidates.forEach(function(c,ix){
    lines.push((ix+1)+'. '+c.ticker+' \u2014 picked '+c.pickDate+' on '+c.evidenceKey+' ('+c.tier+', edge '+(c.edge>=0?'+':'')+c.edge.toFixed(2)+')');
    c.levels.forEach(function(lv){
     var lbl=lv.level===0?'  market':('  '+lv.level+'%  ');
     if(!lv.filled){ lines.push(lbl+': never filled (limit '+(lv.limitPrice!=null?'$'+lv.limitPrice:'n/a')+')'); return; }
     lines.push(lbl+': filled '+lv.fillDate+' @ $'+lv.fillPrice+(lv.scaledOut?('  \u00b7  scaled out '+lv.scaleOutDay+' @ $'+lv.scaleOutPrice):'')+'  \u2192  exit '+lv.exitDate+' @ $'+lv.exitPrice+' ('+lv.exitWhy+')  \u00b7  '+(lv.plPct>=0?'+':'')+lv.plPct+'%');
    });
    lines.push('');
   });
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderRecurBT').onclick=function(){
  var b=this; b.disabled=true; say('Running the recurring dip-ladder backtest — 12 months back, buying every week (fresh top-7 picked each week, a ticker can be bought again in a later week if it fires again), each position tracked on its own trailing stop + profit ladder + scale-out all the way to the end of the window or being stopped out. One replay across a full year, this will take a while — leave this page open.');
  call('/admin/dip-ladder-backtest-recurring',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var r=j.result, P=r.params, lines=[];
   lines.push('=== DIP-LADDER BACKTEST, RECURRING WEEKLY ENTRIES — '+j.exch+' ===','');
   lines.push('Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate+' ('+r.blockCount+' weekly entry blocks)');
   lines.push('Each week: top '+P.topN+' by evidence, fresh pick \u00b7 a ticker already bought CAN be bought again in a later week if it fires again (deduped only WITHIN each week, not across the whole year)');
   lines.push('$'+P.amountPerLevel.toLocaleString()+' per level \u00d7 4 levels ('+P.levels.map(function(l){return l===0?'market':l+'%';}).join(', ')+') per candidate, limit orders good for that one entry week only');
   lines.push('Exit rules: '+P.trailPct+'% trailing stop \u00b7 profit ladder every '+P.ladderStep+'% (margin '+P.ladderMargin+'%, no separate margin was specified so this defaults to 0 \u2014 flagging that assumption, not hiding it) \u00b7 one-time '+P.scalePct+'% scale-out at +'+P.scaleTrigger+'%, remainder keeps riding the ladder \u2014 every position rides all the way to the FULL window end or a stop-out, whichever comes first, regardless of which week it entered in');
   lines.push('','Total entries across the year: '+r.candidateCount+' (this counts repeat picks of the same ticker in different weeks separately \u2014 see byTicker below for concentration)','');
   lines.push('=== PER LEVEL (whole year) ===');
   r.perLevelSummary.forEach(function(s){
    var lbl=s.level===0?'Market':(s.level+'% dip');
    lines.push(lbl+': '+s.filled+'/'+r.candidateCount+' filled'+(s.notFilled?(' ('+s.notFilled+' never reached that level within their entry week)'):'')+
      (s.filled?('  \u00b7  invested $'+s.invested.toLocaleString()+'  \u00b7  proceeds $'+s.proceeds.toLocaleString()+'  \u00b7  P/L '+(s.pl>=0?'+':'')+'$'+s.pl.toLocaleString()+' ('+(s.plPct>=0?'+':'')+s.plPct+'%)  \u00b7  '+s.winRate+'% win rate'):''));
   });
   lines.push('','=== BY TICKER \u2014 repeat-pick concentration, most-picked first ===');
   r.byTicker.forEach(function(t){ lines.push('  '+t.ticker+': picked '+t.timesPicked+'x across the year  \u00b7  invested $'+t.invested.toLocaleString()+'  \u00b7  P/L '+(t.pl>=0?'+':'')+'$'+t.pl.toLocaleString()); });
   lines.push('','=== EVERY ENTRY, IN FULL ===');
   r.candidates.forEach(function(c,ix){
    lines.push((ix+1)+'. '+c.ticker+' \u2014 entered week of '+c.weekStart+', picked '+c.pickDate+' on '+c.evidenceKey+' ('+c.tier+', edge '+(c.edge>=0?'+':'')+c.edge.toFixed(2)+')');
    c.levels.forEach(function(lv){
     var lbl=lv.level===0?'  market':('  '+lv.level+'%  ');
     if(!lv.filled){ lines.push(lbl+': never filled (limit '+(lv.limitPrice!=null?'$'+lv.limitPrice:'n/a')+')'); return; }
     lines.push(lbl+': filled '+lv.fillDate+' @ $'+lv.fillPrice+(lv.scaledOut?('  \u00b7  scaled out '+lv.scaleOutDay+' @ $'+lv.scaleOutPrice):'')+'  \u2192  exit '+lv.exitDate+' @ $'+lv.exitPrice+' ('+lv.exitWhy+')  \u00b7  '+(lv.plPct>=0?'+':'')+lv.plPct+'%');
    });
    lines.push('');
   });
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderFixedTS').onclick=function(){
  var b=this; b.disabled=true; say('Running the fixed target/stop dip-ladder backtest — 12 months, buying every week, but with a simple fixed take-profit and stop-loss instead of the trailing stop/ladder, and each share bought at most ONCE across the whole year. Running both combinations (10%/10% and 5%/10%) on the same data. This will take a while — leave this page open.');
  call('/admin/dip-ladder-backtest-fixedts',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.combos){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var lines=[];
   lines.push('=== DIP-LADDER BACKTEST, FIXED TARGET/STOP — '+j.exch+' ===','');
   j.combos.forEach(function(combo){
    var r=combo.result, P=r.params;
    lines.push('───────────────────────────────────────────','COMBINATION: '+combo.label,'───────────────────────────────────────────');
    lines.push('Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate+' ('+r.blockCount+' weekly entry blocks) \u00b7 top '+P.topN+' by evidence each week \u00b7 each share bought AT MOST ONCE across the whole year (global dedupe, no repeat buys)');
    lines.push('$'+P.amountPerLevel.toLocaleString()+' per level \u00d7 4 levels ('+P.levels.map(function(l){return l===0?'market':l+'%';}).join(', ')+') per candidate \u00b7 exit: +'+P.targetPct+'% take-profit or \u2212'+P.stopPct+'% stop-loss, whichever hits first \u2014 no trailing stop, no ladder, no scale-out');
    lines.push('Candidates: '+r.candidateCount,'');
    lines.push('PER LEVEL:');
    r.perLevelSummary.forEach(function(s){
     var lbl=s.level===0?'Market':(s.level+'% dip');
     lines.push('  '+lbl+': '+s.filled+'/'+r.candidateCount+' filled'+(s.notFilled?(' ('+s.notFilled+' never reached that level within their entry week)'):'')+
       (s.filled?('  \u00b7  invested $'+s.invested.toLocaleString()+'  \u00b7  proceeds $'+s.proceeds.toLocaleString()+'  \u00b7  P/L '+(s.pl>=0?'+':'')+'$'+s.pl.toLocaleString()+' ('+(s.plPct>=0?'+':'')+s.plPct+'%)  \u00b7  '+s.winRate+'% win rate'):''));
    });
    lines.push('');
   });
   lines.push('=== EVERY ENTRY, BOTH COMBINATIONS ===','');
   j.combos.forEach(function(combo){
    lines.push('--- '+combo.label+' ---');
    combo.result.candidates.forEach(function(c,ix){
     lines.push((ix+1)+'. '+c.ticker+' \u2014 entered week of '+c.weekStart+', picked '+c.pickDate+' on '+c.evidenceKey+' ('+c.tier+', edge '+(c.edge>=0?'+':'')+c.edge.toFixed(2)+')');
     c.levels.forEach(function(lv){
      var lbl=lv.level===0?'  market':('  '+lv.level+'%  ');
      if(!lv.filled){ lines.push(lbl+': never filled (limit '+(lv.limitPrice!=null?'$'+lv.limitPrice:'n/a')+')'); return; }
      lines.push(lbl+': filled '+lv.fillDate+' @ $'+lv.fillPrice+'  \u2192  exit '+lv.exitDate+' @ $'+lv.exitPrice+' ('+lv.exitWhy+')  \u00b7  '+(lv.plPct>=0?'+':'')+lv.plPct+'%');
     });
     lines.push('');
    });
   });
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderTop4').onclick=function(){
  var b=this; b.disabled=true; say('Running the fixed target/stop dip-ladder backtest — top 4 by evidence each week instead of top 7, once-only across the year, four buy levels per candidate. Running 10%/10% and 7%/10% on the same data. This will take a while — leave this page open.');
  call('/admin/dip-ladder-backtest-fixedts-top4',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.combos){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var lines=[];
   lines.push('=== DIP-LADDER BACKTEST, TOP 4 BY EVIDENCE, FIXED TARGET/STOP — '+j.exch+' ===','');
   j.combos.forEach(function(combo){
    var r=combo.result, P=r.params;
    lines.push('───────────────────────────────────────────','COMBINATION: '+combo.label,'───────────────────────────────────────────');
    lines.push('Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate+' ('+r.blockCount+' weekly entry blocks) \u00b7 top '+P.topN+' by evidence each week \u00b7 each share bought AT MOST ONCE across the whole year (global dedupe, no repeat buys)');
    lines.push('$'+P.amountPerLevel.toLocaleString()+' per level \u00d7 4 levels ('+P.levels.map(function(l){return l===0?'market':l+'%';}).join(', ')+') per candidate \u00b7 exit: +'+P.targetPct+'% take-profit or \u2212'+P.stopPct+'% stop-loss, whichever hits first \u2014 no trailing stop, no ladder, no scale-out');
    lines.push('Candidates: '+r.candidateCount,'');
    lines.push('PER LEVEL:');
    r.perLevelSummary.forEach(function(s){
     var lbl=s.level===0?'Market':(s.level+'% dip');
     lines.push('  '+lbl+': '+s.filled+'/'+r.candidateCount+' filled'+(s.notFilled?(' ('+s.notFilled+' never reached that level within their entry week)'):'')+
       (s.filled?('  \u00b7  invested $'+s.invested.toLocaleString()+'  \u00b7  proceeds $'+s.proceeds.toLocaleString()+'  \u00b7  P/L '+(s.pl>=0?'+':'')+'$'+s.pl.toLocaleString()+' ('+(s.plPct>=0?'+':'')+s.plPct+'%)  \u00b7  '+s.winRate+'% win rate'):''));
    });
    lines.push('');
   });
   lines.push('=== EVERY ENTRY, BOTH COMBINATIONS ===','');
   j.combos.forEach(function(combo){
    lines.push('--- '+combo.label+' ---');
    combo.result.candidates.forEach(function(c,ix){
     lines.push((ix+1)+'. '+c.ticker+' \u2014 entered week of '+c.weekStart+', picked '+c.pickDate+' on '+c.evidenceKey+' ('+c.tier+', edge '+(c.edge>=0?'+':'')+c.edge.toFixed(2)+')');
     c.levels.forEach(function(lv){
      var lbl=lv.level===0?'  market':('  '+lv.level+'%  ');
      if(!lv.filled){ lines.push(lbl+': never filled (limit '+(lv.limitPrice!=null?'$'+lv.limitPrice:'n/a')+')'); return; }
      lines.push(lbl+': filled '+lv.fillDate+' @ $'+lv.fillPrice+'  \u2192  exit '+lv.exitDate+' @ $'+lv.exitPrice+' ('+lv.exitWhy+')  \u00b7  '+(lv.plPct>=0?'+':'')+lv.plPct+'%');
     });
     lines.push('');
    });
   });
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderScored').onclick=function(){
  var b=this; b.disabled=true; say('Running the fixed target/stop dip-ladder backtest — top 4 by evidence each week, but now requiring a computed score of 7+ (solid signals, plus any strong-promising one scoring just as well), once-only across the year. Running 10%/10% and 7%/10% on the same data. This will take a while — leave this page open.');
  call('/admin/dip-ladder-backtest-fixedts-scored',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.combos){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var lines=[];
   lines.push('=== DIP-LADDER BACKTEST, SOLID + 7-RATED-AND-ABOVE, FIXED TARGET/STOP — '+j.exch+' ===','');
   j.combos.forEach(function(combo){
    var r=combo.result, P=r.params;
    lines.push('───────────────────────────────────────────','COMBINATION: '+combo.label,'───────────────────────────────────────────');
    lines.push('Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate+' ('+r.blockCount+' weekly entry blocks) \u00b7 top '+P.topN+' by evidence each week, evidence must score '+P.minScore+'+ (solid signals always qualify; a strong-promising one can too) \u00b7 each share bought AT MOST ONCE across the whole year');
    lines.push('$'+P.amountPerLevel.toLocaleString()+' per level \u00d7 4 levels ('+P.levels.map(function(l){return l===0?'market':l+'%';}).join(', ')+') per candidate \u00b7 exit: +'+P.targetPct+'% take-profit or \u2212'+P.stopPct+'% stop-loss, whichever hits first \u2014 no trailing stop, no ladder, no scale-out');
    lines.push('Candidates: '+r.candidateCount,'');
    lines.push('PER LEVEL:');
    r.perLevelSummary.forEach(function(s){
     var lbl=s.level===0?'Market':(s.level+'% dip');
     lines.push('  '+lbl+': '+s.filled+'/'+r.candidateCount+' filled'+(s.notFilled?(' ('+s.notFilled+' never reached that level within their entry week)'):'')+
       (s.filled?('  \u00b7  invested $'+s.invested.toLocaleString()+'  \u00b7  proceeds $'+s.proceeds.toLocaleString()+'  \u00b7  P/L '+(s.pl>=0?'+':'')+'$'+s.pl.toLocaleString()+' ('+(s.plPct>=0?'+':'')+s.plPct+'%)  \u00b7  '+s.winRate+'% win rate'):''));
    });
    lines.push('');
   });
   lines.push('=== EVERY ENTRY, BOTH COMBINATIONS ===','');
   j.combos.forEach(function(combo){
    lines.push('--- '+combo.label+' ---');
    combo.result.candidates.forEach(function(c,ix){
     lines.push((ix+1)+'. '+c.ticker+' \u2014 entered week of '+c.weekStart+', picked '+c.pickDate+' on '+c.evidenceKey+' ('+c.tier+', score '+c.score+', edge '+(c.edge>=0?'+':'')+c.edge.toFixed(2)+')');
     c.levels.forEach(function(lv){
      var lbl=lv.level===0?'  market':('  '+lv.level+'%  ');
      if(!lv.filled){ lines.push(lbl+': never filled (limit '+(lv.limitPrice!=null?'$'+lv.limitPrice:'n/a')+')'); return; }
      lines.push(lbl+': filled '+lv.fillDate+' @ $'+lv.fillPrice+'  \u2192  exit '+lv.exitDate+' @ $'+lv.exitPrice+' ('+lv.exitWhy+')  \u00b7  '+(lv.plPct>=0?'+':'')+lv.plPct+'%');
     });
     lines.push('');
    });
   });
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderCapped').onclick=function(){
  var b=this; b.disabled=true; say('Running the dip-ladder backtest with a real cap on concurrent positions — once the cap is full, new candidates are skipped entirely, same as a real auto-pilot with a maxPositions limit. Single buy level, admission ordered by actual fill date (not pick date) since orders can sit unfilled for up to a week. Running 10%/10% and 7%/10%. This will take a while — leave this page open.');
  call('/admin/dip-ladder-backtest-capped',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.combos){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var lines=[];
   lines.push('=== DIP-LADDER BACKTEST, REAL POSITION CAP — '+j.exch+' ===','');
   j.combos.forEach(function(combo){
    var r=combo.result, P=r.params, S=r.summary;
    lines.push('───────────────────────────────────────────','COMBINATION: '+combo.label,'───────────────────────────────────────────');
    lines.push('Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate+' \u00b7 top '+P.topN+' by evidence each week, score '+P.minScore+'+ \u00b7 once-only per year \u00b7 single buy level: '+(P.buyLevel===0?'market':P.buyLevel+'% dip')+' \u00b7 max '+P.maxPositions+' positions held at once, cap enforced by ACTUAL fill order');
    lines.push('$'+P.amountPerLevel.toLocaleString()+' per position \u00b7 fixed capital required: $'+r.fixedCapitalRequired.toLocaleString()+' (= '+P.maxPositions+' \u00d7 $'+P.amountPerLevel.toLocaleString()+' \u2014 a known number, not an estimate) \u00b7 exit: +'+P.targetPct+'% take-profit or \u2212'+P.stopPct+'% stop-loss, no trailing/ladder/scale-out');
    lines.push('Offered: '+S.offered+' \u00b7 skipped (cap full at their fill moment): '+S.skippedForCap+' \u00b7 taken: '+S.taken+' \u00b7 filled: '+S.filled+' \u00b7 never reached the buy level: '+S.notFilled);
    lines.push('Invested $'+S.invested.toLocaleString()+' \u00b7 proceeds $'+S.proceeds.toLocaleString()+' \u00b7 P/L '+(S.pl>=0?'+':'')+'$'+S.pl.toLocaleString()+' ('+(S.plPct>=0?'+':'')+S.plPct+'%) \u00b7 '+S.winRate+'% win rate \u00b7 return on the fixed capital: '+(r.fixedCapitalRequired>0?((S.pl/r.fixedCapitalRequired)*100).toFixed(1):'0')+'%');
    lines.push('');
   });
   lines.push('=== EVERY OFFERED CANDIDATE, BOTH COMBINATIONS ===','');
   j.combos.forEach(function(combo){
    lines.push('--- '+combo.label+' ---');
    combo.result.candidates.forEach(function(c,ix){
     var lv=c.level;
     lines.push((ix+1)+'. '+c.ticker+' \u2014 picked '+c.pickDate+' on '+c.evidenceKey+' ('+c.tier+', score '+c.score+', edge '+(c.edge>=0?'+':'')+c.edge.toFixed(2)+')');
     if(c.skipped){ lines.push('  SKIPPED \u2014 cap was full ('+c.openAtFill+'/'+combo.result.params.maxPositions+' already open) at the moment this would have filled'); }
     else if(!lv||!lv.filled){ lines.push('  never filled (limit '+(lv&&lv.limitPrice!=null?'$'+lv.limitPrice:'n/a')+')'); }
     else { lines.push('  filled '+lv.fillDate+' @ $'+lv.fillPrice+'  \u2192  exit '+lv.exitDate+' @ $'+lv.exitPrice+' ('+lv.exitWhy+')  \u00b7  '+(lv.plPct>=0?'+':'')+lv.plPct+'%  \u00b7  '+c.openAtFill+' others open at the time'); }
     lines.push('');
    });
   });
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderGrid').onclick=function(){
  var b=this; b.disabled=true; say('Running a target x stop grid search — sweeping BOTH sides (the stop has never been varied before, only the target), with ETFs/hybrids/bonds excluded (proven to help the evidence edge earlier tonight, applied here for the first time). Grading and picking happen once; only the cheap simulation re-runs per cell, so this should not take too long. Leave this page open.');
  call('/admin/dip-ladder-grid-search',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var r=j.result, P=r.params, lines=[];
   lines.push('=== DIP-LADDER GRID SEARCH — '+j.exch+' ===','');
   lines.push('Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate+' \u00b7 top '+P.topN+' by evidence each week, score '+P.minScore+'+ \u00b7 once-only per year \u00b7 4 buy levels per candidate \u00b7 ETFs/hybrids/bonds '+(r.excludeNonEquity?'EXCLUDED':'included')+' ('+r.universeAfterExclusion+' tickers in the graded universe)');
   lines.push('Candidates: '+r.candidateCount+' \u00b7 targets tested: '+P.targets.join('%, ')+'% \u00b7 stops tested: '+P.stops.join('%, ')+'%','');
   lines.push('=== RESULTS, BEST RETURN FIRST ===');
   r.grid.forEach(function(cell,ix){
    lines.push((ix+1)+'. target +'+cell.targetPct+'% / stop \u2212'+cell.stopPct+'%  \u2014  '+cell.filled+' filled  \u00b7  invested $'+cell.invested.toLocaleString()+'  \u00b7  P/L '+(cell.pl>=0?'+':'')+'$'+cell.pl.toLocaleString()+' ('+(cell.plPct>=0?'+':'')+cell.plPct+'%)  \u00b7  '+cell.winRate+'% win rate');
   });
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderGridExt').onclick=function(){
  var b=this; b.disabled=true; say('Running the EXTENDED grid search — the first grid was still climbing at every edge (wider target always won, wider stop always won, no exceptions), so this pushes further out to see whether it actually turns over anywhere. Same engine, same setup. Leave this page open.');
  call('/admin/dip-ladder-grid-search-extended',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var r=j.result, P=r.params, lines=[];
   lines.push('=== DIP-LADDER GRID SEARCH, EXTENDED RANGE — '+j.exch+' ===','');
   lines.push('Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate+' \u00b7 top '+P.topN+' by evidence each week, score '+P.minScore+'+ \u00b7 once-only per year \u00b7 4 buy levels per candidate \u00b7 ETFs/hybrids/bonds '+(r.excludeNonEquity?'EXCLUDED':'included')+' ('+r.universeAfterExclusion+' tickers in the graded universe)');
   lines.push('Candidates: '+r.candidateCount+' \u00b7 targets tested: '+P.targets.join('%, ')+'% \u00b7 stops tested: '+P.stops.join('%, ')+'%','');
   lines.push('=== RESULTS, BEST RETURN FIRST ===');
   r.grid.forEach(function(cell,ix){
    lines.push((ix+1)+'. target +'+cell.targetPct+'% / stop \u2212'+cell.stopPct+'%  \u2014  '+cell.filled+' filled  \u00b7  invested $'+cell.invested.toLocaleString()+'  \u00b7  P/L '+(cell.pl>=0?'+':'')+'$'+cell.pl.toLocaleString()+' ('+(cell.plPct>=0?'+':'')+cell.plPct+'%)  \u00b7  '+cell.winRate+'% win rate');
   });
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderGridFar').onclick=function(){
  var b=this; b.disabled=true; say('Running the FAR range grid search — the extended grid found the first real interior peak anywhere in this exploration (target 15-20% actually does worse at stop -30 than -25), but everywhere else was still climbing at the edge, with the overall winner still the widest corner tested. This pushes further into that still-climbing region. Same engine, same setup. A reminder while this runs: a -30% or wider stop is a real, large drawdown on any single position before it gets cut, and this window is mostly a rising market — worth weighing that against whatever number comes back. Leave this page open.');
  call('/admin/dip-ladder-grid-search-far',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var r=j.result, P=r.params, lines=[];
   lines.push('=== DIP-LADDER GRID SEARCH, FAR RANGE — '+j.exch+' ===','');
   lines.push('Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate+' \u00b7 top '+P.topN+' by evidence each week, score '+P.minScore+'+ \u00b7 once-only per year \u00b7 4 buy levels per candidate \u00b7 ETFs/hybrids/bonds '+(r.excludeNonEquity?'EXCLUDED':'included')+' ('+r.universeAfterExclusion+' tickers in the graded universe)');
   lines.push('Candidates: '+r.candidateCount+' \u00b7 targets tested: '+P.targets.join('%, ')+'% \u00b7 stops tested: '+P.stops.join('%, ')+'%','');
   lines.push('=== RESULTS, BEST RETURN FIRST ===');
   r.grid.forEach(function(cell,ix){
    lines.push((ix+1)+'. target +'+cell.targetPct+'% / stop \u2212'+cell.stopPct+'%  \u2014  '+cell.filled+' filled  \u00b7  invested $'+cell.invested.toLocaleString()+'  \u00b7  P/L '+(cell.pl>=0?'+':'')+'$'+cell.pl.toLocaleString()+' ('+(cell.plPct>=0?'+':'')+cell.plPct+'%)  \u00b7  '+cell.winRate+'% win rate');
   });
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderGridDiag').onclick=function(){
  var b=this; b.disabled=true; say('Running the exit-reason diagnostic — three grid rounds in a row found the widest tested corner still winning, never once turning over. Before pushing wider again, this checks how positions ACTUALLY exit at a few points along that range: genuine target hit, genuine stop hit, or just ran out the window still open. Leave this page open.');
  call('/admin/dip-ladder-grid-diagnostic',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var r=j.result, P=r.params, lines=[];
   lines.push('=== WHY DOES WIDER KEEP WINNING? — '+j.exch+' ===','');
   lines.push('Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate+' \u00b7 top '+P.topN+' by evidence each week, score '+P.minScore+'+ \u00b7 once-only per year \u00b7 4 buy levels per candidate \u00b7 ETFs/hybrids/bonds '+(r.excludeNonEquity?'EXCLUDED':'included')+' ('+r.universeAfterExclusion+' tickers in the graded universe)');
   lines.push('Candidates: '+r.candidateCount+'','');
   lines.push('For each pair: how positions actually exited, not just the P/L.','');
   r.results.forEach(function(row){
    lines.push('target +'+row.targetPct+'% / stop \u2212'+row.stopPct+'%  \u2014  '+row.filled+' filled  \u00b7  P/L '+(row.pl>=0?'+':'')+'$'+row.pl.toLocaleString()+' ('+(row.plPct>=0?'+':'')+row.plPct+'%)  \u00b7  '+row.winRate+'% win rate');
    lines.push('  hit target: '+row.targetHits+' ('+row.targetHitPct+'%)  \u00b7  hit stop: '+row.stopHits+' ('+row.stopHitPct+'%)  \u00b7  ran out the window still open: '+row.windowEndHits+' ('+row.windowEndPct+'%)');
    lines.push('');
   });
   lines.push('If the window-end share climbs sharply for the wider pairs, most of that P/L is coming from wherever the stock happened to be trading on the last day, not from the target/stop rule actually firing \u2014 which means it is closer to measuring buy-and-hold over this one year than a genuine exit strategy.');
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderCapCost').onclick=function(){
  var b=this; b.disabled=true; say('Running the capital-cost comparison — same pairs as the exit-reason check, but through the REAL position-cap mechanism (max 8 at once, $40,000 fixed capital), tracking how much longer positions actually sit open and how often the cap turns a candidate away as the gap widens. This will take a little longer since each pair re-grades the market. Leave this page open.');
  call('/admin/dip-ladder-capital-cost',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.rows){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var lines=[];
   lines.push('=== CAPITAL COST OF WIDENING — '+j.exch+' ===','');
   lines.push('Max '+j.maxPositions+' positions at once \u00b7 fixed capital $'+(j.maxPositions*5000).toLocaleString()+' \u00b7 single -5% dip buy level \u00b7 top 4 by evidence, score 7+, once-only per year','');
   j.rows.forEach(function(row){
    var s=row.summary;
    lines.push('target +'+row.targetPct+'% / stop \u2212'+row.stopPct+'%');
    lines.push('  offered '+s.offered+' \u00b7 skipped because the cap was full: '+s.skippedForCap+' \u00b7 filled '+s.filled+' \u00b7 avg hold '+s.avgHoldDays+' days (median '+s.medianHoldDays+')');
    lines.push('  P/L '+(s.pl>=0?'+':'')+'$'+s.pl.toLocaleString()+'  \u2192  return on the fixed $'+row.fixedCapitalRequired.toLocaleString()+': '+(s.plPct>=0?'+':'')+((s.pl/row.fixedCapitalRequired)*100).toFixed(1)+'%  \u00b7  '+s.winRate+'% win rate');
    lines.push('');
   });
   lines.push('Watch two things across the rows: whether the skip count climbs as the gap widens (fewer trades actually taken through the same cap), and whether return on the FIXED capital still favors the widest pair once hold time is this much longer \u2014 or whether the faster-turnover pair actually wins once capital is the real constraint rather than assumed unlimited.');
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderCapCost3yr').onclick=function(){
  var b=this; b.disabled=true; say('Running the capital-cost comparison over the longest window the stored history supports (~2.7 years, since a true 3 years is not quite available yet) — same pairs, same real position cap, a much more representative sample than a single mostly-rising year. This reads more history than usual and re-grades the market four times, so it will take noticeably longer than the 1-year version. Leave this page open.');
  call('/admin/dip-ladder-capital-cost-3yr',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.rows){
    var msg='No result came back.';
    if(j&&j.error){ msg+=' ('+j.error+')'; if(j.historyFrom){ msg+=' Stored history only goes back to '+j.historyFrom+', which is not enough for the requested window.'; } }
    say(msg,true); return;
   }
   var lines=[];
   lines.push('=== CAPITAL COST OF WIDENING, ~2.7 YEARS — '+j.exch+' ===','');
   lines.push('History available from: '+j.historyFrom+' \u00b7 max '+j.maxPositions+' positions at once \u00b7 fixed capital $'+(j.maxPositions*5000).toLocaleString()+' \u00b7 single -5% dip buy level \u00b7 top 4 by evidence, score 7+, once-only across the window','');
   if(j.rows[0]) lines.push('Window: '+j.rows[0].windowStartDate+' \u2192 '+j.rows[0].windowEndDate,'');
   j.rows.forEach(function(row){
    var s=row.summary;
    lines.push('target +'+row.targetPct+'% / stop \u2212'+row.stopPct+'%');
    lines.push('  offered '+s.offered+' \u00b7 skipped because the cap was full: '+s.skippedForCap+' \u00b7 filled '+s.filled+' \u00b7 avg hold '+s.avgHoldDays+' days (median '+s.medianHoldDays+')');
    lines.push('  P/L '+(s.pl>=0?'+':'')+'$'+s.pl.toLocaleString()+'  \u2192  return on the fixed $'+row.fixedCapitalRequired.toLocaleString()+': '+(s.plPct>=0?'+':'')+((s.pl/row.fixedCapitalRequired)*100).toFixed(1)+'%  \u00b7  '+s.winRate+'% win rate');
    lines.push('');
   });
   lines.push('Same two things to watch, now across 3 years of market conditions instead of 1: does the skip count and hold time follow the same pattern, and does the widest pair still win on return-on-fixed-capital once the sample includes more than just a single rising year.');
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderCapCostNarrow').onclick=function(){
  var b=this; b.disabled=true; say('Running the capital-cost comparison for 10/15, 15/15, and 20/20 — filling in around the zone that looked most defensible, over the 1-year window. Leave this page open.');
  call('/admin/dip-ladder-capital-cost-narrow',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.rows){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var lines=[];
   lines.push('=== CAPITAL COST, 10/15 vs 15/15 vs 20/20 (1 YEAR) — '+j.exch+' ===','');
   lines.push('Max '+j.maxPositions+' positions at once \u00b7 fixed capital $'+(j.maxPositions*5000).toLocaleString()+' \u00b7 single -5% dip buy level \u00b7 top 4 by evidence, score 7+, once-only per year','');
   if(j.rows[0]) lines.push('Window: '+j.rows[0].windowStartDate+' \u2192 '+j.rows[0].windowEndDate,'');
   j.rows.forEach(function(row){
    var s=row.summary;
    lines.push('target +'+row.targetPct+'% / stop \u2212'+row.stopPct+'%');
    lines.push('  offered '+s.offered+' \u00b7 skipped because the cap was full: '+s.skippedForCap+' \u00b7 filled '+s.filled+' \u00b7 avg hold '+s.avgHoldDays+' days (median '+s.medianHoldDays+')');
    lines.push('  P/L '+(s.pl>=0?'+':'')+'$'+s.pl.toLocaleString()+'  \u2192  return on the fixed $'+row.fixedCapitalRequired.toLocaleString()+': '+(s.plPct>=0?'+':'')+((s.pl/row.fixedCapitalRequired)*100).toFixed(1)+'%  \u00b7  '+s.winRate+'% win rate');
    lines.push('');
   });
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderCapCostNarrow3yr').onclick=function(){
  var b=this; b.disabled=true; say('Running the capital-cost comparison for 10/15, 15/15, and 20/20 over the longest window the stored history supports (~2.7 years). Leave this page open.');
  call('/admin/dip-ladder-capital-cost-narrow-3yr',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.rows){
    var msg='No result came back.';
    if(j&&j.error){ msg+=' ('+j.error+')'; if(j.historyFrom){ msg+=' Stored history only goes back to '+j.historyFrom+', which is not enough for the requested window.'; } }
    say(msg,true); return;
   }
   var lines=[];
   lines.push('=== CAPITAL COST, 10/15 vs 15/15 vs 20/20 (~2.7 YEARS) — '+j.exch+' ===','');
   lines.push('History available from: '+j.historyFrom+' \u00b7 max '+j.maxPositions+' positions at once \u00b7 fixed capital $'+(j.maxPositions*5000).toLocaleString()+' \u00b7 single -5% dip buy level \u00b7 top 4 by evidence, score 7+, once-only across the window','');
   if(j.rows[0]) lines.push('Window: '+j.rows[0].windowStartDate+' \u2192 '+j.rows[0].windowEndDate,'');
   j.rows.forEach(function(row){
    var s=row.summary;
    lines.push('target +'+row.targetPct+'% / stop \u2212'+row.stopPct+'%');
    lines.push('  offered '+s.offered+' \u00b7 skipped because the cap was full: '+s.skippedForCap+' \u00b7 filled '+s.filled+' \u00b7 avg hold '+s.avgHoldDays+' days (median '+s.medianHoldDays+')');
    lines.push('  P/L '+(s.pl>=0?'+':'')+'$'+s.pl.toLocaleString()+'  \u2192  return on the fixed $'+row.fixedCapitalRequired.toLocaleString()+': '+(s.plPct>=0?'+':'')+((s.pl/row.fixedCapitalRequired)*100).toFixed(1)+'%  \u00b7  '+s.winRate+'% win rate');
    lines.push('');
   });
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderCompounding').onclick=function(){
  var b=this; b.disabled=true; say('Running 15%/15% starting from $50,000 and compounding over the ~2.7-year window — each new position is sized as a share of whatever the account is worth AT THE MOMENT it opens, not a fixed dollar amount, so wins early on make later positions bigger and losses make them smaller. Max 8 positions at once, single -5% dip buy level, top 4 by evidence, score 7+, ETFs/hybrids/bonds excluded. Leave this page open.');
  call('/admin/dip-ladder-compounding',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){
    var msg='No result came back.';
    if(j&&j.error){ msg+=' ('+j.error+')'; if(j.historyFrom){ msg+=' Stored history only goes back to '+j.historyFrom+', which is not enough for the requested window.'; } }
    say(msg,true); return;
   }
   var r=j.result, P=r.params, lines=[];
   lines.push('=== 15%/15% COMPOUNDING FROM $50,000 — '+j.exch+' ===','');
   lines.push('History available from: '+j.historyFrom+' \u00b7 Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate);
   lines.push('Max '+P.maxPositions+' positions at once, each sized as (current account value) / '+P.maxPositions+' at the moment it fills \u00b7 target +'+P.targetPct+'% / stop \u2212'+P.stopPct+'% \u00b7 single -5% dip buy level \u00b7 top 4 by evidence, score 7+, ETFs/hybrids/bonds '+(r.excludeNonEquity?'EXCLUDED':'included')+' \u00b7 once-only across the window','');
   lines.push('Offered: '+r.offered+' \u00b7 skipped because the cap was full: '+r.skippedForCap+' \u00b7 taken: '+r.taken+' \u00b7 '+r.winRate+'% win rate','');
   lines.push('STARTING CAPITAL: $'+r.startingCapital.toLocaleString());
   lines.push('FINAL ACCOUNT VALUE: $'+r.finalAccountValue.toLocaleString()+'  ('+(r.totalReturnPct>=0?'+':'')+r.totalReturnPct+'% total return over the whole window)','');
   lines.push('=== EVERY TRADE, IN ORDER, SHOWING THE ACCOUNT COMPOUNDING ===','');
   r.trades.forEach(function(t,ix){
    lines.push((ix+1)+'. '+t.ticker+' \u2014 picked '+t.pickDate+' on '+t.evidenceKey+' ('+t.tier+', score '+t.score+')');
    lines.push('  account value at entry: $'+t.accountValueAtEntry.toLocaleString()+'  \u2192  position size: $'+t.positionSize.toLocaleString()+' ('+t.openAtFill+' others open at the time)');
    lines.push('  filled '+t.fillDate+' @ $'+t.fillPrice+'  \u2192  exit '+t.exitDate+' @ $'+t.exitPrice+' ('+t.exitWhy+')  \u00b7  '+(t.plPct>=0?'+':'')+t.plPct+'%  \u00b7  '+(t.dollarPL>=0?'+':'')+'$'+t.dollarPL.toLocaleString()+' to the account');
    lines.push('');
   });
   if(r.skipped.length){
    lines.push('=== SKIPPED — CAP WAS FULL AT THE MOMENT THESE WOULD HAVE FILLED ===','');
    r.skipped.forEach(function(s){ lines.push('  '+s.ticker+' \u2014 picked '+s.pickDate+', would have filled '+s.level.fillDate+' ('+s.openAtFill+'/'+P.maxPositions+' already open)'); });
   }
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderCompoundingMkt').onclick=function(){
  var b=this; b.disabled=true; say('Running the same 15%/15% compounding test, but buying at MARKET instead of waiting for a -5% dip \u2014 same $50,000 start, same 8-position cap, same evidence rules. Leave this page open.');
  call('/admin/dip-ladder-compounding?buyLevel=0',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){
    var msg='No result came back.';
    if(j&&j.error){ msg+=' ('+j.error+')'; if(j.historyFrom){ msg+=' Stored history only goes back to '+j.historyFrom+', which is not enough for the requested window.'; } }
    say(msg,true); return;
   }
   var r=j.result, P=r.params, lines=[];
   lines.push('=== 15%/15% COMPOUNDING FROM $50,000, MARKET ENTRY \u2014 '+j.exch+' ===','');
   lines.push('History available from: '+j.historyFrom+' \u00b7 Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate);
   lines.push('Max '+P.maxPositions+' positions at once, each sized as (current account value) / '+P.maxPositions+' at the moment it fills \u00b7 target +'+P.targetPct+'% / stop \u2212'+P.stopPct+'% \u00b7 buy level: market (no dip required) \u00b7 top 4 by evidence, score 7+, ETFs/hybrids/bonds '+(r.excludeNonEquity?'EXCLUDED':'included')+' \u00b7 once-only across the window','');
   lines.push('Offered: '+r.offered+' \u00b7 skipped because the cap was full: '+r.skippedForCap+' \u00b7 taken: '+r.taken+' \u00b7 '+r.winRate+'% win rate','');
   lines.push('STARTING CAPITAL: $'+r.startingCapital.toLocaleString());
   lines.push('FINAL ACCOUNT VALUE: $'+r.finalAccountValue.toLocaleString()+'  ('+(r.totalReturnPct>=0?'+':'')+r.totalReturnPct+'% total return over the whole window)','');
   lines.push('=== EVERY TRADE, IN ORDER, SHOWING THE ACCOUNT COMPOUNDING ===','');
   r.trades.forEach(function(t,ix){
    lines.push((ix+1)+'. '+t.ticker+' \u2014 picked '+t.pickDate+' on '+t.evidenceKey+' ('+t.tier+', score '+t.score+')');
    lines.push('  account value at entry: $'+t.accountValueAtEntry.toLocaleString()+'  \u2192  position size: $'+t.positionSize.toLocaleString()+' ('+t.openAtFill+' others open at the time)');
    lines.push('  filled '+t.fillDate+' @ $'+t.fillPrice+'  \u2192  exit '+t.exitDate+' @ $'+t.exitPrice+' ('+t.exitWhy+')  \u00b7  '+(t.plPct>=0?'+':'')+t.plPct+'%  \u00b7  '+(t.dollarPL>=0?'+':'')+'$'+t.dollarPL.toLocaleString()+' to the account');
    lines.push('');
   });
   if(r.skipped.length){
    lines.push('=== SKIPPED — CAP WAS FULL AT THE MOMENT THESE WOULD HAVE FILLED ===','');
    r.skipped.forEach(function(s){ lines.push('  '+s.ticker+' \u2014 picked '+s.pickDate+', would have filled '+s.level.fillDate+' ('+s.openAtFill+'/'+P.maxPositions+' already open)'); });
   }
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderCompoundingD25').onclick=function(){
  var b=this; b.disabled=true; say('Running the same 15%/15% compounding test, but buying at a -2.5% dip instead of -5% \u2014 same $50,000 start, same 8-position cap, same evidence rules. Leave this page open.');
  call('/admin/dip-ladder-compounding?buyLevel=-2.5',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){
    var msg='No result came back.';
    if(j&&j.error){ msg+=' ('+j.error+')'; if(j.historyFrom){ msg+=' Stored history only goes back to '+j.historyFrom+', which is not enough for the requested window.'; } }
    say(msg,true); return;
   }
   var r=j.result, P=r.params, lines=[];
   lines.push('=== 15%/15% COMPOUNDING FROM $50,000, -2.5% DIP ENTRY \u2014 '+j.exch+' ===','');
   lines.push('History available from: '+j.historyFrom+' \u00b7 Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate);
   lines.push('Max '+P.maxPositions+' positions at once, each sized as (current account value) / '+P.maxPositions+' at the moment it fills \u00b7 target +'+P.targetPct+'% / stop \u2212'+P.stopPct+'% \u00b7 buy level: -2.5% dip \u00b7 top 4 by evidence, score 7+, ETFs/hybrids/bonds '+(r.excludeNonEquity?'EXCLUDED':'included')+' \u00b7 once-only across the window','');
   lines.push('Offered: '+r.offered+' \u00b7 skipped because the cap was full: '+r.skippedForCap+' \u00b7 taken: '+r.taken+' \u00b7 '+r.winRate+'% win rate','');
   lines.push('STARTING CAPITAL: $'+r.startingCapital.toLocaleString());
   lines.push('FINAL ACCOUNT VALUE: $'+r.finalAccountValue.toLocaleString()+'  ('+(r.totalReturnPct>=0?'+':'')+r.totalReturnPct+'% total return over the whole window)','');
   lines.push('=== EVERY TRADE, IN ORDER, SHOWING THE ACCOUNT COMPOUNDING ===','');
   r.trades.forEach(function(t,ix){
    lines.push((ix+1)+'. '+t.ticker+' \u2014 picked '+t.pickDate+' on '+t.evidenceKey+' ('+t.tier+', score '+t.score+')');
    lines.push('  account value at entry: $'+t.accountValueAtEntry.toLocaleString()+'  \u2192  position size: $'+t.positionSize.toLocaleString()+' ('+t.openAtFill+' others open at the time)');
    lines.push('  filled '+t.fillDate+' @ $'+t.fillPrice+'  \u2192  exit '+t.exitDate+' @ $'+t.exitPrice+' ('+t.exitWhy+')  \u00b7  '+(t.plPct>=0?'+':'')+t.plPct+'%  \u00b7  '+(t.dollarPL>=0?'+':'')+'$'+t.dollarPL.toLocaleString()+' to the account');
    lines.push('');
   });
   if(r.skipped.length){
    lines.push('=== SKIPPED — CAP WAS FULL AT THE MOMENT THESE WOULD HAVE FILLED ===','');
    r.skipped.forEach(function(s){ lines.push('  '+s.ticker+' \u2014 picked '+s.pickDate+', would have filled '+s.level.fillDate+' ('+s.openAtFill+'/'+P.maxPositions+' already open)'); });
   }
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderCompoundingScore5').onclick=function(){
  var b=this; b.disabled=true; say('Running the same 15%/15% compounding test as the -5% dip version, but lowering the evidence bar to score 5+ instead of 7+ \u2014 letting more, lower-conviction candidates in. Same $50,000 start, same 8-position cap, same -5% dip buy level. Leave this page open.');
  call('/admin/dip-ladder-compounding?minScore=5',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){
    var msg='No result came back.';
    if(j&&j.error){ msg+=' ('+j.error+')'; if(j.historyFrom){ msg+=' Stored history only goes back to '+j.historyFrom+', which is not enough for the requested window.'; } }
    say(msg,true); return;
   }
   var r=j.result, P=r.params, lines=[];
   lines.push('=== 15%/15% COMPOUNDING FROM $50,000, SCORE '+P.minScore+'+ \u2014 '+j.exch+' ===','');
   lines.push('History available from: '+j.historyFrom+' \u00b7 Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate);
   lines.push('Max '+P.maxPositions+' positions at once, each sized as (current account value) / '+P.maxPositions+' at the moment it fills \u00b7 target +'+P.targetPct+'% / stop \u2212'+P.stopPct+'% \u00b7 buy level: '+P.buyLevel+'% dip \u00b7 top 4 by evidence, score '+P.minScore+'+ (was 7+) \u00b7 ETFs/hybrids/bonds '+(r.excludeNonEquity?'EXCLUDED':'included')+' \u00b7 once-only across the window','');
   lines.push('Offered: '+r.offered+' \u00b7 skipped because the cap was full: '+r.skippedForCap+' \u00b7 taken: '+r.taken+' \u00b7 '+r.winRate+'% win rate','');
   lines.push('STARTING CAPITAL: $'+r.startingCapital.toLocaleString());
   lines.push('FINAL ACCOUNT VALUE: $'+r.finalAccountValue.toLocaleString()+'  ('+(r.totalReturnPct>=0?'+':'')+r.totalReturnPct+'% total return over the whole window)','');
   lines.push('=== EVERY TRADE, IN ORDER, SHOWING THE ACCOUNT COMPOUNDING ===','');
   r.trades.forEach(function(t,ix){
    lines.push((ix+1)+'. '+t.ticker+' \u2014 picked '+t.pickDate+' on '+t.evidenceKey+' ('+t.tier+', score '+t.score+')');
    lines.push('  account value at entry: $'+t.accountValueAtEntry.toLocaleString()+'  \u2192  position size: $'+t.positionSize.toLocaleString()+' ('+t.openAtFill+' others open at the time)');
    lines.push('  filled '+t.fillDate+' @ $'+t.fillPrice+'  \u2192  exit '+t.exitDate+' @ $'+t.exitPrice+' ('+t.exitWhy+')  \u00b7  '+(t.plPct>=0?'+':'')+t.plPct+'%  \u00b7  '+(t.dollarPL>=0?'+':'')+'$'+t.dollarPL.toLocaleString()+' to the account');
    lines.push('');
   });
   if(r.skipped.length){
    lines.push('=== SKIPPED — CAP WAS FULL AT THE MOMENT THESE WOULD HAVE FILLED ===','');
    r.skipped.forEach(function(s){ lines.push('  '+s.ticker+' \u2014 picked '+s.pickDate+', would have filled '+s.level.fillDate+' ('+s.openAtFill+'/'+P.maxPositions+' already open)'); });
   }
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderCompoundingScore4').onclick=function(){
  var b=this; b.disabled=true; say('Same 15%/15% compounding test again, now at score 4+ \u2014 since score 5+ made no difference at all versus 7+, this checks whether the floor is lower still, or whether 4 is where weaker evidence finally starts changing the picture. Same $50,000 start, same 8-position cap, same -5% dip. Leave this page open.');
  call('/admin/dip-ladder-compounding?minScore=4',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){
    var msg='No result came back.';
    if(j&&j.error){ msg+=' ('+j.error+')'; if(j.historyFrom){ msg+=' Stored history only goes back to '+j.historyFrom+', which is not enough for the requested window.'; } }
    say(msg,true); return;
   }
   var r=j.result, P=r.params, lines=[];
   lines.push('=== 15%/15% COMPOUNDING FROM $50,000, SCORE '+P.minScore+'+ \u2014 '+j.exch+' ===','');
   lines.push('History available from: '+j.historyFrom+' \u00b7 Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate);
   lines.push('Max '+P.maxPositions+' positions at once, each sized as (current account value) / '+P.maxPositions+' at the moment it fills \u00b7 target +'+P.targetPct+'% / stop \u2212'+P.stopPct+'% \u00b7 buy level: '+P.buyLevel+'% dip \u00b7 top 4 by evidence, score '+P.minScore+'+ (7+ and 5+ were identical) \u00b7 ETFs/hybrids/bonds '+(r.excludeNonEquity?'EXCLUDED':'included')+' \u00b7 once-only across the window','');
   lines.push('Offered: '+r.offered+' \u00b7 skipped because the cap was full: '+r.skippedForCap+' \u00b7 taken: '+r.taken+' \u00b7 '+r.winRate+'% win rate','');
   lines.push('STARTING CAPITAL: $'+r.startingCapital.toLocaleString());
   lines.push('FINAL ACCOUNT VALUE: $'+r.finalAccountValue.toLocaleString()+'  ('+(r.totalReturnPct>=0?'+':'')+r.totalReturnPct+'% total return over the whole window)','');
   lines.push('=== EVERY TRADE, IN ORDER, SHOWING THE ACCOUNT COMPOUNDING ===','');
   r.trades.forEach(function(t,ix){
    lines.push((ix+1)+'. '+t.ticker+' \u2014 picked '+t.pickDate+' on '+t.evidenceKey+' ('+t.tier+', score '+t.score+')');
    lines.push('  account value at entry: $'+t.accountValueAtEntry.toLocaleString()+'  \u2192  position size: $'+t.positionSize.toLocaleString()+' ('+t.openAtFill+' others open at the time)');
    lines.push('  filled '+t.fillDate+' @ $'+t.fillPrice+'  \u2192  exit '+t.exitDate+' @ $'+t.exitPrice+' ('+t.exitWhy+')  \u00b7  '+(t.plPct>=0?'+':'')+t.plPct+'%  \u00b7  '+(t.dollarPL>=0?'+':'')+'$'+t.dollarPL.toLocaleString()+' to the account');
    lines.push('');
   });
   if(r.skipped.length){
    lines.push('=== SKIPPED — CAP WAS FULL AT THE MOMENT THESE WOULD HAVE FILLED ===','');
    r.skipped.forEach(function(s){ lines.push('  '+s.ticker+' \u2014 picked '+s.pickDate+', would have filled '+s.level.fillDate+' ('+s.openAtFill+'/'+P.maxPositions+' already open)'); });
   }
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderCompoundingWatchScore').onclick=function(){
  var b=this; b.disabled=true; say('Running the identical 15%/15% compounding test \u2014 same window, same -5% dip, same 8-position cap \u2014 but filtering and ranking candidates by their own WATCH SCORE (accumulation + price streak + volume streak + today\\'s move) instead of the signal report card score used in every other test tonight. This first checks a ticker still fired SOME evidence key, same as always \u2014 only the scoring method changes. Leave this page open.');
  call('/admin/dip-ladder-compounding-watchscore',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){
    var msg='No result came back.';
    if(j&&j.error){ msg+=' ('+j.error+')'; if(j.historyFrom){ msg+=' Stored history only goes back to '+j.historyFrom+', which is not enough for the requested window.'; } }
    say(msg,true); return;
   }
   var r=j.result, P=r.params, lines=[];
   lines.push('=== 15%/15% COMPOUNDING FROM $50,000, FILTERED BY WATCH SCORE '+P.minScore+'+ \u2014 '+j.exch+' ===','');
   lines.push('History available from: '+j.historyFrom+' \u00b7 Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate);
   lines.push('Max '+P.maxPositions+' positions at once \u00b7 target +'+P.targetPct+'% / stop \u2212'+P.stopPct+'% \u00b7 buy level: '+P.buyLevel+'% dip \u00b7 top 4 by WATCH SCORE (not report-card score), Watch Score '+P.minScore+'+ \u00b7 ETFs/hybrids/bonds '+(r.excludeNonEquity?'EXCLUDED':'included')+' \u00b7 once-only across the window','');
   lines.push('Offered: '+r.offered+' \u00b7 skipped because the cap was full: '+r.skippedForCap+' \u00b7 taken: '+r.taken+' \u00b7 '+r.winRate+'% win rate','');
   lines.push('STARTING CAPITAL: $'+r.startingCapital.toLocaleString());
   lines.push('FINAL ACCOUNT VALUE: $'+r.finalAccountValue.toLocaleString()+'  ('+(r.totalReturnPct>=0?'+':'')+r.totalReturnPct+'% total return over the whole window)','');
   lines.push('Compare this figure directly against the report-card-score version of this same test (the buttons above) \u2014 same window, same rules, only the scoring method differs.','');
   lines.push('=== EVERY TRADE, IN ORDER, SHOWING THE ACCOUNT COMPOUNDING ===','');
   r.trades.forEach(function(t,ix){
    lines.push((ix+1)+'. '+t.ticker+' \u2014 picked '+t.pickDate+' (Watch Score '+t.score+')');
    lines.push('  account value at entry: $'+t.accountValueAtEntry.toLocaleString()+'  \u2192  position size: $'+t.positionSize.toLocaleString()+' ('+t.openAtFill+' others open at the time)');
    lines.push('  filled '+t.fillDate+' @ $'+t.fillPrice+'  \u2192  exit '+t.exitDate+' @ $'+t.exitPrice+' ('+t.exitWhy+')  \u00b7  '+(t.plPct>=0?'+':'')+t.plPct+'%  \u00b7  '+(t.dollarPL>=0?'+':'')+'$'+t.dollarPL.toLocaleString()+' to the account');
    lines.push('');
   });
   if(r.skipped.length){
    lines.push('=== SKIPPED — CAP WAS FULL AT THE MOMENT THESE WOULD HAVE FILLED ===','');
    r.skipped.forEach(function(s){ lines.push('  '+s.ticker+' \u2014 picked '+s.pickDate+', would have filled '+s.level.fillDate+' ('+s.openAtFill+'/'+P.maxPositions+' already open)'); });
   }
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderCompounding10yr').onclick=function(){
  var b=this; b.disabled=true; say('Running the same 15%/15% compounding test over the full 10 years your EODData plan covers, once the pantry has actually been backfilled that deep. If you have not finished backfilling yet (Fill until full, run across a few sessions), this will honestly say how far back the stored history currently reaches instead of silently using a shorter window. Leave this page open.');
  call('/admin/dip-ladder-compounding?totalWeeks=520',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){
    var msg='No result came back.';
    if(j&&j.error){ msg+=' ('+j.error+')'; if(j.historyFrom){ msg+=' Stored history only goes back to '+j.historyFrom+', which is not enough for the requested window yet \u2014 keep running Fill until full and try again later.'; } }
    say(msg,true); return;
   }
   var r=j.result, P=r.params, lines=[];
   lines.push('=== 15%/15% COMPOUNDING FROM $50,000, ~10 YEARS \u2014 '+j.exch+' ===','');
   lines.push('History available from: '+j.historyFrom+' \u00b7 Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate);
   lines.push('Max '+P.maxPositions+' positions at once, each sized as (current account value) / '+P.maxPositions+' at the moment it fills \u00b7 target +'+P.targetPct+'% / stop \u2212'+P.stopPct+'% \u00b7 buy level: '+P.buyLevel+'% dip \u00b7 top 4 by evidence, score '+P.minScore+'+ \u00b7 ETFs/hybrids/bonds '+(r.excludeNonEquity?'EXCLUDED':'included')+' \u00b7 once-only across the window','');
   lines.push('Offered: '+r.offered+' \u00b7 skipped because the cap was full: '+r.skippedForCap+' \u00b7 taken: '+r.taken+' \u00b7 '+r.winRate+'% win rate','');
   lines.push('STARTING CAPITAL: $'+r.startingCapital.toLocaleString());
   lines.push('FINAL ACCOUNT VALUE: $'+r.finalAccountValue.toLocaleString()+'  ('+(r.totalReturnPct>=0?'+':'')+r.totalReturnPct+'% total return over the whole window)','');
   lines.push('=== EVERY TRADE, IN ORDER, SHOWING THE ACCOUNT COMPOUNDING ===','');
   r.trades.forEach(function(t,ix){
    lines.push((ix+1)+'. '+t.ticker+' \u2014 picked '+t.pickDate+' on '+t.evidenceKey+' ('+t.tier+', score '+t.score+')');
    lines.push('  account value at entry: $'+t.accountValueAtEntry.toLocaleString()+'  \u2192  position size: $'+t.positionSize.toLocaleString()+' ('+t.openAtFill+' others open at the time)');
    lines.push('  filled '+t.fillDate+' @ $'+t.fillPrice+'  \u2192  exit '+t.exitDate+' @ $'+t.exitPrice+' ('+t.exitWhy+')  \u00b7  '+(t.plPct>=0?'+':'')+t.plPct+'%  \u00b7  '+(t.dollarPL>=0?'+':'')+'$'+t.dollarPL.toLocaleString()+' to the account');
    lines.push('');
   });
   if(r.skipped.length){
    lines.push('=== SKIPPED — CAP WAS FULL AT THE MOMENT THESE WOULD HAVE FILLED ===','');
    r.skipped.forEach(function(s){ lines.push('  '+s.ticker+' \u2014 picked '+s.pickDate+', would have filled '+s.level.fillDate+' ('+s.openAtFill+'/'+P.maxPositions+' already open)'); });
   }
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderCompoundingPriceBands').onclick=function(){
  var b=this; b.disabled=true; say('Running the SAME agreed 15/15 rule, same -5% dip, same everything, as FIVE INDEPENDENT $50,000 compounding tests \u2014 one per share-price tier (\u2264$0.20, $0.20-$0.99, $1-$1.99, $2-$5, >$5), over the same ~2.7-year window. Each band only ever sees candidates that were actually in that price range on their pick day, so this is a fair \u2018if this were your whole strategy, restricted to just this price tier\u2019 test, not a slice of one shared run. Leave this page open.');
  call('/admin/dip-ladder-compounding-pricebands',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){
    var msg='No result came back.';
    if(j&&j.error){ msg+=' ('+j.error+')'; if(j.historyFrom){ msg+=' Stored history only goes back to '+j.historyFrom+', which is not enough for the requested window.'; } }
    say(msg,true); return;
   }
   var r=j.result, P=r.params, lines=[];
   lines.push('=== 15%/15% COMPOUNDING FROM $50,000, BY SHARE-PRICE BAND \u2014 '+j.exch+' ===','');
   lines.push('History available from: '+j.historyFrom+' \u00b7 Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate);
   lines.push('Each band: its OWN $50,000, max '+P.maxPositions+' positions at once \u00b7 target +'+P.targetPct+'% / stop \u2212'+P.stopPct+'% \u00b7 buy level: '+P.buyLevel+'% dip \u00b7 top 4 by evidence, score '+P.minScore+'+, WITHIN that band only \u00b7 ETFs/hybrids/bonds '+(r.excludeNonEquity?'EXCLUDED':'included')+' \u00b7 once-only across the window, per band','');
   lines.push('=== SUMMARY \u2014 ALL FIVE BANDS SIDE BY SIDE ===','');
   r.bands.forEach(function(bd){
    lines.push(bd.band+':  offered '+bd.offered+' \u00b7 skipped (cap full) '+bd.skippedForCap+' \u00b7 taken '+bd.taken+' \u00b7 '+bd.winRate+'% win rate  \u2192  $'+bd.startingCapital.toLocaleString()+' \u2192 $'+bd.finalAccountValue.toLocaleString()+'  ('+(bd.totalReturnPct>=0?'+':'')+bd.totalReturnPct+'%)');
   });
   lines.push('');
   r.bands.forEach(function(bd){ _corpLines(bd, bd.band).forEach(function(x){ lines.push(x); }); });
   r.bands.forEach(function(bd){
    lines.push('=== '+bd.band+' \u2014 EVERY TRADE, IN ORDER ===','');
    if(!bd.trades.length){ lines.push('  (no trades \u2014 either no candidates ever qualified in this band, or none filled)',''); return; }
    bd.trades.forEach(function(t,ix){
     lines.push((ix+1)+'. '+t.ticker+' \u2014 picked '+t.pickDate+' on '+t.evidenceKey+' ('+t.tier+', score '+t.score+') \u00b7 ref close $'+t.refClose);
     lines.push('  account value at entry: $'+t.accountValueAtEntry.toLocaleString()+'  \u2192  position size: $'+t.positionSize.toLocaleString()+' ('+t.openAtFill+' others open at the time)');
     lines.push('  filled '+t.fillDate+' @ $'+t.fillPrice+'  \u2192  exit '+t.exitDate+' @ $'+t.exitPrice+' ('+t.exitWhy+')  \u00b7  '+(t.plPct>=0?'+':'')+t.plPct+'%  \u00b7  '+(t.dollarPL>=0?'+':'')+'$'+t.dollarPL.toLocaleString()+' to the account');
     lines.push('');
    });
    if(bd.skipped.length){
     lines.push('  SKIPPED \u2014 cap was full at the moment these would have filled:');
     bd.skipped.forEach(function(s){ lines.push('    '+s.ticker+' \u2014 picked '+s.pickDate+', would have filled '+s.level.fillDate+' ('+s.openAtFill+'/'+P.maxPositions+' already open)'); });
     lines.push('');
    }
   });
   say(lines.join('\\n'));
  });
 };
 // Shared by the two custom-range buttons below (10/10 and 20/15) since they
 // call the exact same route and build the exact same display, differing
 // only in the target/stop query string and the button that triggered them.
 // w470 - the data-integrity block. Printed for EVERY band on EVERY run, even
 // when it is empty: an absent section reads as "not checked", and this project
 // has already been bitten once by exactly that ambiguity (the w465 diagnostic
 // that showed a real-but-empty response identically to no response at all).
 function _corpLines(bd,label){
  var L=[], ex=bd.excludedCorpActions||[], fl=bd.flaggedLargeMoves||[], ho=bd.heldOutLargeMoves||[];
  L.push('  DATA INTEGRITY \u2014 '+label+':');
  if(!ex.length){ L.push('    No suspected corporate actions in this window.'); }
  else{
   L.push('    '+ex.length+' trade'+(ex.length===1?'':'s')+' EXCLUDED as suspected corporate actions  ('+(bd.offeredBeforeCorpFilter||0)+' offered \u2192 '+bd.offered+' after the filter)');
   ex.forEach(function(e){
    var ev=e.event||{};
    L.push('      '+e.ticker+'  event '+ev.d+'  close ratio '+ev.ratio+'  \u2192 '+ev.factor+'-for-1 '+ev.kind+'  ('+ev.confidence+(ev.volRatio!=null?(', volume \u00d7'+ev.volRatio):', no volume on file')+')');
    L.push('        would have booked: filled '+e.fillDate+' @ $'+e.fillPrice+' \u2192 '+e.exitDate+' @ $'+e.exitPrice+' ('+e.exitWhy+')  '+(e.wouldHavePlPct>=0?'+':'')+e.wouldHavePlPct+'%');
    L.push('        picked '+e.pickDate+', so the guard window ran '+(e.guardFrom||'?')+' \u2192 '+e.exitDate+' \u2014 the event above falls inside it'+(ev.byMagnitude?'  [flagged on size alone, factor is the nearest estimate]':''));
   });
   L.push('    An excluded trade never enters the account, so its position slot is freed and the');
   L.push('    remaining trades are NOT identical to an unfiltered run. That is correct, not drift.');
  }
  if(ho.length){
   L.push('    HELD OUT \u2014 more than 50 points past the target/stop. Counted in the headline above,');
   L.push('    with a second figure below, because no single trade should be the whole result:');
   ho.forEach(function(t){ L.push('      '+t.ticker+'  '+(t.plPct>=0?'+':'')+t.plPct+'%  ('+t.overshoot+' pts past the '+t.exitWhy+')  '+(t.dollarPL>=0?'+':'')+'$'+t.dollarPL.toLocaleString()); });
   if(bd.exHeldOut) L.push('      same run without them: $'+bd.exHeldOut.finalAccountValue.toLocaleString()+'  ('+(bd.exHeldOut.totalReturnPct>=0?'+':'')+bd.exHeldOut.totalReturnPct+'%)  \u00b7  '+bd.exHeldOut.taken+' trades  \u00b7  '+bd.exHeldOut.winRate+'% win rate');
  }
  if(fl.length){
   L.push('    FLAGGED but still counted \u2014 ordinary gap-throughs, listed so they can be eyeballed:');
   fl.forEach(function(t){ L.push('      '+t.ticker+'  '+(t.plPct>=0?'+':'')+t.plPct+'%  ('+t.overshoot+' pts past the '+t.exitWhy+')'); });
  }
  L.push('');
  return L;
 }
 function _runCustomPriceBandTest(btn, targetPct, stopPct, topN, labelSuffix){
  btn.disabled=true;
  say('Running '+targetPct+'%/'+stopPct+'% target/stop, top-'+topN+'/day instead of the usual top-4, same -5% dip and score 7+ otherwise, as two INDEPENDENT $50,000 tests over $0.20\u2013$1.50 and $0.20\u2013$0.99. These two ranges OVERLAP on purpose (this isn\\'t a 5-way partition) \u2014 note the wider range has MORE eligible shares but they compete for the same '+topN+' daily slots, so a wider range can mean more competition, not simply more opportunity. Leave this page open.');
  call('/admin/dip-ladder-compounding-pricebands-custom?targetPct='+targetPct+'&stopPct='+stopPct+'&topN='+topN,function(j){
   btn.disabled=false;
   if(!j||!j.ok||!j.result){
    var msg='No result came back.';
    if(j&&j.error){ msg+=' ('+j.error+')'; if(j.historyFrom){ msg+=' Stored history only goes back to '+j.historyFrom+', which is not enough for the requested window.'; } }
    say(msg,true); return;
   }
   var r=j.result, P=r.params, lines=[];
   lines.push('=== '+targetPct+'%/'+stopPct+'% COMPOUNDING FROM $50,000'+labelSuffix+' \u2014 '+j.exch+' ===','');
   lines.push('History available from: '+j.historyFrom+' \u00b7 Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate);
   lines.push('Each band: its OWN $50,000, max '+P.maxPositions+' positions at once \u00b7 target +'+P.targetPct+'% / stop \u2212'+P.stopPct+'% \u00b7 buy level: '+P.buyLevel+'% dip \u00b7 top '+P.topN+' by evidence, score '+P.minScore+'+, WITHIN that range only \u00b7 ETFs/hybrids/bonds '+(r.excludeNonEquity?'EXCLUDED':'included')+' \u00b7 once-only across the window, per range','');
   lines.push('=== SUMMARY \u2014 BOTH RANGES SIDE BY SIDE ===','');
   r.bands.forEach(function(bd){
    lines.push(bd.band+':  offered '+bd.offered+' \u00b7 skipped (cap full) '+bd.skippedForCap+' \u00b7 taken '+bd.taken+' \u00b7 '+bd.winRate+'% win rate  \u2192  $'+bd.startingCapital.toLocaleString()+' \u2192 $'+bd.finalAccountValue.toLocaleString()+'  ('+(bd.totalReturnPct>=0?'+':'')+bd.totalReturnPct+'%)');
   });
   lines.push('');
   r.bands.forEach(function(bd){ _corpLines(bd, bd.band).forEach(function(x){ lines.push(x); }); });
   r.bands.forEach(function(bd){
    lines.push('=== '+bd.band+' \u2014 EVERY TRADE, IN ORDER ===','');
    if(!bd.trades.length){ lines.push('  (no trades \u2014 either no candidates ever qualified in this range, or none filled)',''); return; }
    bd.trades.forEach(function(t,ix){
     lines.push((ix+1)+'. '+t.ticker+' \u2014 picked '+t.pickDate+' on '+t.evidenceKey+' ('+t.tier+', score '+t.score+') \u00b7 ref close $'+t.refClose);
     lines.push('  account value at entry: $'+t.accountValueAtEntry.toLocaleString()+'  \u2192  position size: $'+t.positionSize.toLocaleString()+' ('+t.openAtFill+' others open at the time)');
     lines.push('  filled '+t.fillDate+' @ $'+t.fillPrice+'  \u2192  exit '+t.exitDate+' @ $'+t.exitPrice+' ('+t.exitWhy+')  \u00b7  '+(t.plPct>=0?'+':'')+t.plPct+'%  \u00b7  '+(t.dollarPL>=0?'+':'')+'$'+t.dollarPL.toLocaleString()+' to the account');
     lines.push('');
    });
    if(bd.skipped.length){
     lines.push('  SKIPPED \u2014 cap was full at the moment these would have filled:');
     bd.skipped.forEach(function(s){ lines.push('    '+s.ticker+' \u2014 picked '+s.pickDate+', would have filled '+s.level.fillDate+' ('+s.openAtFill+'/'+P.maxPositions+' already open)'); });
     lines.push('');
    }
   });
   say(lines.join('\\n'));
  });
 }
 document.getElementById('dipLadderPB1010').onclick=function(){ _runCustomPriceBandTest(this, 10, 10, 6, ', 10%/10%, top-6/day'); };
 document.getElementById('dipLadderPB2015').onclick=function(){ _runCustomPriceBandTest(this, 20, 15, 6, ', 20%/15%, top-6/day'); };
 document.getElementById('dipLadderPB2015Top4').onclick=function(){ _runCustomPriceBandTest(this, 20, 15, 4, ', 20%/15%, top-4/day \u2014 isolates target/stop vs the established 15/15 baseline, since top-N is unchanged here'); };
 document.getElementById('dipLadderCompounding2015').onclick=function(){
  var b=this; b.disabled=true; say('Running the ORIGINAL unrestricted 15/15-style compounding test \u2014 same $50,000 start, same 8-position cap, same -5% dip, same top 4 by evidence, score 7+, NO price filter \u2014 but with target/stop set to 20%/15% instead of 15%/15%, to compare directly against the established 15/15 baseline (+44.38%, $72,191.69) on the exact same rules otherwise. Leave this page open.');
  call('/admin/dip-ladder-compounding?targetPct=20&stopPct=15',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){
    var msg='No result came back.';
    if(j&&j.error){ msg+=' ('+j.error+')'; if(j.historyFrom){ msg+=' Stored history only goes back to '+j.historyFrom+', which is not enough for the requested window.'; } }
    say(msg,true); return;
   }
   var r=j.result, P=r.params, lines=[];
   lines.push('=== 20%/15% COMPOUNDING FROM $50,000 (UNRESTRICTED, vs the 15/15 baseline) \u2014 '+j.exch+' ===','');
   lines.push('History available from: '+j.historyFrom+' \u00b7 Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate);
   lines.push('Max '+P.maxPositions+' positions at once, each sized as (current account value) / '+P.maxPositions+' at the moment it fills \u00b7 target +'+P.targetPct+'% / stop \u2212'+P.stopPct+'% \u00b7 single -5% dip buy level \u00b7 top 4 by evidence, score 7+, ETFs/hybrids/bonds '+(r.excludeNonEquity?'EXCLUDED':'included')+' \u00b7 once-only across the window','');
   lines.push('Offered: '+r.offered+' \u00b7 skipped because the cap was full: '+r.skippedForCap+' \u00b7 taken: '+r.taken+' \u00b7 '+r.winRate+'% win rate','');
   lines.push('STARTING CAPITAL: $'+r.startingCapital.toLocaleString());
   lines.push('FINAL ACCOUNT VALUE: $'+r.finalAccountValue.toLocaleString()+'  ('+(r.totalReturnPct>=0?'+':'')+r.totalReturnPct+'% total return over the whole window)','');
   lines.push('=== EVERY TRADE, IN ORDER, SHOWING THE ACCOUNT COMPOUNDING ===','');
   r.trades.forEach(function(t,ix){
    lines.push((ix+1)+'. '+t.ticker+' \u2014 picked '+t.pickDate+' on '+t.evidenceKey+' ('+t.tier+', score '+t.score+')');
    lines.push('  account value at entry: $'+t.accountValueAtEntry.toLocaleString()+'  \u2192  position size: $'+t.positionSize.toLocaleString()+' ('+t.openAtFill+' others open at the time)');
    lines.push('  filled '+t.fillDate+' @ $'+t.fillPrice+'  \u2192  exit '+t.exitDate+' @ $'+t.exitPrice+' ('+t.exitWhy+')  \u00b7  '+(t.plPct>=0?'+':'')+t.plPct+'%  \u00b7  '+(t.dollarPL>=0?'+':'')+'$'+t.dollarPL.toLocaleString()+' to the account');
    lines.push('');
   });
   if(r.skipped.length){
    lines.push('=== SKIPPED — CAP WAS FULL AT THE MOMENT THESE WOULD HAVE FILLED ===','');
    r.skipped.forEach(function(s){ lines.push('  '+s.ticker+' \u2014 picked '+s.pickDate+', would have filled '+s.level.fillDate+' ('+s.openAtFill+'/'+P.maxPositions+' already open)'); });
   }
   say(lines.join('\\n'));
  });
 };
 // w473 — Tony: "$100k pool, $10k per trade, 10 open trades, compounding, over
 // the maximum 2.7 years of data we have". $100,000 across 10 positions IS
 // $10,000 a trade at the start, and the existing sizing (account value / max
 // positions, recomputed at every fill) makes it compound from there — so the
 // money side needed no new code, only different numbers.
 //
 // The window did need code. gradeDays=1500 lifts the engine's 250-day grading
 // lookback for THIS RUN ONLY, because with the default the simulator prints a
 // 2.7-year window while every pick it can make falls inside the last twelve
 // months. totalWeeks=145 then opens the trading window to the full store.
 // The result page reports the first and last pick it actually made, so a
 // longer window that changed nothing cannot hide.
 document.getElementById('smallMargins').onclick=function(){
  var b=this; b.disabled=true;
  // Small margins, high turnover. The question is NOT "what does a 3% target
  // return" — it is whether the extra cycles outrun the friction each cycle
  // pays. Brokerage is fixed per trade and the spread is charged per trade, so
  // halving the margin roughly doubles the number of times you pay them.
  //
  // Each margin runs with a MATCHED stop (3/3, 4/4, 5/5, 7/7). That keeps the
  // risk-to-reward at 1:1 across all four, so the only thing changing is the
  // size of the margin. Pairing a 3% target with a 15% stop would need eight
  // wins to survive one loss, and would be testing the stop, not the margin.
  var BASE='&exitMode=fixed&buyLevel=-5&entryMode=dip&topN=4&minScore=7&maxPositions=10&totalWeeks=145&gradeDays=1500&startingCapital=50000&feePerSide=3';
  var MARGINS=[3,4,5,7];
  var SLIPS=[0.5,1.0];   // optimistic, and the realistic estimate for this band
  var RUNS=[];
  SLIPS.forEach(function(sp){ MARGINS.forEach(function(m){ RUNS.push({m:m,sp:sp}); }); });
  var got=[];
  say('Running 3%, 4%, 5% and 7% take-profits on $50,000, each with a matched stop, at two slippage levels. Eight runs; leave this page open. The number to watch is not the return \u2014 it is how much of the gross profit the costs take.');
  function step(k){
   if(k>=RUNS.length){ b.disabled=false; render(); return; }
   var q='&targetPct='+RUNS[k].m+'&stopPct='+RUNS[k].m+'&slipPct='+RUNS[k].sp;
   call('/admin/dip-ladder-compounding-pricebands-v2?'+q+BASE,function(j){
    if(!j||!j.ok||!j.result){ b.disabled=false; say('The '+RUNS[k].m+'% @ '+RUNS[k].sp+'% run came back empty.'+(j&&j.error?' ('+j.error+')':''),true); return; }
    got.push({run:RUNS[k],res:j.result});
    say('Done '+(k+1)+' of '+RUNS.length+' \u2014 '+RUNS[k].m+'% margin at '+RUNS[k].sp+'% slippage.');
    step(k+1);
   });
  }
  function money(x){ return '$'+Math.round(x).toLocaleString(); }
  function pc(x){ return (x>=0?'+':'')+x.toFixed(1)+'%'; }
  function pad(t,w){ t=String(t); while(t.length<w)t+=' '; return t; }
  function render(){
   var L=[], R0=got[0].res, yrs=(R0.params.totalWeeks*5)/252;
   var N=null; for(var i=0;i<R0.bands.length;i++) if(/0\.20/.test(R0.bands[i].band)) N=i;
   if(N===null)N=R0.bands.length-1;
   var find=function(m,sp){ for(var i=0;i<got.length;i++) if(got[i].run.m===m&&got[i].run.sp===sp) return got[i].res.bands[N]; return null; };
   L.push('=== SMALL MARGINS, FAST TURNOVER \u2014 $50,000 OVER '+yrs.toFixed(2)+' YEARS ===','');
   L.push('$0.20-$0.99 \u00b7 5% dip entry \u00b7 score 7+ \u00b7 top 4/day \u00b7 10 positions \u00b7 $3 a side');
   L.push('Each margin has a MATCHED stop, so risk and reward are 1:1 in every row.','');
   SLIPS.forEach(function(sp){
     L.push('\u2500\u2500\u2500\u2500\u2500  at '+sp+'% slippage  \u2500\u2500\u2500\u2500\u2500','');
     L.push('  '+pad('margin',9)+pad('finished',13)+pad('return',10)+pad('trades',9)+pad('turned over',13)+pad('win rate',10)+'avg hold');
     MARGINS.forEach(function(m){
       var bd=find(m,sp); if(!bd)return;
       var T=bd.turnover||{};
       L.push('  '+pad(m+'%',9)+pad(money(bd.finalAccountValue),13)+pad(pc(bd.totalReturnPct),10)
         +pad(T.trades||bd.taken,9)+pad((T.timesCapitalTurnedOver||0)+'\u00d7',13)+pad(bd.winRate+'%',10)+((T.avgHeldDays||0)+'d'));
     });
     L.push('');
     L.push('  '+pad('margin',9)+pad('gross profit',15)+pad('paid in costs',15)+pad('costs as % of gross',22)+'trades a year');
     MARGINS.forEach(function(m){
       var bd=find(m,sp); if(!bd)return; var T=bd.turnover||{};
       L.push('  '+pad(m+'%',9)+pad(money(T.grossProfitDollars||0),15)+pad(money(T.costDollars||0),15)
         +pad((T.costShareOfGrossPct==null?'\u2014':(T.costShareOfGrossPct+'%')),22)+(T.tradesPerYear||0));
     });
     L.push('');
   });
   L.push('=== HOW TO READ IT ===','');
   L.push('TURNED OVER is the money actually put to work divided by the $50,000 you started');
   L.push('with. 8\u00d7 means the same capital was recycled eight times over the window. More');
   L.push('turns is only better if each turn clears its own costs.','');
   L.push('COSTS AS % OF GROSS is the number that decides this. Brokerage is a fixed $3 a');
   L.push('side and the spread is charged on every exit, so the bill scales with the NUMBER');
   L.push('of trades while the margin caps what each one can earn. If a 3% margin hands back');
   L.push('half its gross profit in costs, that is not a tuning problem \u2014 the margin is too');
   L.push('thin to carry the friction, and no amount of extra volume fixes it.','');
   L.push('For reference, on the same band and money: the 20% trailing stop returned about');
   L.push('+145% at 1% slippage, on 63 trades and roughly 1.3 turns of the capital. It wins');
   L.push('by making few trades pay a lot, which is the opposite bet to this one.');
   say(L.join('\\n'));
  }
  step(0);
 };
 document.getElementById('marketVsDip').onclick=function(){
  var b=this; b.disabled=true;
  // The pullback test threw up something unexpected: buying at MARKET on the
  // signal day returned more than the patient 5% dip limit. Before that changes
  // anything it has to survive the thing that is stacked against it. A market
  // order crosses the spread on the way IN as well as out; the dip entry rests a
  // limit and pays nothing to enter. On a 20c share one ASX tick is 2.5%, so the
  // slippage assumption is not a detail here, it is the whole question.
  var BASE='&trailPct=20&exitMode=trail&topN=4&minScore=7&maxPositions=10&totalWeeks=145&gradeDays=1500&startingCapital=50000&feePerSide=3';
  var RUNS=[];
  [1,1.5,2].forEach(function(sp){
    RUNS.push({e:'dip',    sp:sp, n:'5% dip limit', q:'&buyLevel=-5&entryMode=dip'});
    RUNS.push({e:'market', sp:sp, n:'market on the day', q:'&buyLevel=0&entryMode=dip'});
  });
  var got=[];
  say('Running both entries at 1%, 1.5% and 2% slippage \u2014 six runs, everything else pinned identical. Note the asymmetry being tested: the dip entry rests a limit and pays no entry spread, the market entry pays it on every fill. Leave this page open.');
  function step(k){
   if(k>=RUNS.length){ b.disabled=false; render(); return; }
   call('/admin/dip-ladder-compounding-pricebands-v2?'+RUNS[k].q+BASE+'&slipPct='+RUNS[k].sp,function(j){
    if(!j||!j.ok||!j.result){ b.disabled=false; say('The '+RUNS[k].n+' @ '+RUNS[k].sp+'% run came back empty.'+(j&&j.error?' ('+j.error+')':''),true); return; }
    got.push({run:RUNS[k],res:j.result});
    say('Done '+(k+1)+' of '+RUNS.length+' \u2014 '+RUNS[k].n+' at '+RUNS[k].sp+'%.');
    step(k+1);
   });
  }
  function money(x){ return '$'+Math.round(x).toLocaleString(); }
  function pc(x){ return (x>=0?'+':'')+x.toFixed(1)+'%'; }
  function pad(t,w){ t=String(t); while(t.length<w)t+=' '; return t; }
  function render(){
   var L=[], R0=got[0].res;
   var N=null; for(var i=0;i<R0.bands.length;i++) if(/0\.20/.test(R0.bands[i].band)) N=i;
   if(N===null)N=R0.bands.length-1;
   var find=function(e,sp){ for(var i=0;i<got.length;i++) if(got[i].run.e===e&&got[i].run.sp===sp) return got[i].res.bands[N]; return null; };
   L.push('=== MARKET ENTRY vs THE 5% DIP LIMIT \u2014 THROUGH RISING SPREAD ===','');
   L.push('$50,000 \u00b7 10 positions \u00b7 20% trailing stop \u00b7 $0.20-$0.99 \u00b7 score 7+ \u00b7 top 4/day \u00b7 $3 a side','');
   L.push('  '+pad('slippage',11)+pad('5% DIP LIMIT',26)+pad('MARKET ON THE DAY',26)+'who leads');
   [1,1.5,2].forEach(function(sp){
    var d=find('dip',sp), m=find('market',sp); if(!d||!m)return;
    L.push('  '+pad(sp+'%',11)+pad(money(d.finalAccountValue)+'  '+pc(d.totalReturnPct),26)+pad(money(m.finalAccountValue)+'  '+pc(m.totalReturnPct),26)+(m.totalReturnPct>d.totalReturnPct?'market':'DIP'));
   });
   L.push('');
   L.push('=== BUT DOES THE LEAD SURVIVE ITS BEST TRADES? ===','');
   L.push('At 1% slippage the market entry led on the headline and FELL BEHIND once its');
   L.push('top three were removed. That is the pattern of a result carried by a few trades,');
   L.push('and it is the same shape as the wide-band trailing result already rejected.','');
   L.push('  '+pad('slippage',11)+pad('entry',20)+pad('headline',12)+pad('without top 3',15)+pad('win rate',10)+'trades');
   [1,1.5,2].forEach(function(sp){
    [['dip','5% dip limit'],['market','market on the day']].forEach(function(e){
      var r=find(e[0],sp); if(!r)return;
      var w3=r.concentration?pc(r.concentration.withoutTop3.totalReturnPct):'\u2014';
      L.push('  '+pad(sp+'%',11)+pad(e[1],20)+pad(pc(r.totalReturnPct),12)+pad(w3,15)+pad(r.winRate+'%',10)+r.taken);
    });
   });
   L.push('');
   L.push('=== THE TEST IT HAS TO PASS ===','');
   L.push('Market entry only replaces the dip if it leads on the headline AND without its');
   L.push('top three AND at 2% slippage \u2014 a bad-liquidity day on a twenty-cent share.');
   L.push('Anything less and it is a higher number resting on a thinner base, which is');
   L.push('exactly what the concentration check exists to catch.');
   say(L.join('\\n'));
  }
  step(0);
 };
 document.getElementById('pullTest').onclick=function(){
  var b=this; b.disabled=true;
  var BASE='&trailPct=20&exitMode=trail&topN=4&minScore=7&maxPositions=10&totalWeeks=145&gradeDays=1500&startingCapital=50000&feePerSide=3&slipPct=1';
  // Four arms. Same signals, same band, same exit, same money \u2014 only the way
  // in changes. The 1% slippage is the realistic central estimate for this band,
  // and it matters MORE here: the pullback buys at market, so it pays the spread
  // on the way in as well as out, while the dip entry rests a limit and pays
  // nothing. Charging both the same rate would flatter the pullback.
  var ARMS=[
    {n:'buy the 5% dip on the day (current)', q:'&buyLevel=-5&entryMode=dip'},
    {n:'buy at market on the signal day',     q:'&buyLevel=0&entryMode=dip'},
    {n:'wait 5 days, buy a 5-10% pullback',   q:'&entryMode=pullback&pullWaitDays=5&pullMinPct=5&pullMaxPct=10'},
    {n:'wait 5 days, buy a 3-15% pullback',   q:'&entryMode=pullback&pullWaitDays=5&pullMinPct=3&pullMaxPct=15'}
  ];
  var got=[];
  say('Testing the pullback entry against buying the dip on the day. Four arms, everything else pinned identical: $50,000, 10 positions, 20% trailing exit, $0.20-$0.99, score 7+, top 4, $3 a side and 1% slippage. Four calls; leave this page open.');
  function step(k){
   if(k>=ARMS.length){ b.disabled=false; render(); return; }
   call('/admin/dip-ladder-compounding-pricebands-v2?'+ARMS[k].q+BASE,function(j){
    if(!j||!j.ok||!j.result){ b.disabled=false; say('The "'+ARMS[k].n+'" arm came back empty.'+(j&&j.error?' ('+j.error+')':''),true); return; }
    got.push({arm:ARMS[k],res:j.result});
    say('Done '+(k+1)+' of '+ARMS.length+' \u2014 '+ARMS[k].n+'.');
    step(k+1);
   });
  }
  function money(x){ return '$'+Math.round(x).toLocaleString(); }
  function pad(t,w){ t=String(t); while(t.length<w)t+=' '; return t; }
  function render(){
   var L=[], R0=got[0].res, yrs=(R0.params.totalWeeks*5)/252;
   var N=null; for(var i=0;i<R0.bands.length;i++) if(/0\.20/.test(R0.bands[i].band)) N=i;
   if(N===null)N=R0.bands.length-1;
   L.push('=== THE WAY IN \u2014 FOUR ENTRIES, ONE EXIT ===','');
   L.push('$50,000 \u00b7 10 positions \u00b7 20% trailing stop \u00b7 $0.20-$0.99 \u00b7 score 7+ \u00b7 top 4/day');
   L.push('After $3 a side and 1% slippage \u00b7 '+yrs.toFixed(2)+' years','');
   L.push('  '+pad('entry',40)+pad('finished',14)+pad('return',11)+pad('trades',8)+pad('win rate',10)+'without top 3');
   got.forEach(function(g){
    var bd=g.res.bands[N]; if(!bd)return;
    var w3=bd.concentration?((bd.concentration.withoutTop3.totalReturnPct>=0?'+':'')+bd.concentration.withoutTop3.totalReturnPct.toFixed(1)+'%'):'\u2014';
    L.push('  '+pad(g.arm.n,40)+pad(money(bd.finalAccountValue),14)+pad((bd.totalReturnPct>=0?'+':'')+bd.totalReturnPct.toFixed(1)+'%',11)+pad(bd.taken,8)+pad(bd.winRate+'%',10)+w3);
   });
   L.push('');
   L.push('=== HOW OFTEN THE PULLBACK EVEN FIRES ===','');
   L.push('A better average on far fewer trades can still compound to less. This is');
   L.push('the half of the question the return alone does not answer.','');
   got.forEach(function(g){
    var bd=g.res.bands[N]; if(!bd||!bd.pullback)return;
    var p=bd.pullback;
    L.push('  '+g.arm.n+':');
    L.push('     signals seen ............. '+p.signalsSeen);
    L.push('     pulled back into range ... '+p.filled+'   ('+p.triggerRatePct+'% of them)');
    L.push('     skipped, barely fell ..... '+p.skippedNotFallenEnough);
    L.push('     skipped, fell too far .... '+p.skippedFellTooFar,'');
   });
   L.push('=== HOW TO READ IT ===','');
   L.push('The pullback wins only if it beats the dip entry on the RETURN and holds up');
   L.push('without its top three. If it wins on return but fires on a small share of');
   L.push('signals, it is a thinner strategy that happened to catch a good run \u2014 not');
   L.push('a better rule. And if it loses, that is the useful answer: a share that falls');
   L.push('5-10% in the week after its signal is more likely telling you the signal');
   L.push('failed than offering you a discount.');
   say(L.join('\\n'));
  }
  step(0);
 };
 document.getElementById('slipStress').onclick=function(){
  var b=this; b.disabled=true;
  var FEE=3, SLIPS=[0.5,1.0,1.5,2.0];
  // Why this test exists: the chosen band is $0.20-$0.99, and the ASX tick
  // there is half a cent. Half a cent is 0.5% of a dollar share but 2.5% of a
  // twenty-cent one — and a trailing stop becomes a MARKET order the moment it
  // triggers, so it crosses the spread on every single exit. 0.5% was a
  // guess. This finds the slippage at which the edge dies.
  var CFG='&exitMode=trail&trailPct=20&buyLevel=-5&topN=4&minScore=7&maxPositions=10&totalWeeks=145&gradeDays=1500&startingCapital=50000&feePerSide='+FEE;
  var got=[];
  say('Stress-testing the chosen setup against rising slippage: 0.5%, 1%, 1.5%, 2%. The band is $0.20-$0.99 where one ASX tick is half a cent \u2014 which is 2.5% of a twenty-cent share \u2014 and a trailing stop pays the spread on every exit. Four calls; leave this page open.');
  function step(k){
   if(k>=SLIPS.length){ b.disabled=false; render(); return; }
   call('/admin/dip-ladder-compounding-pricebands-v2?slipPct='+SLIPS[k]+CFG,function(j){
    if(!j||!j.ok||!j.result){ b.disabled=false; say('The '+SLIPS[k]+'% run came back empty.'+(j&&j.error?' ('+j.error+')':''),true); return; }
    got.push({slip:SLIPS[k],res:j.result,exch:j.exch});
    say('Done '+(k+1)+' of 4 \u2014 '+SLIPS[k]+'% slippage. Continuing.');
    step(k+1);
   });
  }
  function money(x){ return '$'+Math.round(x).toLocaleString(); }
  function pc(x){ return (x>=0?'+':'')+x.toFixed(2)+'%'; }
  function pad(t,w){ t=String(t); while(t.length<w)t+=' '; return t; }
  function render(){
   var L=[], R0=got[0].res, yrs=(R0.params.totalWeeks*5)/252;
   var ann=function(p){ return (Math.pow(1+p/100,1/yrs)-1)*100; };
   var N=null; for(var i=0;i<R0.bands.length;i++) if(/0\.20/.test(R0.bands[i].band)) N=i;
   if(N===null)N=R0.bands.length-1;
   L.push('=== STRESS TEST \u2014 HOW MUCH SLIPPAGE KILLS IT \u2014 '+got[0].exch+' ===','');
   L.push('The chosen setup on $50,000: 20% trail, no take-profit, $0.20-$0.99, 5% dip, top 4, score 7+, 10 positions');
   L.push('$'+FEE+' brokerage each way throughout \u00b7 only the slippage changes','');
   L.push('  '+pad('slippage',12)+pad('finished with',17)+pad('margin',13)+pad('a year',10)+pad('win rate',10)+'vs your 20/15 (+52%)');
   got.forEach(function(g){
    var bd=g.res.bands[N]; if(!bd)return;
    var verdict = bd.totalReturnPct>52 ? 'still ahead' : (bd.totalReturnPct>27 ? 'beats random only' : 'GONE');
    L.push('  '+pad(g.slip+'%',12)+pad(money(bd.finalAccountValue),17)+pad(pc(bd.totalReturnPct),13)+pad(ann(bd.totalReturnPct).toFixed(1)+'%',10)+pad(bd.winRate+'%',10)+verdict);
   });
   L.push('');
   L.push('  Reference points: your current 20/15 rule on the same band made about +52%.');
   L.push('  Random entries with the same trade count made about +27%. Below that line the');
   L.push('  evidence is doing nothing a coin could not.','');
   L.push('=== WHAT EACH LEVEL MEANS IN REAL MONEY ===','');
   L.push('  On a $0.50 share, one ASX tick (half a cent) is 1.0%. On a $0.20 share it is 2.5%.');
   L.push('  Crossing the spread costs at least half a tick, often a full one on thin shares.');
   L.push('  So for this band, 1% is a fair central estimate and 2% is a bad-liquidity day.','');
   L.push('=== THE RIDE, NOT THE DESTINATION ===','');
   L.push('A return tells you where you ended up. The drawdown tells you what you had to sit');
   L.push('through \u2014 and sitting through it is the part people fail.','');
   got.forEach(function(g){
    var bd=g.res.bands[N]; if(!bd||!bd.drawdown)return;
    var d=bd.drawdown;
    L.push('  at '+g.slip+'% slippage:');
    L.push('     worst fall from a high .... '+pc(-d.maxDrawdownPct)+'   ('+money(d.fromValue)+' \u2192 '+money(d.toValue)+', a fall of '+money(d.dollarFall)+')');
    if(d.fromDate&&d.toDate) L.push('     when ...................... '+d.fromDate+' \u2192 '+d.toDate);
    L.push('     longest run below a high .. '+d.longestLosingRunTrades+' trades in a row');
    L.push('     worst single trade ........ '+(d.worstTradePct!=null?pc(d.worstTradePct):'n/a'),'');
   });
   L.push('  Measured on the settled equity curve \u2014 the account after each exit banks. Open');
   L.push('  positions are not marked to market here, so the real day-to-day swing was WIDER');
   L.push('  than these numbers. Treat them as a floor on the pain, not the whole of it.','');
   L.push('=== HOW TO CALL IT ===','');
   L.push('If the setup still clears +52% at 1% slippage, it survives a realistic spread on');
   L.push('this band and the decision stands. If it only clears at 0.5%, the edge was living');
   L.push('inside an assumption I made up rather than inside the market.');
   say(L.join('\\n'));
  }
  step(0);
 };
 document.getElementById('run50k').onclick=function(){
  var b=this; b.disabled=true;
  var FEE=3, SLIP=0.5;
  // The chosen setup, at two account sizes. Everything else is pinned, so the
  // ONLY difference between the two runs is the starting capital — which means
  // any gap in the MARGIN is the fixed $3 brokerage biting harder on smaller
  // parcels, and nothing else. Worth seeing rather than assuming.
  var CFG='&exitMode=trail&trailPct=20&buyLevel=-5&topN=4&minScore=7&maxPositions=10&totalWeeks=145&gradeDays=1500&feePerSide='+FEE+'&slipPct='+SLIP;
  var RUNS=[{cap:50000,n:'$50,000'},{cap:100000,n:'$100,000'}];
  var got=[];
  say('Running the chosen setup on $50,000 \u2014 20% trailing stop, no take-profit, $0.20-$0.99 band, 5% dip entry, top 4 a day, score 7+, 10 positions, after $'+FEE+' brokerage each way and '+SLIP+'% slippage. Also running it on $100,000 so the only difference between the two is the account size. Leave this page open.');
  function step(k){
   if(k>=RUNS.length){ b.disabled=false; render(); return; }
   call('/admin/dip-ladder-compounding-pricebands-v2?startingCapital='+RUNS[k].cap+CFG,function(j){
    if(!j||!j.ok||!j.result){ b.disabled=false; say('The '+RUNS[k].n+' run came back empty.'+(j&&j.error?' ('+j.error+')':''),true); return; }
    got.push({run:RUNS[k],res:j.result,exch:j.exch});
    say('Done '+(k+1)+' of 2 \u2014 '+RUNS[k].n+'. Continuing.');
    step(k+1);
   });
  }
  function money(x){ return '$'+Math.round(x).toLocaleString(); }
  function pc(x){ return (x>=0?'+':'')+x.toFixed(2)+'%'; }
  function render(){
   var L=[], R0=got[0].res, yrs=(R0.params.totalWeeks*5)/252;
   var ann=function(p){ return (Math.pow(1+p/100,1/yrs)-1)*100; };
   var NARROW=null;
   for(var i=0;i<R0.bands.length;i++) if(/0\.20/.test(R0.bands[i].band)) NARROW=i;
   if(NARROW===null)NARROW=R0.bands.length-1;
   L.push('=== $50,000 RUN \u2014 THE CHOSEN SETUP \u2014 '+got[0].exch+' ===','');
   L.push('20% trailing stop \u00b7 NO take-profit \u00b7 NO fixed stop \u00b7 $0.20-$0.99 \u00b7 5% dip entry \u00b7 top 4/day, score 7+ \u00b7 10 positions, compounding');
   L.push('Window '+R0.windowStartDate+' \u2192 '+R0.windowEndDate+'  ('+yrs.toFixed(2)+' years) \u00b7 picks '+(R0.firstPickDate||'none')+' \u2192 '+(R0.lastPickDate||'none'));
   L.push('After costs: $'+FEE+' brokerage each way, '+SLIP+'% slippage on market-order fills','');
   got.forEach(function(g){
    var bd=g.res.bands[NARROW]; if(!bd)return;
    var profit=bd.finalAccountValue-bd.startingCapital;
    var perTrade=bd.taken?profit/bd.taken:0;
    L.push('\u2014\u2014\u2014\u2014\u2014  STARTING WITH '+g.run.n+'  \u2014\u2014\u2014\u2014\u2014','');
    L.push('   started with .............. '+money(bd.startingCapital));
    L.push('   finished with ............. '+money(bd.finalAccountValue));
    L.push('   PROFIT .................... '+(profit>=0?'+':'-')+money(Math.abs(profit)));
    L.push('   MARGIN .................... '+pc(bd.totalReturnPct)+'   ('+ann(bd.totalReturnPct).toFixed(1)+'% a year)','');
    L.push('   trades taken .............. '+bd.taken+'  \u00b7  win rate '+bd.winRate+'%');
    L.push('   average profit per trade .. '+(perTrade>=0?'+':'-')+money(Math.abs(perTrade)));
    L.push('   first position size ....... '+money(bd.startingCapital/10)+'  (one tenth of the account, growing as it compounds)');
    var ts=bd.trades||[];
    if(ts.length){
     var hold=(ts.reduce(function(a,t){return a+(t.heldDays||0);},0)/ts.length).toFixed(0);
     var gave=(ts.reduce(function(a,t){return a+((t.peakGainPct||0)-t.plPct);},0)/ts.length).toFixed(1);
     var cost=(ts.reduce(function(a,t){return a+(t.costPts||0);},0)/ts.length).toFixed(2);
     L.push('   average hold .............. '+hold+' days  \u00b7  given back from the peak '+gave+' points  \u00b7  costs '+cost+' points');
     var top=ts.slice().sort(function(a,c){return c.plPct-a.plPct;}).slice(0,5)
       .map(function(t){ return t.ticker+' '+pc(t.plPct); });
     L.push('   biggest winners ........... '+top.join(' \u00b7 '));
    }
    var c=bd.concentration;
    if(c){
     L.push('');
     L.push('   WITHOUT its single biggest winner ('+c.biggestWinner.ticker+', '+(c.biggestWinner.shareOfTotalGainPct!=null?c.biggestWinner.shareOfTotalGainPct+'% of the gain':'n/a')+'):');
     L.push('      '+money(c.withoutTop1.finalAccountValue)+'   margin '+pc(c.withoutTop1.totalReturnPct));
     L.push('   WITHOUT its top three winners:');
     L.push('      '+money(c.withoutTop3.finalAccountValue)+'   margin '+pc(c.withoutTop3.totalReturnPct));
    }
    if(bd.excludedCorpActions&&bd.excludedCorpActions.length)
     L.push('   data: '+bd.excludedCorpActions.length+' trade(s) excluded as corporate actions ('+bd.excludedCorpActions.map(function(e){return e.ticker;}).join(', ')+')');
    L.push('');
   });
   if(got.length===2){
    var a=got[0].res.bands[NARROW], c2=got[1].res.bands[NARROW];
    L.push('=== DOES THE ACCOUNT SIZE CHANGE THE MARGIN? ===','');
    L.push('   $50,000 margin ..... '+pc(a.totalReturnPct));
    L.push('   $100,000 margin .... '+pc(c2.totalReturnPct));
    L.push('   difference ......... '+(a.totalReturnPct-c2.totalReturnPct).toFixed(2)+' points','');
    L.push('The strategy itself is size-blind \u2014 every position is one tenth of whatever the');
    L.push('account is worth. The only thing that genuinely changes is the FIXED $'+FEE+' brokerage:');
    L.push('on a $5,000 parcel it is a bigger bite than on a $10,000 one. A gap of a point or');
    L.push('two is that fee drag. A large gap would mean something else is going on.','');
   }
   L.push('=== WHAT TO COMPARE IT AGAINST ===','');
   L.push('   your current 20/15 rule, same band, same money ..... about +52% over the window');
   L.push('   random entries, same trade count and exits ......... about +27%');
   L.push('   buy the whole band and hold ....................... about +152% (survivorship-flattered)','');
   L.push('And the honest health warning: about half these trades LOSE, positions are held');
   L.push('around 50 days, and every winner gives back 20% from its peak on the way out.');
   say(L.join('\\n'));
  }
  step(0);
 };
 document.getElementById('headToHead').onclick=function(){
  var b=this; b.disabled=true;
  var FEE=3, SLIP=0.5;
  // Everything except the EXIT is pinned identical: same $100k, same 10
  // positions, same 5% dip entry, same window, same grading lookback, same
  // costs. Whatever separates these three numbers is the exit rule and nothing
  // else — which is the only way this comparison means anything.
  var BASE='&startingCapital=100000&maxPositions=10&totalWeeks=145&gradeDays=1500&buyLevel=-5&feePerSide='+FEE+'&slipPct='+SLIP;
  var RUNS=[
   {n:'15% target / 15% stop  (the old All-rounder)', q:'&exitMode=fixed&targetPct=15&stopPct=15'},
   {n:'20% target / 15% stop  (current best)',        q:'&exitMode=fixed&targetPct=20&stopPct=15'},
   {n:'20% TRAILING stop, no take-profit',            q:'&exitMode=trail&trailPct=20'}
  ];
  var got=[];
  say('Head to head. Three exit rules, everything else pinned identical: $100,000 across 10 positions, 5% dip entry, full stored history, $'+FEE+' brokerage each way, '+SLIP+'% slippage on market-order fills. Three calls; leave this page open.');
  function step(k){
   if(k>=RUNS.length){ b.disabled=false; render(); return; }
   call('/admin/dip-ladder-compounding-pricebands-v2?1=1'+RUNS[k].q+BASE,function(j){
    if(!j||!j.ok||!j.result){ b.disabled=false; say('Run '+(k+1)+' ('+RUNS[k].n+') came back empty.'+(j&&j.error?' ('+j.error+')':''),true); return; }
    got.push({name:RUNS[k].n,res:j.result,exch:j.exch});
    say('Done '+(k+1)+' of 3 \u2014 '+RUNS[k].n+'. Continuing.');
    step(k+1);
   });
  }
  function pc(x){ return (x>=0?'+':'')+x.toFixed(2)+'%'; }
  function pad(t,w){ t=String(t); while(t.length<w)t+=' '; return t; }
  function render(){
   var L=[], R0=got[0].res, yrs=(R0.params.totalWeeks*5)/252;
   var ann=function(p){ return (Math.pow(1+p/100,1/yrs)-1)*100; };
   L.push('=== THE DECISION \u2014 THREE EXIT RULES, EVERYTHING ELSE IDENTICAL \u2014 '+got[0].exch+' ===','');
   L.push('Window '+R0.windowStartDate+' \u2192 '+R0.windowEndDate+' ('+yrs.toFixed(2)+' years) \u00b7 picks '+(R0.firstPickDate||'none')+' \u2192 '+(R0.lastPickDate||'none'));
   L.push('$100,000 \u00b7 10 positions \u00b7 5% dip entry \u00b7 top 4 by evidence, score 7+ \u00b7 ETFs/hybrids/bonds excluded');
   L.push('AFTER COSTS: $'+FEE+' brokerage each way, '+SLIP+'% slippage on market-order fills only','');
   var bandNames=(R0.bands||[]).map(function(x){return x.band;});
   bandNames.forEach(function(bn,bi){
    L.push('\u2014\u2014\u2014\u2014\u2014 '+bn+' \u2014\u2014\u2014\u2014\u2014','');
    L.push('  '+pad('exit rule',44)+pad('net return',13)+pad('a year',10)+pad('trades',8)+'win rate');
    got.forEach(function(g){
     var bd=g.res.bands[bi]; if(!bd)return;
     L.push('  '+pad(g.name,44)+pad(pc(bd.totalReturnPct),13)+pad(ann(bd.totalReturnPct).toFixed(1)+'%',10)+pad(bd.taken,8)+bd.winRate+'%');
    });
    L.push('');
    L.push('  Does it survive losing its best trades?');
    got.forEach(function(g){
     var bd=g.res.bands[bi]; if(!bd)return;
     var c=bd.concentration;
     if(!c){ L.push('    '+pad(g.name,44)+'(too few trades to check)'); return; }
     L.push('    '+pad(g.name,44)+'without best '+pad(pc(c.withoutTop1.totalReturnPct),12)+'without top 3 '+pc(c.withoutTop3.totalReturnPct));
     L.push('    '+pad('',44)+'biggest: '+c.biggestWinner.ticker+' '+pc(c.biggestWinner.plPct)+' = '+(c.biggestWinner.shareOfTotalGainPct!=null?c.biggestWinner.shareOfTotalGainPct+'% of the gain':'n/a'));
    });
    L.push('');
    L.push('  What each rule cost, and how long it held:');
    got.forEach(function(g){
     var bd=g.res.bands[bi]; if(!bd)return;
     var ts=bd.trades||[];
     var cost=ts.length?(ts.reduce(function(a,t){return a+(t.costPts||0);},0)/ts.length).toFixed(2):'0';
     var hold=ts.length?(ts.reduce(function(a,t){return a+(t.heldDays||0);},0)/ts.length).toFixed(0):'n/a';
     var best=ts.slice().sort(function(a,c){return c.plPct-a.plPct;})[0];
     L.push('    '+pad(g.name,44)+cost+' pts to costs \u00b7 avg hold '+hold+' days \u00b7 best trade '+(best?pc(best.plPct):'n/a'));
    });
    L.push('');
   });
   L.push('=== THE BARS ===','');
   L.push('  random entries, same trade count and exits ..... about +27%   (+8.7% a year)');
   L.push('  buy and hold, wide / narrow ................... +130.8% / +152.1%  (both survivorship-flattered)','');
   L.push('=== HOW TO CALL IT ===','');
   L.push('Do not read the net return on its own. A rule only wins if it BOTH posts the');
   L.push('higher number AND still beats the others once its best trade is removed. If the');
   L.push('winner falls behind on the "without top 3" line, it is one or two trades, and it');
   L.push('will not repeat.');
   say(L.join('\\n'));
  }
  step(0);
 };
 document.getElementById('trailNetSweep').onclick=function(){
  var b=this; b.disabled=true;
  var FEE=3, SLIP=0.5;
  var BASE='&startingCapital=100000&maxPositions=10&totalWeeks=145&gradeDays=1500&exitMode=trail&buyLevel=-5&feePerSide='+FEE+'&slipPct='+SLIP;
  var TR=[15,20,25,30], got=[];
  say('Re-running the trailing sweep with real costs: $'+FEE+' brokerage each way, and '+SLIP+'% slippage wherever the order is a MARKET order. The dip entry is a limit so it pays no entry slippage \u2014 but every trailing exit is a market order once it triggers, so it pays on the way out. Four calls; leave this page open.');
  function step(k){
   if(k>=TR.length){ b.disabled=false; render(); return; }
   call('/admin/dip-ladder-compounding-pricebands-v2?trailPct='+TR[k]+BASE,function(j){
    if(!j||!j.ok||!j.result){ b.disabled=false; say('The '+TR[k]+'% run came back empty.'+(j&&j.error?' ('+j.error+')':''),true); return; }
    got.push({trail:TR[k],res:j.result,exch:j.exch});
    say('Done '+(k+1)+' of '+TR.length+' \u2014 '+TR[k]+'% trail, after costs. Continuing.');
    step(k+1);
   });
  }
  function pc(x){ return (x>=0?'+':'')+x.toFixed(2)+'%'; }
  function render(){
   var L=[], R0=got[0].res, yrs=(R0.params.totalWeeks*5)/252;
   var ann=function(p){ return (Math.pow(1+p/100,1/yrs)-1)*100; };
   L.push('=== TRAILING SWEEP AFTER COSTS \u2014 '+got[0].exch+' ===','');
   L.push('$'+FEE+' brokerage each way \u00b7 '+SLIP+'% slippage on market-order fills only \u00b7 dip entry (limit, no entry slippage)');
   L.push('Window '+R0.windowStartDate+' \u2192 '+R0.windowEndDate+' \u00b7 $'+R0.params.startingCapital.toLocaleString()+' across '+R0.params.maxPositions+' positions, compounding','');
   L.push('=== NET RESULT ===','');
   got.forEach(function(g){
    g.res.bands.forEach(function(bd){
     L.push('  '+g.trail+'% trail \u00b7 '+bd.band+':  '+bd.taken+' trades \u00b7 '+bd.winRate+'% win  \u2192  '+pc(bd.totalReturnPct)+'  ('+ann(bd.totalReturnPct).toFixed(1)+'% a year)');
    });
   });
   L.push('','=== WHAT THE COSTS TOOK ===','');
   got.forEach(function(g){
    g.res.bands.forEach(function(bd){
     var ts=bd.trades||[];
     var avg=ts.length?(ts.reduce(function(a,t){return a+(t.costPts||0);},0)/ts.length):0;
     L.push('  '+g.trail+'% \u00b7 '+bd.band+': '+ts.length+' trades \u00b7 average '+avg.toFixed(2)+' points per trade lost to costs');
    });
   });
   L.push('','=== CONCENTRATION CHECK, ON THE NET NUMBERS ===','');
   got.forEach(function(g){
    g.res.bands.forEach(function(bd){
     var c=bd.concentration;
     L.push('  '+g.trail+'% \u00b7 '+bd.band+':  net '+pc(bd.totalReturnPct));
     if(!c){ L.push('     (too few trades to check)',''); return; }
     L.push('     biggest winner '+c.biggestWinner.ticker+' '+pc(c.biggestWinner.plPct)+' = '+(c.biggestWinner.shareOfTotalGainPct!=null?c.biggestWinner.shareOfTotalGainPct+'% of the gain':'n/a'));
     L.push('     without it '+pc(c.withoutTop1.totalReturnPct)+' \u00b7 without the top 3 '+pc(c.withoutTop3.totalReturnPct),'');
    });
   });
   L.push('=== THE SAME CELLS BEFORE COSTS (from the previous sweep) ===','');
   L.push('  15%  wide +22.85%  narrow +117.46%');
   L.push('  20%  wide +54.53%  narrow +153.25%');
   L.push('  25%  wide +57.18%  narrow +141.19%');
   L.push('  30%  wide +82.06%  narrow +168.43%','');
   L.push('  fixed 20/15 dip, narrow, before costs: +54.55%   \u00b7   random entries: about +27%','');
   L.push('A trailing exit pays slippage on EVERY exit, while a fixed take-profit exits on a');
   L.push('limit and pays none. So this comparison is tilted against the trail on purpose \u2014');
   L.push('if it still wins here, the win is real.');
   say(L.join('\\n'));
  }
  step(0);
 };
 document.getElementById('trailWideSweep').onclick=function(){
  var b=this; b.disabled=true;
  var BASE='&startingCapital=100000&maxPositions=10&totalWeeks=145&gradeDays=1500&exitMode=trail&buyLevel=-5';
  var TR=[15,20,25,30], got=[];
  say('Sweeping the trail from 15% out to 30%, dip entry, both bands. Four calls; each is slow. Every cell also gets the concentration check \u2014 the same account re-run without its single biggest winner, and again without its top three \u2014 because a result that rests on one trade is not a setting. Leave this page open.');
  function step(k){
   if(k>=TR.length){ b.disabled=false; render(); return; }
   call('/admin/dip-ladder-compounding-pricebands-v2?trailPct='+TR[k]+BASE,function(j){
    if(!j||!j.ok||!j.result){ b.disabled=false; say('The '+TR[k]+'% run came back empty.'+(j&&j.error?' ('+j.error+')':''),true); return; }
    got.push({trail:TR[k],res:j.result,exch:j.exch});
    say('Done '+(k+1)+' of '+TR.length+' \u2014 '+TR[k]+'% trail. Continuing; leave this page open.');
    step(k+1);
   });
  }
  function pc(x){ return (x>=0?'+':'')+x.toFixed(2)+'%'; }
  function render(){
   var L=[], R0=got[0].res, yrs=(R0.params.totalWeeks*5)/252;
   var ann=function(p){ return (Math.pow(1+p/100,1/yrs)-1)*100; };
   L.push('=== TRAILING SWEEP 15/20/25/30%, DIP ENTRY \u2014 '+got[0].exch+' ===','');
   L.push('Window '+R0.windowStartDate+' \u2192 '+R0.windowEndDate+' \u00b7 picks '+(R0.firstPickDate||'none')+' \u2192 '+(R0.lastPickDate||'none')+' \u00b7 about '+yrs.toFixed(2)+' years');
   L.push('$'+R0.params.startingCapital.toLocaleString()+' across '+R0.params.maxPositions+' positions, compounding \u00b7 no take-profit \u00b7 5% dip entry \u00b7 top '+R0.params.topN+', score '+R0.params.minScore+'+','');
   L.push('=== HEADLINE ===','');
   got.forEach(function(g){
    g.res.bands.forEach(function(bd){
     L.push('  '+g.trail+'% trail \u00b7 '+bd.band+':  '+bd.taken+' trades \u00b7 '+bd.winRate+'% win  \u2192  '+pc(bd.totalReturnPct)+'  ('+ann(bd.totalReturnPct).toFixed(1)+'% a year)');
    });
   });
   L.push('','=== THE CONCENTRATION CHECK \u2014 READ THIS BEFORE THE HEADLINE ===','');
   L.push('If a cell collapses once its biggest trade is removed, it is one trade wearing a');
   L.push('setting\u2019s clothes. A real setting survives losing its best winner.','');
   got.forEach(function(g){
    g.res.bands.forEach(function(bd){
     var c=bd.concentration;
     L.push('  '+g.trail+'% \u00b7 '+bd.band+':  headline '+pc(bd.totalReturnPct));
     if(!c){ L.push('     (too few trades to check)',''); return; }
     L.push('     biggest winner: '+c.biggestWinner.ticker+'  '+pc(c.biggestWinner.plPct)+'  = '+(c.biggestWinner.shareOfTotalGainPct!=null?c.biggestWinner.shareOfTotalGainPct+'% of the whole gain':'n/a'));
     L.push('     without it:        '+pc(c.withoutTop1.totalReturnPct)+'   ('+c.withoutTop1.taken+' trades)');
     L.push('     without the top 3: '+pc(c.withoutTop3.totalReturnPct)+'   ('+c.withoutTop3.taken+' trades)','');
    });
   });
   L.push('=== THE RIDGE TEST ===','');
   L.push('A real setting sits in a smooth run of good neighbours. A fluke sits alone. Read');
   L.push('the headline column down each band: if one number towers over the two either side');
   L.push('of it, that is noise, whatever its size.','');
   L.push('=== BARS TO CLEAR ===','');
   L.push('  random entries, same trade count and exits ....  about +27%  (+8.7% a year)');
   L.push('  fixed 20/15, dip, wide band ..................  +71.95%  (+20.7% a year)');
   L.push('  fixed 20/15, dip, narrow band ................  +54.55%  (+16.3% a year)');
   L.push('  buy and hold, wide / narrow .................. +130.8% / +152.1%  (survivorship-flattered)','');
   got.forEach(function(g){
    g.res.bands.forEach(function(bd){
     var top=(bd.trades||[]).slice().sort(function(a,c){return c.plPct-a.plPct;}).slice(0,5)
       .map(function(t){ return t.ticker+' '+pc(t.plPct)+(t.heldDays!=null?(' ('+t.heldDays+'d)'):''); });
     var ts=bd.trades||[];
     var gave=ts.length?(ts.reduce(function(a,t){return a+((t.peakGainPct||0)-t.plPct);},0)/ts.length).toFixed(1):'0';
     var hold=ts.length?(ts.reduce(function(a,t){return a+(t.heldDays||0);},0)/ts.length).toFixed(0):'0';
     L.push('  '+g.trail+'% \u00b7 '+bd.band+' \u2014 best: '+top.join(' \u00b7 '));
     L.push('     average hold '+hold+' days \u00b7 average given back from the peak '+gave+' points');
    });
   });
   say(L.join('\\n'));
  }
  step(0);
 };
 document.getElementById('trailExitTest').onclick=function(){
  var b=this; b.disabled=true;
  var BASE='&startingCapital=100000&maxPositions=10&totalWeeks=145&gradeDays=1500&exitMode=trail';
  var jobs=[{t:10,lv:-5,n:'10% trail, DIP (-5%)'},{t:10,lv:0,n:'10% trail, MARKET'},
            {t:15,lv:-5,n:'15% trail, DIP (-5%)'},{t:15,lv:0,n:'15% trail, MARKET'}];
  var got=[];
  say('Running the trailing exit \u2014 no take-profit at all, the stop starts below the fill and only ever rises. Four runs: 10% and 15% trail, each with the dip entry and with market entry. This is FOUR calls and each is slow; leave this page open.');
  function step(k){
   if(k>=jobs.length){ b.disabled=false; render(); return; }
   var jb=jobs[k];
   call('/admin/dip-ladder-compounding-pricebands-v2?buyLevel='+jb.lv+'&trailPct='+jb.t+BASE,function(j){
    if(!j||!j.ok||!j.result){ b.disabled=false; say('Run '+(k+1)+' ('+jb.n+') came back empty.'+(j&&j.error?' ('+j.error+')':''),true); return; }
    got.push({job:jb,res:j.result,exch:j.exch,from:j.historyFrom});
    say('Done '+(k+1)+' of '+jobs.length+' \u2014 '+jb.n+'. Continuing; leave this page open.');
    step(k+1);
   });
  }
  function render(){
   var L=[], R0=got[0].res;
   L.push('=== TRAILING EXIT \u2014 NO TAKE-PROFIT, WINNERS LEFT TO RUN \u2014 '+got[0].exch+' ===','');
   L.push('Window: '+R0.windowStartDate+' \u2192 '+R0.windowEndDate+' \u00b7 picks actually made '+(R0.firstPickDate||'none')+' \u2192 '+(R0.lastPickDate||'none')+' \u00b7 grading lookback '+R0.gradeDaysUsed+' days');
   L.push('$'+R0.params.startingCapital.toLocaleString()+' across '+R0.params.maxPositions+' positions, compounding \u00b7 top '+R0.params.topN+' by evidence, score '+R0.params.minScore+'+ \u00b7 ETFs/hybrids/bonds excluded \u00b7 once-only per range','');
   L.push('=== SUMMARY \u2014 EVERY COMBINATION ===','');
   got.forEach(function(g){
    g.res.bands.forEach(function(bd){
     L.push(bd.band+'  \u00b7  '+g.job.n+':  taken '+bd.taken+' \u00b7 '+bd.winRate+'% win rate  \u2192  $'+bd.finalAccountValue.toLocaleString()+'  ('+(bd.totalReturnPct>=0?'+':'')+bd.totalReturnPct+'%)');
    });
   });
   L.push('','=== WHAT THE TRAIL ACTUALLY CAUGHT ===','');
   L.push('The point of removing the take-profit is the big winners. If the biggest gains');
   L.push('below are still around +20-30%, the trail is not doing what it was meant to.','');
   got.forEach(function(g){
    g.res.bands.forEach(function(bd){
     var ts=(bd.trades||[]).slice().sort(function(a,c){ return c.plPct-a.plPct; });
     var top=ts.slice(0,5).map(function(t){ return t.ticker+' '+(t.plPct>=0?'+':'')+t.plPct.toFixed(1)+'%'+(t.heldDays!=null?(' ('+t.heldDays+'d)'):''); });
     var hold=ts.length?(ts.reduce(function(a,t){return a+(t.heldDays||0);},0)/ts.length).toFixed(0):'0';
     var gave=ts.length?(ts.reduce(function(a,t){return a+((t.peakGainPct||0)-t.plPct);},0)/ts.length).toFixed(1):'0';
     L.push(bd.band+' \u00b7 '+g.job.n+':');
     L.push('   best five: '+top.join('  \u00b7  '));
     L.push('   average hold '+hold+' days \u00b7 average given back from the peak: '+gave+' points','');
    });
   });
   got.forEach(function(g){
    g.res.bands.forEach(function(bd){
     if(bd.excludedCorpActions&&bd.excludedCorpActions.length)
       L.push('DATA: '+bd.band+' \u00b7 '+g.job.n+' \u2014 '+bd.excludedCorpActions.length+' trade(s) excluded as corporate actions: '+bd.excludedCorpActions.map(function(e){return e.ticker;}).join(', '));
    });
   });
   L.push('','=== COMPARE AGAINST ===','');
   L.push('The random-entry median from the benchmark run: about +27% in both bands.');
   L.push('Buy-and-hold on the same shares: +130.8% (wide) / +152.1% (narrow) \u2014 but that');
   L.push('number is survivorship-flattered, since shares that collapsed and left the');
   L.push('market are not in the store at all. The random arm has no such problem.');
   say(L.join('\\n'));
  }
  step(0);
 };
 document.getElementById('benchmarkBands').onclick=function(){
  var b=this; b.disabled=true;
  say('Computing what the SAME shares returned to someone with no strategy at all \u2014 buy-and-hold, monthly rebalance, and 200 random-entry runs wearing the strategy\u2019s own exits and position cap. The random arm is the important one. Leave this page open.');
  call('/admin/benchmark-bands',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var R=j.result,L=[];
   var ann=function(p){ var y=R.yearsApprox||1; return (Math.pow(1+p/100,1/y)-1)*100; };
   var f=function(x){ return (x>=0?'+':'')+x.toFixed(2)+'%'; };
   L.push('=== BENCHMARK \u2014 WHAT DOING NOTHING PAID \u2014 '+j.exch+' ===','');
   L.push('Window: '+R.windowStartDate+' \u2192 '+R.windowEndDate+'  ('+R.tradingDays+' trading days, about '+R.yearsApprox+' years)');
   L.push('Universe after ETF/hybrid/bond exclusion: '+R.universeAfterExclusion+' shares \u00b7 random arm: '+R.params.randomRuns+' runs of ~'+R.params.tradesToMatch+' trades, seed '+R.params.seed+' (reproducible)','');
   R.bands.forEach(function(bd){
    L.push('\u2014\u2014\u2014 '+bd.band+'  ('+bd.members+' shares priced in this band on day one) \u2014\u2014\u2014','');
    if(bd.note){ L.push('  '+bd.note,''); return; }
    L.push('  BUY THE LOT AND HOLD      '+f(bd.equalWeightPct)+' total   ('+ann(bd.equalWeightPct).toFixed(1)+'% a year)');
    L.push('  SAME, REBALANCED MONTHLY  '+f(bd.monthlyRebalPct)+' total   ('+ann(bd.monthlyRebalPct).toFixed(1)+'% a year)');
    L.push('  median single share       '+f(bd.medianSharePct)+'   \u00b7  '+bd.sharesUpPct+'% of them finished up');
    L.push('  best / worst share        '+f(bd.bestSharePct)+' / '+f(bd.worstSharePct),'');
    var r=bd.random;
    L.push('  RANDOM ENTRIES, SAME EXITS \u2014 '+r.runs+' runs, ~'+r.tradesPerRun+' trades each, '+r.avgWinRate+'% average win rate:');
    L.push('    worst 5%   '+f(r.p5));
    L.push('    lower 25%  '+f(r.p25));
    L.push('    MEDIAN     '+f(r.median)+'   ('+ann(r.median).toFixed(1)+'% a year)  \u2190 the bar the evidence has to clear');
    L.push('    upper 75%  '+f(r.p75));
    L.push('    best 5%    '+f(r.p95));
    L.push('','    A strategy inside this spread has not shown an edge \u2014 it has shown a draw.');
    L.push('    Above the 95th line is the only unambiguous result.','');
   });
   L.push('=== HOW TO READ THIS ===','');
   L.push('Compare your $100k run against the RANDOM MEDIAN of the same band, not against');
   L.push('zero. Buy-and-hold answers "was the market kind"; the random arm answers "did the');
   L.push('evidence pick better than a coin", holding trade count, exits and period constant.');
   L.push('The random arm carries no costs either, so it is a fair like-for-like on that too.');
   say(L.join('\\n'));
  });
 };
 document.getElementById('deepDataAudit').onclick=function(){
  var b=this; b.disabled=true;
  say('Auditing every stored share above the $50k turnover floor \u2014 consolidations and splits (all confidence levels, vetoed ones included), impossible OHLC bars, gaps against the market calendar, flat runs, and spike-and-revert bad ticks. Read-only; nothing is changed. Leave this page open.');
  call('/admin/deep-data-audit',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.audit){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var A=j.audit, L=[];
   L.push('=== DEEP DATA AUDIT \u2014 '+j.exch+' ===','');
   L.push('Universe: '+A.universe+' shares above the $'+j.floor.toLocaleString()+' turnover floor \u00b7 calendar '+A.from+' \u2192 '+A.to+' ('+A.calendarDays+' trading days)','');
   L.push('TOTALS \u2014 corporate-action-like jumps: '+A.counts.corp+' \u00b7 impossible bars: '+A.counts.ohlc+' \u00b7 gaps of 5+ market days: '+A.counts.gaps+' \u00b7 flat runs of 15+ days: '+A.counts.flat+' \u00b7 spike-and-revert bad ticks: '+A.counts.spikes,'');
   L.push('Every list below is capped at 40 entries; the totals above are exact.','');
   L.push('--- CORPORATE-ACTION-LIKE JUMPS (largest factor first) ---');
   if(!A.corp.length)L.push('  none found');
   A.corp.forEach(function(e){ L.push('  '+e.ticker+'  '+e.d+'  ratio '+e.ratio+'  \u2192 '+e.factor+'-for-1 '+e.kind+'  ['+e.confidence+(e.byMagnitude?', by size':'')+(e.volRatio!=null?(', vol \u00d7'+e.volRatio):', no volume')+']'); });
   L.push('','  "confirmed"/"suspected" are excluded from backtests when a trade spans them.');
   L.push('  "news-like" means the volume moved WITH the price \u2014 judged a real move and');
   L.push('  still traded. Eyeball these: any that is actually a consolidation is a hole.','');
   L.push('--- IMPOSSIBLE BARS ---');
   if(!A.ohlc.length)L.push('  none found');
   A.ohlc.forEach(function(e){ L.push('  '+e.ticker+'  '+e.d+'  '+e.why+'  (o '+e.o+' h '+e.hi+' l '+e.lo+' c '+e.c+' v '+e.v+')'); });
   L.push('','--- GAPS \u2014 share missing while the market traded (5+ days, with the move across the hole) ---');
   if(!A.gaps.length)L.push('  none found');
   A.gaps.forEach(function(e){ L.push('  '+e.ticker+'  '+e.fromD+' \u2192 '+e.toD+'  ('+e.marketDaysMissing+' market days missing)  close '+e.closeBefore+' \u2192 '+e.closeAfter+(e.moveAcrossGapPct!=null?('  ('+(e.moveAcrossGapPct>=0?'+':'')+e.moveAcrossGapPct+'% across the gap)'):'')); });
   L.push('','  A big move across a long gap is where a halt + corporate action can hide from');
   L.push('  the consecutive-close detector \u2014 these are the ones worth checking by hand.','');
   L.push('--- FLAT RUNS (identical close 15+ days, with volume) ---');
   if(!A.flat.length)L.push('  none found');
   A.flat.forEach(function(e){ L.push('  '+e.ticker+'  '+e.fromD+' \u2192 '+e.toD+'  ('+e.days+' days at '+e.close+')'); });
   L.push('','--- SPIKE-AND-REVERT (shape of a bad tick, not of news) ---');
   if(!A.spikes.length)L.push('  none found');
   A.spikes.forEach(function(e){ L.push('  '+e.ticker+'  '+e.d+'  '+(e.dayMovePct>=0?'+':'')+e.dayMovePct+'% then '+(e.nextDayPct>=0?'+':'')+e.nextDayPct+'% next day  (closes '+e.closes.join(' \u2192 ')+')'); });
   say(L.join('\\n'));
  });
 };
 document.getElementById('dipLadderPB100k').onclick=function(){
  var b=this; b.disabled=true;
  var Q='&startingCapital=100000&maxPositions=10&totalWeeks=145&gradeDays=1500';
  say('Running $100,000 across 10 positions ($10,000 a trade to start, compounding as the account grows), over the FULL stored history rather than the last year. Two calls, dip then market \u2014 leave this page open. This one is slower: the grading lookback is six times longer than usual.');
  call('/admin/dip-ladder-compounding-pricebands-v2?buyLevel=-5'+Q,function(jDip){
   if(!jDip||!jDip.ok||!jDip.result){
    b.disabled=false;
    var m1='No result came back for the dip-entry run.';
    if(jDip&&jDip.error){ m1+=' ('+jDip.error+')'; if(jDip.historyFrom){ m1+=' Stored history only goes back to '+jDip.historyFrom+'.'; } }
    say(m1,true); return;
   }
   say('Dip-entry run done. Now the no-dip (market entry) version \u2014 leave this page open.');
   call('/admin/dip-ladder-compounding-pricebands-v2?buyLevel=0'+Q,function(jMkt){
    b.disabled=false;
    if(!jMkt||!jMkt.ok||!jMkt.result){
     var m2='Dip-entry run succeeded, but no result came back for the market-entry run.';
     if(jMkt&&jMkt.error){ m2+=' ('+jMkt.error+')'; if(jMkt.historyFrom){ m2+=' Stored history only goes back to '+jMkt.historyFrom+'.'; } }
     say(m2,true); return;
    }
    _renderDipVsMkt(jDip, jMkt, '$100,000 POOL, 10 OPEN POSITIONS, FULL STORED HISTORY');
   });
  });
 };
 document.getElementById('dipLadderPBDipVsMkt').onclick=function(){
  var b=this; b.disabled=true;
  say('Running 20%/15%, top-4/day, over $0.15\u2013$1.75 and $0.20\u2013$0.99 \u2014 first with the usual -5% dip entry, then again buying at market (no dip wait) on the exact same rules otherwise, so the two are directly comparable. This makes two separate calls; leave this page open.');
  call('/admin/dip-ladder-compounding-pricebands-v2?buyLevel=-5',function(jDip){
   if(!jDip||!jDip.ok||!jDip.result){
    b.disabled=false;
    var msg='No result came back for the dip-entry run.';
    if(jDip&&jDip.error){ msg+=' ('+jDip.error+')'; if(jDip.historyFrom){ msg+=' Stored history only goes back to '+jDip.historyFrom+'.'; } }
    say(msg,true); return;
   }
   say('Dip-entry run done. Now running the no-dip (market entry) version \u2014 leave this page open.');
   call('/admin/dip-ladder-compounding-pricebands-v2?buyLevel=0',function(jMkt){
    b.disabled=false;
    if(!jMkt||!jMkt.ok||!jMkt.result){
     var msg2='Dip-entry run succeeded, but no result came back for the market-entry run.';
     if(jMkt&&jMkt.error){ msg2+=' ('+jMkt.error+')'; if(jMkt.historyFrom){ msg2+=' Stored history only goes back to '+jMkt.historyFrom+'.'; } }
     say(msg2,true); return;
    }
    _renderDipVsMkt(jDip, jMkt, '20%/15% COMPOUNDING FROM $50,000, DIP ENTRY vs NO-DIP (MARKET) ENTRY');
   });
  });
 };
 function _renderDipVsMkt(jDip, jMkt, HEADING){
    var rDip=jDip.result, rMkt=jMkt.result, P=rDip.params, lines=[];
    lines.push('=== '+HEADING+' \u2014 '+jDip.exch+' ===','');
    lines.push('History available from: '+jDip.historyFrom+' \u00b7 Window: '+rDip.windowStartDate+' \u2192 '+rDip.windowEndDate);
    lines.push('Picks actually made: '+(rDip.firstPickDate||'none')+' \u2192 '+(rDip.lastPickDate||'none')+' (dip) \u00b7 '+(rMkt.firstPickDate||'none')+' \u2192 '+(rMkt.lastPickDate||'none')+' (market) \u00b7 grading lookback '+rDip.gradeDaysUsed+' trading days');
    lines.push('  \u2014 if the picks start well after the window opens, the window is not the binding constraint; the grading lookback is.');
    lines.push('Each range: its OWN $50,000, max '+P.maxPositions+' positions at once \u00b7 target +'+P.targetPct+'% / stop \u2212'+P.stopPct+'% \u00b7 top '+P.topN+' by evidence, score '+P.minScore+'+, WITHIN that range only \u00b7 ETFs/hybrids/bonds '+(rDip.excludeNonEquity?'EXCLUDED':'included')+' \u00b7 once-only across the window, per range','');
    lines.push('=== SUMMARY \u2014 ALL FOUR COMBINATIONS SIDE BY SIDE ===','');
    for(var i=0;i<rDip.bands.length;i++){
     var bd=rDip.bands[i], bm=rMkt.bands[i];
     lines.push(bd.band+', DIP (-5%):     offered '+bd.offered+' \u00b7 skipped '+bd.skippedForCap+' \u00b7 taken '+bd.taken+' \u00b7 '+bd.winRate+'% win rate  \u2192  $'+bd.finalAccountValue.toLocaleString()+'  ('+(bd.totalReturnPct>=0?'+':'')+bd.totalReturnPct+'%)');
     lines.push(bm.band+', NO-DIP (mkt):  offered '+bm.offered+' \u00b7 skipped '+bm.skippedForCap+' \u00b7 taken '+bm.taken+' \u00b7 '+bm.winRate+'% win rate  \u2192  $'+bm.finalAccountValue.toLocaleString()+'  ('+(bm.totalReturnPct>=0?'+':'')+bm.totalReturnPct+'%)');
     lines.push('');
    }
    lines.push('=== DATA INTEGRITY \u2014 CORPORATE ACTIONS AND OUTSIZED MOVES ===','');
    lines.push('The stored bars are raw prices, never adjusted for splits or consolidations. A share');
    lines.push('that consolidates 11-for-1 shows an 11\u00d7 "gain" that no account ever earned. Any trade');
    lines.push('spanning a detected event is removed from the run entirely \u2014 P&L AND position size \u2014');
    lines.push('and listed here rather than dropped quietly.','');
    for(var q=0;q<rDip.bands.length;q++){
     _corpLines(rDip.bands[q], rDip.bands[q].band+', DIP (-5%)').forEach(function(x){ lines.push(x); });
     _corpLines(rMkt.bands[q], rMkt.bands[q].band+', NO-DIP (mkt)').forEach(function(x){ lines.push(x); });
    }
    function pushTradesSection(title, bd){
     lines.push('=== '+title+' \u2014 EVERY TRADE, IN ORDER ===','');
     if(!bd.trades.length){ lines.push('  (no trades \u2014 either no candidates ever qualified in this range, or none filled)',''); return; }
     bd.trades.forEach(function(t,ix){
      lines.push((ix+1)+'. '+t.ticker+' \u2014 picked '+t.pickDate+' on '+t.evidenceKey+' ('+t.tier+', score '+t.score+') \u00b7 ref close $'+t.refClose);
      lines.push('  account value at entry: $'+t.accountValueAtEntry.toLocaleString()+'  \u2192  position size: $'+t.positionSize.toLocaleString()+' ('+t.openAtFill+' others open at the time)');
      lines.push('  filled '+t.fillDate+' @ $'+t.fillPrice+'  \u2192  exit '+t.exitDate+' @ $'+t.exitPrice+' ('+t.exitWhy+')  \u00b7  '+(t.plPct>=0?'+':'')+t.plPct+'%  \u00b7  '+(t.dollarPL>=0?'+':'')+'$'+t.dollarPL.toLocaleString()+' to the account');
      lines.push('');
     });
     if(bd.skipped.length){
      lines.push('  SKIPPED \u2014 cap was full at the moment these would have filled:');
      bd.skipped.forEach(function(s){ lines.push('    '+s.ticker+' \u2014 picked '+s.pickDate+', would have filled '+s.level.fillDate+' ('+s.openAtFill+'/'+P.maxPositions+' already open)'); });
      lines.push('');
     }
    }
    for(var j=0;j<rDip.bands.length;j++){
     pushTradesSection(rDip.bands[j].band+' \u2014 DIP (-5%)', rDip.bands[j]);
     pushTradesSection(rMkt.bands[j].band+' \u2014 NO-DIP (market)', rMkt.bands[j]);
    }
    say(lines.join('\\n'));
 }
 document.getElementById('dipLadderFixedTSMulti').onclick=function(){
  var b=this; b.disabled=true; say('Running the fixed target/stop dip-ladder backtest — 12 months, buying every week, fixed take-profit/stop-loss, but this time the same share CAN be bought again in a later week if it fires again. Running both combinations (10%/10% and 5%/10%) on the same data, plus a concurrent-capital check. This will take a while — leave this page open.');
  call('/admin/dip-ladder-backtest-fixedts-multi',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.combos){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var lines=[];
   lines.push('=== DIP-LADDER BACKTEST, FIXED TARGET/STOP, MULTIPLE BUYS ALLOWED — '+j.exch+' ===','');
   j.combos.forEach(function(combo){
    var r=combo.result, P=r.params, E=r.exposure;
    lines.push('───────────────────────────────────────────','COMBINATION: '+combo.label,'───────────────────────────────────────────');
    lines.push('Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate+' ('+r.blockCount+' weekly entry blocks) \u00b7 top '+P.topN+' by evidence each week \u00b7 a share already bought CAN be bought again in a later week if it fires again (dedupe resets weekly, not for the whole year)');
    lines.push('$'+P.amountPerLevel.toLocaleString()+' per level \u00d7 4 levels ('+P.levels.map(function(l){return l===0?'market':l+'%';}).join(', ')+') per candidate \u00b7 exit: +'+P.targetPct+'% take-profit or \u2212'+P.stopPct+'% stop-loss, whichever hits first \u2014 no trailing stop, no ladder, no scale-out');
    lines.push('Total entries: '+r.candidateCount+' (repeat picks of the same ticker in different weeks counted separately \u2014 see BY TICKER below)','');
    lines.push('CONCURRENT CAPITAL REQUIRED (buying all 4 levels on every entry):');
    lines.push('  peak: $'+E.peakExposure.toLocaleString()+' \u00b7 median (typical): $'+E.medianExposure.toLocaleString()+' \u00b7 90th percentile: $'+E.p90Exposure.toLocaleString());
    lines.push('  (peak can be inflated by entries from the last few weeks that have not had time to resolve yet \u2014 median is the more honest "steady state" figure)','');
    lines.push('PER LEVEL:');
    r.perLevelSummary.forEach(function(s){
     var lbl=s.level===0?'Market':(s.level+'% dip');
     lines.push('  '+lbl+': '+s.filled+'/'+r.candidateCount+' filled'+(s.notFilled?(' ('+s.notFilled+' never reached that level within their entry week)'):'')+
       (s.filled?('  \u00b7  invested $'+s.invested.toLocaleString()+'  \u00b7  proceeds $'+s.proceeds.toLocaleString()+'  \u00b7  P/L '+(s.pl>=0?'+':'')+'$'+s.pl.toLocaleString()+' ('+(s.plPct>=0?'+':'')+s.plPct+'%)  \u00b7  '+s.winRate+'% win rate'):''));
    });
    lines.push('','BY TICKER \u2014 repeat-pick concentration, most-picked first (top 20 shown):');
    r.byTicker.slice(0,20).forEach(function(t){ lines.push('  '+t.ticker+': picked '+t.timesPicked+'x  \u00b7  invested $'+t.invested.toLocaleString()+'  \u00b7  P/L '+(t.pl>=0?'+':'')+'$'+t.pl.toLocaleString()); });
    lines.push('');
   });
   lines.push('=== EVERY ENTRY, BOTH COMBINATIONS ===','');
   j.combos.forEach(function(combo){
    lines.push('--- '+combo.label+' ---');
    combo.result.candidates.forEach(function(c,ix){
     lines.push((ix+1)+'. '+c.ticker+' \u2014 entered week of '+c.weekStart+', picked '+c.pickDate+' on '+c.evidenceKey+' ('+c.tier+', edge '+(c.edge>=0?'+':'')+c.edge.toFixed(2)+')');
     c.levels.forEach(function(lv){
      var lbl=lv.level===0?'  market':('  '+lv.level+'%  ');
      if(!lv.filled){ lines.push(lbl+': never filled (limit '+(lv.limitPrice!=null?'$'+lv.limitPrice:'n/a')+')'); return; }
      lines.push(lbl+': filled '+lv.fillDate+' @ $'+lv.fillPrice+'  \u2192  exit '+lv.exitDate+' @ $'+lv.exitPrice+' ('+lv.exitWhy+')  \u00b7  '+(lv.plPct>=0?'+':'')+lv.plPct+'%');
     });
     lines.push('');
    });
   });
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderVsApp').onclick=function(){
  var b=this; b.disabled=true; say('Running the missing comparison — the app\\'s OWN current best-practice bot defaults (20% target / 8% stop / 8% trailing / breakeven-arm at +5% / 10-day max hold) against the new 10%/10% fixed target/stop, both buying the SAME -5% dip picks, once-only across the year. This isolates the exit mechanism as the only variable. Leave this page open.');
  call('/admin/dip-ladder-vs-app-default',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var r=j.result, AC=r.appConfig, NC=r.newConfig, AS=r.appSummary, NS=r.newSummary, AE=r.appExposure, NE=r.newExposure, lines=[];
   lines.push('=== APP DEFAULT vs NEW 10%/10% — '+j.exch+' ===','');
   lines.push('Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate+' ('+r.blockCount+' weekly entry blocks) \u00b7 buy level: '+r.buyLevel+'% dip only (matches a real single-order auto-pilot, not 4 parallel levels) \u00b7 once-only across the whole year (repeat buys already shown to be worse)');
   lines.push('Candidates (same picks feed both sides): '+r.candidateCount,'');
   lines.push('APP DEFAULT: '+AC.target+'% target / '+AC.stop+'% stop / '+AC.trail+'% trailing / breakeven-arm at +'+AC.be+'% / max hold '+AC.hold+'d');
   lines.push('  '+AS.filled+'/'+r.candidateCount+' filled \u00b7 invested $'+AS.invested.toLocaleString()+' \u00b7 proceeds $'+AS.proceeds.toLocaleString()+' \u00b7 P/L '+(AS.pl>=0?'+':'')+'$'+AS.pl.toLocaleString()+' ('+(AS.plPct>=0?'+':'')+AS.plPct+'%) \u00b7 '+AS.winRate+'% win rate');
   lines.push('  concurrent capital: peak $'+AE.peakExposure.toLocaleString()+' \u00b7 median $'+AE.medianExposure.toLocaleString(),'');
   lines.push('NEW COMBO: '+NC.target+'% target / '+NC.stop+'% stop \u2014 no trailing, no ladder, no scale-out, no time stop');
   lines.push('  '+NS.filled+'/'+r.candidateCount+' filled \u00b7 invested $'+NS.invested.toLocaleString()+' \u00b7 proceeds $'+NS.proceeds.toLocaleString()+' \u00b7 P/L '+(NS.pl>=0?'+':'')+'$'+NS.pl.toLocaleString()+' ('+(NS.plPct>=0?'+':'')+NS.plPct+'%) \u00b7 '+NS.winRate+'% win rate');
   lines.push('  concurrent capital: peak $'+NE.peakExposure.toLocaleString()+' \u00b7 median $'+NE.medianExposure.toLocaleString(),'');
   var appRet = AE.medianExposure>0 ? (AS.pl/AE.medianExposure*100) : 0;
   var newRet = NE.medianExposure>0 ? (NS.pl/NE.medianExposure*100) : 0;
   lines.push('Return on typical deployed capital: APP DEFAULT '+appRet.toFixed(1)+'%  vs  NEW COMBO '+newRet.toFixed(1)+'%  \u2014  '+(appRet>newRet?'the APP DEFAULT wins on this data':(newRet>appRet?'the NEW COMBO wins on this data':'dead even')));
   lines.push('','=== EVERY ENTRY, BOTH SIDES ===','');
   r.candidates.forEach(function(c,ix){
    lines.push((ix+1)+'. '+c.ticker+' \u2014 picked '+c.pickDate+' on '+c.evidenceKey+' ('+c.tier+', edge '+(c.edge>=0?'+':'')+c.edge.toFixed(2)+')');
    var a=c.appResult, n=c.newResult;
    lines.push('  app default: '+(a.filled?('filled '+a.fillDate+' @ $'+a.fillPrice+' \u2192 exit '+a.exitDate+' @ $'+a.exitPrice+' ('+a.exitWhy+') \u00b7 '+(a.plPct>=0?'+':'')+a.plPct+'%'):('never filled (limit $'+a.limitPrice+')')));
    lines.push('  new combo:   '+(n.filled?('filled '+n.fillDate+' @ $'+n.fillPrice+' \u2192 exit '+n.exitDate+' @ $'+n.exitPrice+' ('+n.exitWhy+') \u00b7 '+(n.plPct>=0?'+':'')+n.plPct+'%'):('never filled (limit $'+n.limitPrice+')')));
    lines.push('');
   });
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderVsAppV2').onclick=function(){
  var b=this; b.disabled=true; say('Running the app-vs-15/15 comparison, rebuilt on the current selection rules (score 7+, top 4 by evidence, ETFs/hybrids/bonds excluded) instead of the older rules the original 10/10 test used \u2014 so this is a fair test of the actual 15/15 answer, not a different candidate pool. Same -5% dip entry feeds both sides, once-only across the year. Leave this page open.');
  call('/admin/dip-ladder-vs-app-default-v2',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var r=j.result, AC=r.appConfig, NC=r.newConfig, AS=r.appSummary, NS=r.newSummary, AE=r.appExposure, NE=r.newExposure, lines=[];
   lines.push('=== APP DEFAULT vs NEW 15%/15% \u2014 '+j.exch+' ===','');
   lines.push('Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate+' ('+r.blockCount+' weekly entry blocks) \u00b7 buy level: '+r.buyLevel+'% dip only \u00b7 top 4 by evidence, score 7+, ETFs/hybrids/bonds '+(r.excludeNonEquity?'EXCLUDED':'included')+' \u00b7 once-only across the whole year');
   lines.push('Candidates (same picks feed both sides): '+r.candidateCount,'');
   lines.push('APP DEFAULT: '+AC.target+'% target / '+AC.stop+'% stop / '+AC.trail+'% trailing / breakeven-arm at +'+AC.be+'% / max hold '+AC.hold+'d');
   lines.push('  '+AS.filled+'/'+r.candidateCount+' filled \u00b7 invested $'+AS.invested.toLocaleString()+' \u00b7 proceeds $'+AS.proceeds.toLocaleString()+' \u00b7 P/L '+(AS.pl>=0?'+':'')+'$'+AS.pl.toLocaleString()+' ('+(AS.plPct>=0?'+':'')+AS.plPct+'%) \u00b7 '+AS.winRate+'% win rate');
   lines.push('  concurrent capital: peak $'+AE.peakExposure.toLocaleString()+' \u00b7 median $'+AE.medianExposure.toLocaleString(),'');
   lines.push('NEW COMBO: '+NC.target+'% target / '+NC.stop+'% stop \u2014 no trailing, no ladder, no scale-out, no time stop');
   lines.push('  '+NS.filled+'/'+r.candidateCount+' filled \u00b7 invested $'+NS.invested.toLocaleString()+' \u00b7 proceeds $'+NS.proceeds.toLocaleString()+' \u00b7 P/L '+(NS.pl>=0?'+':'')+'$'+NS.pl.toLocaleString()+' ('+(NS.plPct>=0?'+':'')+NS.plPct+'%) \u00b7 '+NS.winRate+'% win rate');
   lines.push('  concurrent capital: peak $'+NE.peakExposure.toLocaleString()+' \u00b7 median $'+NE.medianExposure.toLocaleString(),'');
   var appRet = AE.medianExposure>0 ? (AS.pl/AE.medianExposure*100) : 0;
   var newRet = NE.medianExposure>0 ? (NS.pl/NE.medianExposure*100) : 0;
   lines.push('Return on typical deployed capital: APP DEFAULT '+appRet.toFixed(1)+'%  vs  NEW COMBO '+newRet.toFixed(1)+'%  \u2014  '+(appRet>newRet?'the APP DEFAULT wins on this data':(newRet>appRet?'the NEW COMBO wins on this data':'dead even')));
   lines.push('','=== EVERY ENTRY, BOTH SIDES ===','');
   r.candidates.forEach(function(c,ix){
    lines.push((ix+1)+'. '+c.ticker+' \u2014 picked '+c.pickDate+' on '+c.evidenceKey+' ('+c.tier+', score '+c.score+', edge '+(c.edge>=0?'+':'')+c.edge.toFixed(2)+')');
    var a=c.appResult, n=c.newResult;
    lines.push('  app default: '+(a.filled?('filled '+a.fillDate+' @ $'+a.fillPrice+' \u2192 exit '+a.exitDate+' @ $'+a.exitPrice+' ('+a.exitWhy+') \u00b7 '+(a.plPct>=0?'+':'')+a.plPct+'%'):('never filled (limit $'+a.limitPrice+')')));
    lines.push('  new combo:   '+(n.filled?('filled '+n.fillDate+' @ $'+n.fillPrice+' \u2192 exit '+n.exitDate+' @ $'+n.exitPrice+' ('+n.exitWhy+') \u00b7 '+(n.plPct>=0?'+':'')+n.plPct+'%'):('never filled (limit $'+n.limitPrice+')')));
    lines.push('');
   });
   say(lines.join('\\n'));
  });
 };
 document.getElementById('dipLadderVsAppV2_2500').onclick=function(){
  var b=this; b.disabled=true; say('Running the same app-vs-15/15 comparison at $2,500 per trade instead of $5,000. Worth knowing going in: since every trade uses the same dollar amount, the percentage figures (return %, win rate, return-on-exposure) will come out identical to the $5,000 run \u2014 halving the trade size halves every dollar figure by the same factor, so the ratios do not change. What DOES change is the actual capital tied up. Leave this page open.');
  call('/admin/dip-ladder-vs-app-default-v2?amount=2500',function(j){
   b.disabled=false;
   if(!j||!j.ok||!j.result){ say('No result came back.'+(j&&j.error?' ('+j.error+')':''),true); return; }
   var r=j.result, AC=r.appConfig, NC=r.newConfig, AS=r.appSummary, NS=r.newSummary, AE=r.appExposure, NE=r.newExposure, lines=[];
   lines.push('=== APP DEFAULT vs NEW 15%/15%, $2,500/TRADE \u2014 '+j.exch+' ===','');
   lines.push('Window: '+r.windowStartDate+' \u2192 '+r.windowEndDate+' ('+r.blockCount+' weekly entry blocks) \u00b7 buy level: '+r.buyLevel+'% dip only \u00b7 top 4 by evidence, score 7+, ETFs/hybrids/bonds '+(r.excludeNonEquity?'EXCLUDED':'included')+' \u00b7 once-only across the whole year \u00b7 $2,500 per trade (was $5,000)');
   lines.push('Candidates (same picks feed both sides): '+r.candidateCount,'');
   lines.push('APP DEFAULT: '+AC.target+'% target / '+AC.stop+'% stop / '+AC.trail+'% trailing / breakeven-arm at +'+AC.be+'% / max hold '+AC.hold+'d');
   lines.push('  '+AS.filled+'/'+r.candidateCount+' filled \u00b7 invested $'+AS.invested.toLocaleString()+' \u00b7 proceeds $'+AS.proceeds.toLocaleString()+' \u00b7 P/L '+(AS.pl>=0?'+':'')+'$'+AS.pl.toLocaleString()+' ('+(AS.plPct>=0?'+':'')+AS.plPct+'%) \u00b7 '+AS.winRate+'% win rate');
   lines.push('  concurrent capital: peak $'+AE.peakExposure.toLocaleString()+' \u00b7 median $'+AE.medianExposure.toLocaleString(),'');
   lines.push('NEW COMBO: '+NC.target+'% target / '+NC.stop+'% stop \u2014 no trailing, no ladder, no scale-out, no time stop');
   lines.push('  '+NS.filled+'/'+r.candidateCount+' filled \u00b7 invested $'+NS.invested.toLocaleString()+' \u00b7 proceeds $'+NS.proceeds.toLocaleString()+' \u00b7 P/L '+(NS.pl>=0?'+':'')+'$'+NS.pl.toLocaleString()+' ('+(NS.plPct>=0?'+':'')+NS.plPct+'%) \u00b7 '+NS.winRate+'% win rate');
   lines.push('  concurrent capital: peak $'+NE.peakExposure.toLocaleString()+' \u00b7 median $'+NE.medianExposure.toLocaleString(),'');
   var appRet = AE.medianExposure>0 ? (AS.pl/AE.medianExposure*100) : 0;
   var newRet = NE.medianExposure>0 ? (NS.pl/NE.medianExposure*100) : 0;
   lines.push('Return on typical deployed capital: APP DEFAULT '+appRet.toFixed(1)+'%  vs  NEW COMBO '+newRet.toFixed(1)+'%  \u2014  '+(appRet>newRet?'the APP DEFAULT wins on this data':(newRet>appRet?'the NEW COMBO wins on this data':'dead even'))+'  (these percentages will match the $5,000 run exactly \u2014 only the dollars below have changed)');
   lines.push('','=== EVERY ENTRY, BOTH SIDES ===','');
   r.candidates.forEach(function(c,ix){
    lines.push((ix+1)+'. '+c.ticker+' \u2014 picked '+c.pickDate+' on '+c.evidenceKey+' ('+c.tier+', score '+c.score+', edge '+(c.edge>=0?'+':'')+c.edge.toFixed(2)+')');
    var a=c.appResult, n=c.newResult;
    lines.push('  app default: '+(a.filled?('filled '+a.fillDate+' @ $'+a.fillPrice+' \u2192 exit '+a.exitDate+' @ $'+a.exitPrice+' ('+a.exitWhy+') \u00b7 '+(a.plPct>=0?'+':'')+a.plPct+'%'):('never filled (limit $'+a.limitPrice+')')));
    lines.push('  new combo:   '+(n.filled?('filled '+n.fillDate+' @ $'+n.fillPrice+' \u2192 exit '+n.exitDate+' @ $'+n.exitPrice+' ('+n.exitWhy+') \u00b7 '+(n.plPct>=0?'+':'')+n.plPct+'%'):('never filled (limit $'+n.limitPrice+')')));
    lines.push('');
   });
   say(lines.join('\\n'));
  });
 };
 document.getElementById('all').onclick=function(){
  if(!document.getElementById('all').disabled&&document.getElementById('all').textContent==='Stop'){ stopNow=true; say('Stopping after this round…'); return; }
  stopNow=false; rounds=0; setBusy(true);
  var lastSig='';
  var round=function(){
   if(stopNow){ setBusy(false); say('Stopped. Press Fill until full to carry on.'); return; }
   if(rounds>=MAX_ROUNDS){ setBusy(false); say('Paused after '+rounds+' rounds — that is about '+(rounds*10)+' days. Press again to keep going.'); return; }
   rounds++;
   say('Round '+rounds+' — fetching ten more days. Leave this page open.');
   askJSON('/admin/backfill?days=10').then(function(){
    return askJSON('/admin/status');
   }).then(function(s){
    var d=s.depth||[];
    var sig=sigOf(d);
    if(full(d)){ setBusy(false); draw(d,'The pantry is full. Nothing more to fetch.'); return; }
    if(sig&&sig===lastSig){ setBusy(false); draw(d,'Stopped: that round moved nothing on either exchange ('+whereOf(d)+'). If EODData sent back an error, it\u2019s shown below with the exact HTTP status and response text, instead of a guess.'); return; }
    lastSig=sig;
    draw(d,'Round '+rounds+' done — '+whereOf(d)+'. Starting the next one…');
    setTimeout(round,1200);
   }).catch(function(e){
    setBusy(false); say('Stopped after '+rounds+' round(s): '+e,1);
   });
  };
  round();
 };
 document.getElementById('go').onclick=function(){
  var b=this; b.disabled=true; say('Fetching ten more days. This takes a minute — leave the page open.');
  call('/admin/backfill?days=10',function(j){
   var lines='Done. Filled back to: ';
   for(var e in (j.after||{}))lines+=e+' '+j.after[e]+'  ';
   call('/admin/status',function(s){ draw(s.depth||[], lines+'\\n\\nPress it again to keep going.'); b.disabled=false; });
  });
 };
</script>
</div>
<div style="margin-top:18px;padding:12px;border:1px solid #2b3d5c;border-radius:8px;">
  <h2 style="margin:0 0 6px;font-size:14px;">\ud83c\udfd7 Three-year era study</h2>
  <p style="font-size:12px;line-height:1.5;margin:0 0 8px;">Grades the two OLDER stored years with the exact same maths as the live report card, so every signal line gets a durability verdict (\u201cdid this also work in the years before?\u201d). Runs in small steps \u2014 press the button and leave the page open; it keeps pressing for you. Re-run monthly (with Reset) so the eras roll forward. Cards pick the results up within a day.</p>
  <button id="eraGo" style="padding:6px 12px;">\ud83c\udfd7 Build / continue the era study</button>
  <button id="eraReset" style="padding:6px 12px;">Reset</button>
  <div id="eraOut" style="font-size:12px;margin-top:8px;white-space:pre-wrap;"></div>
</div>
<script>
(function(){
  var b=document.getElementById('eraGo'), rb=document.getElementById('eraReset'), o=document.getElementById('eraOut');
  var stop=false;
  function line(t){ o.textContent=t; }
  function step(round){
    if(stop){ b.disabled=false; line('Paused. Press again to continue \u2014 progress is saved.'); stop=false; return; }
    if(round>200){ b.disabled=false; line('Paused after 200 steps \u2014 press again to keep going. Progress is saved.'); return; }
    var k=K(); if(!k){ b.disabled=false; line('Type your admin password first (top of the page).'); return; }
    fetch('/admin/era-build',{headers:{'X-Insight-Admin':k}})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j&&j.blocked){ b.disabled=false; line('\u23f8 '+j.blocked); return; }
        if(j&&j.finished){ b.disabled=false; line('\u2705 Era study built'+(j.built?(' ('+j.built+')'):'')+'. The report card carries the durability verdicts from its next refresh.'); return; }
        if(j&&j.note){ line('\u23f3 '+j.note+' \u2014 step '+round); setTimeout(function(){step(round+1);},250); return; }
        b.disabled=false; line('Unexpected reply: '+JSON.stringify(j));
      })
      .catch(function(e){ b.disabled=false; line('Error: '+e+' \u2014 press again to resume; progress is saved.'); });
  }
  b.onclick=function(){ b.disabled=true; line('Starting\u2026'); step(1); };
  rb.onclick=function(){
    var k=K(); if(!k){ line('Type your admin password first.'); return; }
    fetch('/admin/era-build?reset=1',{headers:{'X-Insight-Admin':k}}).then(function(r){return r.json();})
      .then(function(j){ line((j&&j.note)||JSON.stringify(j)); }).catch(function(e){ line('Error: '+e); });
  };
})();
</script>
<div style="margin-top:18px;padding:12px;border:1px solid #a33;border-radius:8px;">
  <h2 style="margin:0 0 6px;font-size:14px;">\ud83c\uddfa\ud83c\uddf8 Retire NYSE</h2>
  <p style="font-size:12px;line-height:1.5;margin:0 0 8px;">This server now concentrates on the ASX. <b>Step 1:</b> download EVERY NYSE month from the pantry export list above and keep the files \u2014 they are your only way back without re-crawling. <b>Step 2:</b> type <code>NYSE-DELETE</code> below and press the button; it deletes in chunks, so keep pressing until it says retired. After that, NYSE requests answer an honest \u201cno longer served\u201d message.</p>
  <input id="nyc" placeholder="type NYSE-DELETE to arm" style="width:220px;padding:6px;">
  <button id="nyGo" style="padding:6px 12px;">\ud83d\uddd1 Delete NYSE from the server</button>
  <div id="nyOut" style="font-size:12px;margin-top:8px;white-space:pre-wrap;"></div>
</div>
<script>
(function(){
  var b=document.getElementById('nyGo'), o=document.getElementById('nyOut');
  function line(t){ o.textContent=t; }
  b.onclick=function(){
    var k=K(); if(!k){ line('Type your admin password first (top of the page).'); return; }
    var c=(document.getElementById('nyc').value||'').trim();
    if(c!=='NYSE-DELETE'){ line('Type NYSE-DELETE exactly \u2014 this is the one action on this page that cannot be undone without your snapshot files.'); return; }
    b.disabled=true; line('Deleting\u2026 chunked; this may take several presses.');
    fetch('/admin/nyse-retire?confirm=NYSE-DELETE',{method:'POST',headers:{'X-Insight-Admin':k}})
      .then(function(r){return r.json();})
      .then(function(j){
        b.disabled=false;
        if(j&&j.retired){ line('\u2705 NYSE retired. '+(j.note||'')); }
        else if(j&&j.remaining){ line('Deleted '+(j.deletedThisCall||0)+' rows this press. Remaining \u2014 bars: '+j.remaining.bars+' \u00b7 tech52: '+j.remaining.tech52+' \u00b7 news: '+j.remaining.news+' \u00b7 watch: '+j.remaining.news_watch+'. Press again.'); }
        else { line('Unexpected reply: '+JSON.stringify(j)); }
      })
      .catch(function(e){ b.disabled=false; line('Error: '+e); });
  };
})();
</script>
</body></html>`;

const NEW_RULES_REPORT_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>New-Rules Daily Picks — Insight Trading</title>
<style>
 body{background:#0d1526;color:#e8ecf5;font-family:-apple-system,Segoe UI,Arial,sans-serif;margin:0;padding:18px;max-width:760px}
 h1{font-size:19px;margin:4px 0 2px}
 .sub{color:#8b96ad;font-size:13px;margin-bottom:16px}
 .row{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
 input[type=password]{background:#182642;border:1px solid #2c3b5c;color:#fff;border-radius:8px;padding:9px 11px;font-size:14px;flex:1;min-width:140px}
 button{background:#1F9E8C;color:#fff;border:none;border-radius:8px;padding:9px 14px;font-size:14px;font-weight:600;cursor:pointer}
 button.secondary{background:#2c3b5c}
 button.buy{background:#D9A441;color:#1a1200}
 button:disabled{opacity:.5;cursor:default}
 .card{background:#141f38;border:1px solid #223052;border-radius:10px;padding:14px;margin-bottom:10px}
 .tk{font-size:16px;font-weight:700}
 .meta{color:#8b96ad;font-size:12.5px;margin-top:2px}
 .prices{display:flex;gap:16px;margin-top:10px;font-size:13px}
 .prices div b{display:block;font-size:15px}
 .status{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;margin-left:8px;vertical-align:middle}
 .st-suggested{background:#1F9E8C33;color:#4fd6c0}
 .st-queued{background:#D9A44133;color:#e8bf6e}
 .st-dismissed{background:#8892a633;color:#8b96ad}
 .msg{font-size:13px;color:#8b96ad;margin:10px 0;white-space:pre-wrap}
 .note{background:#182642;border-left:3px solid #1F9E8C;padding:10px 12px;font-size:12.5px;color:#b7bfd2;border-radius:6px;margin-bottom:16px}
 .empty{color:#8b96ad;font-size:14px;padding:20px 0;text-align:center}
</style></head><body>
<h1 id="hd">New-Rules Daily Picks</h1>
<div class="sub" id="sub">15% target \u00b7 15% stop \u00b7 -5% dip entry \u00b7 score 7+ \u00b7 top 4/day \u00b7 once-ever \u00b7 $500/order</div><div class="note" id="bandNote" style="border-left-color:#D9A441">Loading the current rules\u2026</div>
<div class="note">Buy queues the order into the same bridge_queue the app's own buy flow uses. The local bridge is still in DRY_RUN / per-order-approve mode per the go-live plan — nothing places for real until that changes, and every existing cap and the stop rule still apply.</div>
<div class="row">
 <input type="password" id="k" placeholder="Admin key">
 <button id="load">Load picks</button>
 <button id="runnow" class="secondary">Run selection now</button>
<button class="secondary" id="clrOob" title="Delete suggested picks outside the current price band. Queued picks are never touched.">🧹 Clear out-of-band</button><button class="secondary" id="clrAll" title="Delete every suggested pick so the list rebuilds under the current rules. Queued picks are never touched.">🧹 Clear all suggested</button><button class="secondary" id="clrEvery" style="background:#5c2c3b" title="Removes EVERY pick record including queued ones, so the list rebuilds from scratch under the current rules. Does not cancel anything already sent to the bridge.">🧹 Clear everything (incl. queued)</button></div>
  <div class="row" style="margin-top:10px;border-top:1px solid #345;padding-top:10px">
    <b style="font-size:12px">💰 Picks parcel size (w525)</b>
    <div style="font-size:11px;color:#8fa0b8;margin:4px 0 6px">How many dollars each 🎯 Today\'s picks suggestion is sized at, for the two evidence lanes. Your own bot lane uses the amount saved in 📐 My Rules instead. This changes suggestions only \u2014 the bridge\'s hard caps in .env still gate anything real, and are deliberately not editable from here.</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <span style="font-size:12px">$</span><input id="paAmt" type="number" min="100" max="5000" step="50" style="width:110px">
      <button class="secondary" id="paSave">Save</button>
      <span id="paNow" style="font-size:11px;color:#8fa0b8"></span>
    </div>
  </div>
  <div class="row" style="margin-top:10px;border-top:1px solid #345;padding-top:10px">
    <b style="font-size:12px">🔑 Trial keys (w524)</b>
    <div style="font-size:11px;color:#8fa0b8;margin:4px 0 6px">Give someone a code for a set number of days. Your own password is unaffected: it never expires and has no device limit. Two devices per code is one person\'s honest footprint (phone + laptop) \u2014 a shared code spends the sharer\'s own second slot.</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <input id="tkName" placeholder="who is it for, e.g. Dave from golf" style="flex:1;min-width:160px">
      <select id="tkDays"><option value="7">7 days</option><option value="14">14 days</option><option value="30" selected>30 days</option><option value="60">60 days</option><option value="90">90 days</option></select>
      <select id="tkDev"><option value="1">1 device</option><option value="2" selected>2 devices</option><option value="3">3 devices</option></select>
      <button class="secondary" id="tkNew">Create trial</button>
      <button class="secondary" id="tkList">Refresh list</button>
    </div>
    <div id="tkOut" style="margin-top:8px"></div>
  </div>
  <div class="row" style="margin-top:10px;border-top:1px solid #345;padding-top:10px">
    <b style="font-size:12px">🪜 Trail basis A/B (w539)</b>
    <div style="font-size:11px;color:#8fa0b8;margin:4px 0 6px">Runs the same picks twice — the trailing stop ratcheting on CLOSES (what ships) versus on the day’s HIGH (what a broker’s trailing stop follows). Same entry, same intraday trigger, same $3 a side. Takes a minute or two.</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <select id="tbWeeks"><option value="520">10 years</option><option value="400" selected>8 years</option><option value="260">5 years</option><option value="156">3 years</option></select>
      <select id="tbTrail"><option value="20" selected>20% trail</option><option value="15">15% trail</option><option value="10">10% trail</option><option value="8">8% trail</option></select>
      <button class="secondary" id="tbRun">Run trail basis test</button>
    </div>
    <div id="tbOut" style="margin-top:8px;font-size:11px"></div>
  </div>
  <div class="row" style="margin-top:10px;border-top:1px solid #345;padding-top:10px">
    <b style="font-size:12px">🗄 Ten-year tools (w512)</b>
    <button class="secondary" id="bfRun">Backfill 10y history</button>
    <button class="secondary" id="stRun">Run decade gate study</button>
    <button class="secondary" id="stRead">Read study result</button>
    <button class="secondary" id="srRun">Run decade strategy tests</button>
    <button class="secondary" id="srRead">Read strategy result</button>
    <button class="secondary" id="dgRun">Grade decade (4 presses)</button>
    <button class="secondary" id="dgRead">Read decade grades</button>
    <button class="secondary" id="psRun">Run decade portfolio sim</button>
    <button class="secondary" id="psRead">Read portfolio sim</button>
    <span id="w512msg" style="font-size:11px;color:#9ab"></span>
  </div>
  <div class="row" style="margin-top:10px;border-top:1px solid #345;padding-top:10px">
    <b style="font-size:12px">🧮 Server grading (w528)</b>
    <button class="secondary" id="sgRun">Grade all shares now</button>
    <button class="secondary" id="sgStat">Grading status</button>
    <span id="w528msg" style="font-size:11px;color:#9ab"></span>
  </div>
  <script>
  (function(){
    var busy=false;
    function key(){ return document.getElementById('k').value||''; }
    function msg(t){ document.getElementById('w512msg').textContent=t; }
    async function loop(path, reset, label){
      if(busy){ msg('already running'); return; } busy=true;
      try{
        if(reset){ await fetch(path+'&reset=1',{method:'POST',headers:{'X-Insight-Admin':key()}}); }
        for(var i=0;i<3000;i++){
          var r=await fetch(path,{method:'POST',headers:{'X-Insight-Admin':key()}});
          if(r.status===401){ msg('admin key?'); busy=false; return; }
          var j=await r.json();
          if(j.error){ msg('error: '+j.error); busy=false; return; }
          msg(label+' '+(j.phase?('['+j.phase+'] '):'')+(j.cursor!=null?(j.cursor+'/'+j.total):'')+(j.bars!=null?(' · +'+j.bars+' bars'):''));
          if(j.done){ msg(label+' ✓ complete'+(j.testEvents?(' · '+j.testEvents+' test events'):'')); busy=false; return; }
          await new Promise(function(z){setTimeout(z,400);});
        }
      }catch(e){ msg('failed: '+e); }
      busy=false;
    }
    document.getElementById('tbRun').onclick=function(){
      var o=document.getElementById('tbOut');
      // w540: this page's helper is key(), not K() \u2014 and every failure reports
      // into THIS box, so a broken button can never again look like a dead one.
      var k=''; try{ k=(typeof key==='function')?key():''; }catch(e){}
      if(!k){ o.innerHTML='<span style=\"color:#ff9caa\">Type your admin password in the box at the top of this page first.</span>'; return; }
      var w=document.getElementById('tbWeeks').value, tr=document.getElementById('tbTrail').value;
      o.innerHTML='<span style="color:#e8c34a">Running both bases over '+w+' weeks \u2014 this takes a minute or two\u2026</span>';
      fetch('/admin/trailbasis?weeks='+w+'&trail='+tr+'&maxBars=2700',{headers:{'X-Insight-Admin':k}})
        .then(function(r){return r.json();})
        .then(function(j){
          if(j.error){ o.innerHTML='<span style="color:#ff9caa">'+j.error+'</span>'; return; }
          if(!j.close&&!j.high){ o.innerHTML='<span style="color:#ff9caa">unexpected answer: '+JSON.stringify(j).slice(0,300)+'</span>'; return; }
          var row=function(lbl,x){ return (x&&x.error)
            ? '<tr><td>'+lbl+'</td><td colspan="5" style="color:#ff9caa">'+x.error+'</td></tr>'
            : '<tr><td>'+lbl+'</td><td><b>'+x.returnPct+'%</b></td><td>'+x.trades+'</td><td>'+x.winRate+'%</td><td>'+(x.avgHeldDays==null?'\u2014':x.avgHeldDays)+'</td><td>'+(x.costShareOfGrossPct==null?'\u2014':x.costShareOfGrossPct+'%')+'</td></tr>'; };
          o.innerHTML='<div style="color:#8fa0b8">window '+(j.window?(j.window.from+' \u2192 '+j.window.to+' \u00b7 '+j.window.barsLoaded+' trading days'):'?')+' \u00b7 universe '+j.universe+'</div>'
            +'<table style="width:100%;margin-top:6px;font-size:11px"><tr style="color:#8fa0b8"><th align="left">basis</th><th align="left">return</th><th align="left">trades</th><th align="left">win rate</th><th align="left">avg held</th><th align="left">cost share</th></tr>'
            +row('closes (ships)',j.close)+row('highs',j.high)+'</table>'
            +'<div style="margin-top:6px;font-weight:700">'+j.verdict+'</div>';
        })
        .catch(function(e){ o.innerHTML='<span style="color:#ff9caa">Failed: '+e+'</span>'; });
    };
    document.getElementById('bfRun').onclick=function(){ if(confirm('Pull ~10 years of adjusted history for every pantry ticker from EODHD? Resumable; ~25-40 min.')) loop('/admin/eodhd/backfill?exch=ASX',false,'backfill'); };
    function msg8(t){ document.getElementById('w528msg').textContent=t; }
    document.getElementById('sgRun').onclick=async function(){
      if(!confirm('Grade every pantry share with the app\u2019s exact maths? Resumable; ~1-2 min.'))return;
      if(busy){ msg8('another tool is running'); return; } busy=true;
      try{
        for(var i=0;i<3000;i++){
          var r=await fetch('/admin/grade/step?exch=ASX',{method:'POST',headers:{'X-Insight-Admin':key()}});
          if(r.status===401){ msg8('admin key?'); busy=false; return; }
          var j=await r.json();
          if(j.error){ msg8('error: '+j.error); busy=false; return; }
          msg8('grading '+j.cursor+'/'+j.total+(j.graded!=null?(' \u00b7 +'+j.graded):''));
          if(j.done){ msg8('\u2713 graded \u00b7 day '+j.day); busy=false; return; }
          await new Promise(function(z){setTimeout(z,300);});
        }
      }catch(e){ msg8('failed: '+e); }
      busy=false;
    };
    document.getElementById('sgStat').onclick=async function(){
      var r=await fetch('/grades/status?exch=ASX',{headers:{'X-Insight-Admin':key(),'X-Insight-Access':key()}});
      var j=await r.json();
      if(!j.ok){ msg8('error: '+(j.error||('http '+r.status))); return; }
      msg8((j.day?('day '+j.day+' \u00b7 '+j.graded+' graded'):'no grades yet')+' \u00b7 cursor '+j.cursor+'/'+j.total);
    };
    document.getElementById('stRun').onclick=function(){ if(confirm('Run the out-of-sample decade gate study? Two passes; ~10-20 min.')) loop('/admin/study/gate/step?exch=ASX',true,'study'); };
    document.getElementById('srRun').onclick=function(){ if(confirm('Race bands \u00d7 exits \u00d7 entries over the full decade? ~15-25 min.')) loop('/admin/study/strat/step?exch=ASX',true,'strategies'); };
    document.getElementById('psRun').onclick=function(){ if(confirm('Replay the $50k / 10-slot portfolio through ten years (3 recipes on identical picks)? 5 chunks, ~2 min each.')) loop('/admin/sim/decade/step?exch=ASX',true,'portfolio sim'); };
    document.getElementById('psRead').onclick=async function(){
     try{
      var r=await fetch('/sim/decade?exch=ASX',{headers:{'X-Insight-Admin':key()}});
      if(r.status===401){ msg('admin key?'); return; }
      var j=await r.json(); if(!j.ok){ msg(j.empty?'no sim yet':'error'); return; }
      var t=(j.done?'':'(in progress '+j.chunks+'/5) ');
      j.portfolios.forEach(function(P){ t+=P.name+': '+(P.equity!=null?('$'+P.equity.toLocaleString()+' ('+(P.returnPct>=0?'+':'')+P.returnPct+'%)'):'running')+' · '+P.closedTrades+' closed ('+P.stillOpen+' open) · won '+P.winRate+'% · top-3 hold '+P.top3NetPctSum+'% of net  ||  '; });
      msg(t);
     }catch(e){ msg('read failed: '+e); }
    };
    var _dgPart=1;
    document.getElementById('dgRun').onclick=async function(){
     try{
      if(_dgPart>4){ msg('all four quarters done — press Read decade grades'); return; }
      msg('grading decade — quarter '+_dgPart+' of 4 (60–120s, leave the page open)…');
      var r=await fetch('/admin/grades/decade?exch=ASX&hold=10&part='+_dgPart,{method:'POST',headers:{'X-Insight-Admin':key()}});
      if(r.status===401){ msg('admin key?'); return; }
      var j=await r.json();
      if(!j.ok){ msg('error: '+(j.error||'failed')+' — quarter '+_dgPart); return; }
      msg('quarter '+_dgPart+' ✓ ('+j.shares+' shares graded over the decade). '+(j.note||''));
      _dgPart++;
     }catch(e){ msg('quarter '+_dgPart+' failed: '+e+' — press again to retry'); }
    };
    document.getElementById('dgRead').onclick=async function(){
     try{
      var r=await fetch('/grades/decade?exch=ASX&hold=10',{headers:{'X-Insight-Admin':key()}});
      if(r.status===401){ msg('admin key?'); return; }
      var j=await r.json(); if(!j.ok){ msg(j.empty?'no decade grades yet':'error'); return; }
      var agg={};
      j.parts.forEach(function(P){ var rowsA=(P.A&&(P.A.rows||P.A.table||P.A.lines))||null;
        if(!rowsA && P.A){ Object.keys(P.A).forEach(function(k){ var v=P.A[k]; if(v&&typeof v==='object'&&v.tier){ (agg[k]=agg[k]||[]).push(v.tier); } }); }
        if(Array.isArray(rowsA)){ rowsA.forEach(function(rw){ var k=rw.key||rw.sig||rw.name; if(k&&rw.tier)(agg[k]=agg[k]||[]).push(rw.tier); }); } });
      var ks=Object.keys(agg); 
      if(!ks.length){ msg('decade grades stored ('+j.partsStored+'/4 quarters) — table shape needs the app to render; raw JSON at /grades/decade'); return; }
      var t='decade ('+j.partsStored+'/4 quarters) — keys earning a tier in ALL stored quarters: ';
      var solid=ks.filter(function(k){ return agg[k].length===j.partsStored && agg[k].every(function(x){return /SOLID|PROVEN/i.test(x)&&!/TOO SMALL/i.test(x);}); });
      t+= solid.length? solid.slice(0,20).join(', ') : '(none met the bar in every quarter)';
      msg(t);
     }catch(e){ msg('read failed: '+e); }
    };
    document.getElementById('srRead').onclick=async function(){
     try{
      var r=await fetch('/study/strat?exch=ASX',{headers:{'X-Insight-Admin':key()}});
      if(r.status===401){ msg('admin key?'); return; }
      var j=await r.json(); if(!j.ok){ msg(j.empty?'no strategy study yet':'error'); return; }
      var ks=Object.keys(j.cells).sort(); var t=(j.done?'':'(in progress) ');
      ks.forEach(function(k){ var c=j.cells[k]; t+=k+': '+c.trades+' trades, avg '+(c.avgNet>=0?'+':'')+c.avgNet+'%, won '+c.won+'%  |  '; });
      msg(t);
     }catch(e){ msg('read failed: '+e); }
    };
    document.getElementById('stRead').onclick=async function(){
     try{
      var r=await fetch('/study/gate?exch=ASX',{headers:{'X-Insight-Admin':key()}});
      if(r.status===401){ msg('admin key?'); return; }
      var j=await r.json();
      if(!j.ok){ msg(j.empty?'no study yet':'error'); return; }
      var g=j.gates; var f=function(x){return x==null?'–':((x>=0?'+':'')+x.toFixed(2)+'%');};
      msg((j.done?'':'(in progress) ')+'baseline '+f(j.baseline)+' | \u226550: '+g.g50.events+' ev, lift '+f(g.g50.lift)+' | \u226560: '+g.g60.events+' ev, lift '+f(g.g60.lift)+' | \u226570: '+g.g70.events+' ev, lift '+f(g.g70.lift));
     }catch(e){ msg('read failed: '+e); }
    };
  })();
  </script>
<div id="result" class="msg" style="white-space:pre-wrap;color:#c9d4f2"></div>\n<div id="msg" class="msg"></div>
<div id="list"></div>
<script>
(function(){
 // w495 — one page, two rule sets. ?mode=trail shows the 20% trailing set;
 // the default shows the 15/15 control. Same signals, same band, same entry —
 // the exits are the only difference, which is what makes the comparison fair.
 var _MODE=(location.search.indexOf('mode=mine')>=0)?'mine':(location.search.indexOf('mode=trail')>=0)?'trail':'fixed'; // w506: the mine lane exists now - without this every clear posted modeless and deleted from the wrong table
  function paLoad(){
   fetch('/admin/picks-amount', { headers: { 'X-Insight-Admin': K() } }).then(function(r){return r.json();}).then(function(d){
     if(d.error){ return; }
     var i=document.getElementById('paAmt'), n=document.getElementById('paNow');
     if(i) i.value = d.amount;
     if(n) n.textContent = d.isDefault ? 'currently the built-in default' : 'currently set';
   });
 }
 (function(){
   var b=document.getElementById('paSave');
   if(b) b.onclick=function(){
     var v=document.getElementById('paAmt').value;
     fetch('/admin/picks-amount?set='+encodeURIComponent(v), { headers: { 'X-Insight-Admin': K() } })
       .then(function(r){return r.json();}).then(function(d){
         if(d.error){ alert(d.error); return; }
         document.getElementById('paNow').textContent='saved \u00b7 applies to tonight\u2019s run';
       });
   };
   if(document.getElementById('paAmt')) setTimeout(paLoad, 400);
 })();
 function tkAsk(path, qs){
   return fetch(path + (qs||''), { headers: { 'X-Insight-Admin': K() } }).then(function(r){ return r.json(); });
 }
 function tkRender(keys){
   var el = document.getElementById('tkOut'); if(!el) return;
   if(!keys || !keys.length){ el.innerHTML = '<div style="font-size:11px;color:#8fa0b8">No trial keys yet.</div>'; return; }
   var h = '<table style="width:100%;border-collapse:collapse;font-size:11px"><tr style="color:#8fa0b8;text-align:left"><th>Who</th><th>Code</th><th>Days left</th><th>Devices</th><th>Last seen</th><th></th></tr>';
   for(var i=0;i<keys.length;i++){
     var k = keys[i];
     var dead = k.revoked || (k.daysLeft !== null && k.daysLeft <= 0);
     var days = k.revoked ? 'revoked' : (k.daysLeft === null ? '\u2014' : (k.daysLeft <= 0 ? 'ended' : k.daysLeft + 'd'));
     var seen = k.lastSeen ? (new Date(k.lastSeen).toLocaleDateString() + (k.lastCity ? ' \u00b7 ' + k.lastCity : '')) : 'never opened';
     h += '<tr style="border-top:1px solid #234' + (dead ? ';opacity:.55' : '') + '"><td>' + (k.label||'') + '</td><td><code style="font-size:11px">' + k.code + '</code></td><td style="color:' + (dead ? '#c4566a' : (k.daysLeft !== null && k.daysLeft <= 5 ? '#e8a33d' : '#3fb8a6')) + '">' + days + '</td><td>' + k.devices + '/' + k.maxDevices + '</td><td style="color:#8fa0b8">' + seen + '</td><td style="white-space:nowrap"><button class="secondary tkA" data-a="extend" data-c="' + k.code + '">+30d</button> <button class="secondary tkA" data-a="' + (k.revoked ? 'restore' : 'revoke') + '" data-c="' + k.code + '">' + (k.revoked ? 'Restore' : 'Revoke') + '</button> <button class="secondary tkA" data-a="reset-devices" data-c="' + k.code + '">Reset devices</button></td></tr>';
   }
   el.innerHTML = h + '</table>';
   var bs = el.querySelectorAll('.tkA');
   for(var j=0;j<bs.length;j++){
     bs[j].onclick = function(){
       var a = this.getAttribute('data-a'), c = this.getAttribute('data-c');
       if(a === 'revoke' && !confirm('Revoke ' + c + '? They lose access on their next request.')) return;
       tkAsk('/admin/keys/' + a, '?code=' + encodeURIComponent(c) + (a === 'extend' ? '&days=30' : ''))
         .then(function(){ return tkAsk('/admin/keys'); }).then(function(d){ tkRender(d.keys); });
     };
   }
 }
 (function(){
   var bN = document.getElementById('tkNew'), bL = document.getElementById('tkList');
   if(bN) bN.onclick = function(){
     var nm = document.getElementById('tkName').value.trim();
     if(!nm){ alert('Put a name on it \u2014 future you will want to know whose code this is.'); return; }
     tkAsk('/admin/keys/create', '?label=' + encodeURIComponent(nm) + '&days=' + document.getElementById('tkDays').value + '&devices=' + document.getElementById('tkDev').value)
       .then(function(d){
         if(d.error){ alert(d.error); return; }
         document.getElementById('tkName').value = '';
         alert('Code for ' + nm + ':\\n\\n' + d.code + '\\n\\nSend them this code and the app link. It works for ' + Math.round((new Date(d.expires) - Date.now()) / 86400000) + ' days on up to ' + d.max_devices + ' device(s).');
         return tkAsk('/admin/keys').then(function(l){ tkRender(l.keys); });
       });
   };
   if(bL) bL.onclick = function(){ tkAsk('/admin/keys').then(function(d){ if(d.error){ alert(d.error); return; } tkRender(d.keys); }); };
 })();
var K=function(){return document.getElementById('k').value.trim();};
 var msg=function(t){document.getElementById('msg').textContent=t||'';};
 // w486 — how far back a pick's session sits, in calendar days, against the
 // newest session in the store. Calendar rather than trading days on purpose:
 // it is a staleness cue, not an index, and over-precision here would invite
 // more trust than the number deserves.
 var _ago=function(d){
   try{
     var lb=window._latestBar; if(!lb||!d||d===lb)return '';
     var a=Date.parse(d+'T00:00:00Z'), b=Date.parse(lb+'T00:00:00Z');
     if(!isFinite(a)||!isFinite(b)||b<=a)return '';
     var n=Math.round((b-a)/86400000);
     return ' <span style="color:#e8bf6e">('+n+' day'+(n===1?'':'s')+' before the latest session)</span>';
   }catch(e){ return ''; }
 };
 // w485 — a badge for rows the CURRENT rules would never have produced.
 var _oob=function(row){
   try{
     var c=window._cfg||{};
     if(c.minPrice==null)return '';   // w488: show it on queued rows too — a wrong price is worth seeing whatever the status
     if(row.ref_close>c.minPrice&&row.ref_close<=c.maxPrice)return '';
     return '<span class="status" style="background:#e2193733;color:#ff9caa">outside $'+c.minPrice+'-$'+c.maxPrice+'</span>';
   }catch(e){ return ''; }
 };
 var call=function(path,opts,cb){
  var k=K(); if(!k){msg('Type the admin key first.');return;}
  opts=opts||{};
  var headers=Object.assign({'X-Insight-Admin':k},opts.headers||{});
  fetch(path,Object.assign({},opts,{headers:headers}))
   .then(function(r){return r.json().then(function(j){return {s:r.status,j:j};});})
   .then(function(r){ if(r.s!==200&&r.s!==400&&r.s!==404&&r.s!==409){msg((r.j&&r.j.error)||('error '+r.s));return;} cb(r.j,r.s); })
   .catch(function(e){msg('Could not reach the server: '+e);});
 };
 var fmt=function(n){return '$'+(+n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:4});};
 var render=function(j){
  // w485 — say which rules are live, and mark rows the CURRENT rules would never
  // have produced. The table dedups once-per-ticker-ever, so a pick written
  // under older settings stays forever; showing it unmarked next to a fresh one
  // is how a stale $2.19 name reads as a current suggestion.
  try{
    window._cfg=(j&&j.config)||{}; window._cfg._mode=(j&&j.mode)||'fixed'; window._cfg._trailPct=(j&&j.trailPct)||20; window._latestBar=(j&&j.latestBar)||null;
    var cf=window._cfg, nb=document.getElementById('bandNote'), sb=document.getElementById('sub');
    var hd=document.getElementById('hd');
    if(hd) hd.textContent=(j.mode==='trail')?'Trailing-Rules Daily Picks':'New-Rules Daily Picks';
    if(sb&&j.mode==='trail'){
      sb.textContent=(j.trailPct||20)+'% TRAILING stop \u00b7 no take-profit \u00b7 -'+cf.dipPct+'% dip entry \u00b7 score '+cf.minScore+'+ \u00b7 top '+cf.topN+'/day \u00b7 once-ever \u00b7 $'+(cf.amount||500)+'/order';
    } else if(sb&&cf.targetPct!=null) sb.textContent=cf.targetPct+'% target \u00b7 '+cf.stopPct+'% stop \u00b7 -'+cf.dipPct+'% dip entry \u00b7 score '+cf.minScore+'+ \u00b7 top '+cf.topN+'/day \u00b7 once-ever \u00b7 $'+(cf.amount||500)+'/order';
    if(nb){
      var bandTxt=(cf.minPrice!=null&&cf.maxPrice!=null)?('$'+cf.minPrice+' \u2013 $'+cf.maxPrice):'no price band set';
      var vTxt=(j&&j.workerV)?('worker w'+j.workerV):'worker version unknown \u2014 the pasted build is older than this page';
      var oob=(j.rows||[]).filter(function(r){ return r.status==='suggested' && cf.minPrice!=null && !(r.ref_close>cf.minPrice && r.ref_close<=cf.maxPrice); }).length;
      var dl='';
      if(j.latestBar){
        dl='<br><b>Latest session in the store: '+j.latestBar+'</b>';
        if(j.latestPick){
          dl+=' \u00b7 newest pick made on '+j.latestPick;
          if(j.stale) dl+=' \u2014 \u26a0 that is BEHIND the latest session. Press \u201cRun selection now\u201d; if it stays behind, the daily run is not reaching the newest bars.';
          else dl+=' \u2014 up to date.';
        } else dl+=' \u00b7 no picks stored yet.';
      } else dl='<br>\u26a0 Could not read the store\u2019s latest session.';
      var swap=(j.mode==='trail')
        ? '<br><a href="?" style="color:#7fd4ff">\u2194 switch to the 15/15 control set</a>'
        : '<br><a href="?mode=trail" style="color:#7fd4ff">\u2194 switch to the 20% trailing set</a>';
      var trailNote=(j.mode==='trail')
        ? '<br><span style="color:#e8bf6e">The stop shown is the STARTING trail level, 20% under the limit. It only ever ratchets UP as the price rises \u2014 it is not a fixed line, and there is no take-profit. The app manages it once you hold.</span>'
        : '';
      nb.innerHTML='<b>Price band in force: '+bandTxt+'</b> <span style="color:#8b96ad">('+vTxt+')</span>'+dl+trailNote+swap
        + (oob? ('<br>\u26a0 '+oob+' suggestion'+(oob===1?'':'s')+' below were picked under older rules and fall OUTSIDE this band \u2014 they are marked and will never be re-picked. Use \u201cClear out-of-band\u201d to remove them.') : '<br>Every suggestion below is inside the band.');
    }
  }catch(e){}
  var list=document.getElementById('list'); list.innerHTML='';
  if(!j.rows||!j.rows.length){ list.innerHTML='<div class="empty">No picks yet. Press \\'Run selection now\\' to check today, or wait for the next scheduled run.</div>'; return; }
  j.rows.forEach(function(row){
   var div=document.createElement('div'); div.className='card';
   var statusClass='st-'+row.status;
   var buyBtn = row.status==='suggested' ? '<button class="buy" data-ticker="'+row.ticker+'">Queue buy</button>' : '';
   div.innerHTML =
    '<div class="tk">'+row.ticker+'<span class="status '+statusClass+'">'+row.status+'</span>'+_oob(row)+'</div>'+
    '<div class="meta">Picked '+row.first_seen_day+_ago(row.first_seen_day)+' \\u00b7 '+row.evidence_key+' ('+row.tier+', score '+(+row.score).toFixed(1)+', edge '+(row.edge>=0?'+':'')+(+row.edge).toFixed(2)+')</div>'+
    '<div class="prices">'+
     '<div>Limit<b>'+fmt(row.limit_price)+'</b></div>'+
     (((row.trail_pct!=null&&+row.trail_pct>0)||(window._cfg&&window._cfg._mode==='trail'))
       ? ('<div>Trail<b>'+((row.trail_pct!=null&&+row.trail_pct>0?+row.trail_pct:(window._cfg._trailPct||20))+'%')+'</b></div>'+
          '<div>Starting stop<b>'+fmt(row.initial_stop!=null?row.initial_stop:row.stop_price)+'</b></div>')
       : ('<div>Target<b>'+fmt(row.target_price)+'</b></div>'+
          '<div>Stop<b>'+fmt(row.stop_price)+'</b></div>'))+
     '<div>Qty<b>'+row.qty+'</b></div>'+
     '<div>Order size<b>'+fmt(row.qty*row.limit_price)+'</b></div>'+
    '</div>'+
    '<div style="margin-top:10px">'+buyBtn+'</div>';
   list.appendChild(div);
  });
  list.querySelectorAll('button.buy').forEach(function(b){
   b.onclick=function(){
    var ticker=b.getAttribute('data-ticker');
    if(!confirm('Queue a BUY for '+ticker+'? This inserts into the live order queue (still dry-run/approve-mode on the bridge).'))return;
    b.disabled=true; b.textContent='Queuing…';
    call('/admin/new-rules-buy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({exch:j.exch,ticker:ticker})},function(r,s){
     if(s===200){ msg(ticker+' queued as order '+r.queued.id+'.'); load(); }
     else { msg((r&&r.error)||'could not queue'); b.disabled=false; b.textContent='Queue buy'; }
    });
   };
  });
 };
 var load=function(){
  msg('Loading…');
  call('/admin/new-rules-picks-data'+(_MODE==='trail'?'?mode=trail':''),{},function(j){ msg(''); render(j); });
 };
 document.getElementById('load').onclick=load;
 document.getElementById('runnow').onclick=function(){
  var b=document.getElementById('runnow'); b.disabled=true;
  msg('Running today\\'s selection now…');
  call('/admin/new-rules-run-now'+(_MODE==='trail'?'?mode=trail':''),{method:'POST'},function(j){
   b.disabled=false;
   if(j.ok===false||j.error){
     var RE=document.getElementById('result');
     var why=(j.error||'')+(j.detail?(' \\u2014 '+j.detail):'')||j.reason||'no result';
     if(RE)RE.textContent='\\u26a0 The run did not finish.\\n\\n'+why+'\\n\\nSend that line on \\u2014 it names the fault.';
     msg('\\u26a0 '+why); return; }
   var R=document.getElementById('result');
   if(R){
     var lines=[];
     lines.push('\\u2713 Run finished at '+new Date().toLocaleTimeString());
     lines.push('  picked from session ...... '+(j.day||'?')+(j.latestBar?(j.stale?('  \\u26a0 BEHIND the latest session '+j.latestBar):'  (the latest session)'):''));
     lines.push('  signals firing that day .. '+(j.scanned==null?'?':j.scanned));
     lines.push('  inside $0.20-$0.99 ....... '+(j.inBand==null?'?':j.inBand)+(j.outOfBand?('   ('+j.outOfBand+' priced outside it)'):''));
     lines.push('  then cleared score '+ (j.minScore||7) +'+ .... '+(j.qualifyingToday==null?'?':j.qualifyingToday));
     lines.push('  top '+(j.topN||4)+' taken ............... '+(j.suggested==null?'?':j.suggested));
     lines.push('  newly stored ............. '+(j.inserted==null?'?':j.inserted));
     if(j.healed) lines.push('  old rows tidied away ..... '+j.healed);
     if(j.inserted===0){
       if(j.scanned===0) lines.push('\\nNothing fired on that session at all. That happens \\u2014 these signals are rare.');
       else if(j.inBand===0) lines.push('\\nAll '+j.scanned+' that fired were priced outside $0.20-$0.99.');
       else if(j.qualifyingToday===0) lines.push('\\n'+j.inBand+' were in the band, but none reached score '+(j.minScore||7)+'. The gate is doing its job.');
       else lines.push('\\nAll of them were already stored, so nothing new was added.');
     }
     R.textContent=lines.join('\\n');
   }
   load();
  });
 };

 // w490 — these live INSIDE the page's IIFE now. msg(), load() and call() are
 // local to it, so the handlers defined outside threw a ReferenceError on
 // their first line and died without writing anything. Click, confirm, OK,
 // nothing — and no message, because the message function was the thing
 // that was missing. Proved by running the page script in a fake DOM and
 // clicking the button, which is now part of the test.
 function _clear(scope,label){
   // w487 — every path reports. The first version could return silently in three
   // places (no password, confirm cancelled, a reply that is not JSON), and a
   // button that does nothing and says nothing is indistinguishable from a
   // broken one — which is exactly how it was read.
   var k=(document.getElementById('k')||{}).value||'';
   if(!k){ msg('\\u26a0 Enter the admin password in the box above first, then press Clear again.'); return; }
   if(!confirm('Delete '+label+'?\\n\\nQueued picks are never touched. This cannot be undone.')){
     msg('Cancelled \\u2014 nothing was deleted.'); return; }
   msg('Clearing\\u2026');
   fetch('/admin/new-rules-clear?exch=ASX&scope='+scope+(_MODE!=='fixed'?('&mode='+_MODE):''),{method:'POST',headers:{'X-Insight-Admin':k}})
     .then(function(r){ return r.text().then(function(t){ return {status:r.status,text:t}; }); })
     .then(function(res){
       var j=null; try{ j=JSON.parse(res.text); }catch(e){}
       if(res.status===401||res.status===403){ msg('\\u26a0 The admin password was rejected (HTTP '+res.status+'). Check it and press Clear again.'); return; }
       if(!j){ msg('\\u26a0 The server replied with something that is not JSON (HTTP '+res.status+'): '+String(res.text).slice(0,180)+' \\u2014 the pasted worker may be older than this page.'); return; }
       if(j.error){ msg('\\u26a0 Could not clear (HTTP '+res.status+'): '+j.error+(j.detail?(' \\u2014 '+j.detail):'')); return; }
       if(!j.ok){ msg('\\u26a0 Could not clear (HTTP '+res.status+'): '+String(res.text).slice(0,180)); return; }
       if(j.removed===0){
         msg('Nothing was removed. Either every suggestion is already inside the band ('+(j.band||'')+'), or those rows are QUEUED rather than suggested \\u2014 queued picks became real orders and are never deleted. Use \\u201cClear all suggested\\u201d to rebuild the list from scratch.');
       } else {
         var R2=document.getElementById('result'); if(R2)R2.textContent='\\u2713 Removed '+j.removed+' pick record'+(j.removed===1?'':'s')+' at '+new Date().toLocaleTimeString()+'. Now press \\u201cRun selection now\\u201d.';
        msg('\\u2713 Removed '+j.removed+' pick record'+(j.removed===1?'':'s')+'. '+(j.note||'')+'\\n\\nNow press \\u201cRun selection now\\u201d to rebuild the list under the current rules \\u2014 the dates and prices you see will only change once a new run happens.');
       }
       load();
     }).catch(function(e){ msg('\\u26a0 The clear request itself failed: '+e+' \\u2014 check the worker you pasted is the version this page came from.'); });
 }
 try{
   document.getElementById('clrOob').onclick=function(){ _clear('outofband','every suggested pick outside the current price band'); };
   document.getElementById('clrAll').onclick=function(){ _clear('all','EVERY suggested pick, so the list rebuilds under the current rules'); };
   document.getElementById('clrEvery').onclick=function(){ _clear('everything','EVERY pick record INCLUDING queued ones.\\n\\nThis does NOT cancel any order already sent to the bridge — it only forgets that these tickers were picked, so they can be picked again under the current rules'); };
 }catch(e){}
})();
</script>
</body></html>`;

// ═══ w392 SECURITY HELPERS ════════════════════════════════════════════════

// ── Rate limiting ─────────────────────────────────────────────────────────
// The gate was a free oracle: unauthenticated, no database, clean 200/401, no
// limit of any kind. Against one shared human-chosen password that was the
// likeliest way this system actually gets taken. A D1 counter per IP is not
// elegant but it is the thing that was missing.
//
// It deliberately fails OPEN. A counter that cannot be read must not be able to
// lock paying customers out of their own product.
let _rlReady = false;
async function _rlInit(env){
  if(_rlReady || !env.MARKET_DB)return;
  try{ await env.MARKET_DB.prepare('CREATE TABLE IF NOT EXISTS rl (k TEXT PRIMARY KEY, n INTEGER, exp INTEGER)').run(); _rlReady = true; }catch(e){}
}
function _ip(request){ return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'; }
// Returns true when the caller is OVER the limit.
async function _rlOver(env, key, limit, windowSec){
  if(!env.MARKET_DB)return false;
  try{
    await _rlInit(env);
    const now = Math.floor(Date.now()/1000);
    const row = await env.MARKET_DB.prepare('SELECT n,exp FROM rl WHERE k=?').bind(key).first();
    if(row && row.exp > now){
      if(row.n >= limit)return true;
      await env.MARKET_DB.prepare('UPDATE rl SET n=n+1 WHERE k=?').bind(key).run();
      return false;
    }
    await env.MARKET_DB.prepare(
      'INSERT INTO rl (k,n,exp) VALUES (?,1,?) ON CONFLICT(k) DO UPDATE SET n=1,exp=excluded.exp'
    ).bind(key, now + windowSec).run();
    return false;
  }catch(e){ return false; }
}

// ── Admin, with its own credential ────────────────────────────────────────
// Previously these routes checked ACCESS_KEY — the password every customer is
// given — so every customer could empty the news store and drain the paid
// EODData quota. If ADMIN_KEY is not set the routes are OFF, not open: the bug
// being fixed is exactly "the weaker credential opened the stronger door".
// ── w406: NYSE retirement ─────────────────────────────────────────────────
// Ingest stops at paste (NYSE_RETIRED above the scheduler). Serving keeps
// answering until /admin/nyse-retire has deleted the rows — the snapshot
// must be downloadable first — then the nyse_retired meta flag flips every
// NYSE route to an honest 410. Cached per isolate; retirement is one-way.
const NYSE_RETIRED = true;
let _NYSE_OFF_CACHE;
const _NYSE_GONE_MSG = { error: 'NYSE is no longer served from this server',
  hint: 'This server now concentrates on the ASX. To use NYSE, enter your own data key in the app (\u2699 Setup & data) and load it directly from the provider.' };
async function _nyseOffFlag(env){
  if (_NYSE_OFF_CACHE !== undefined) return _NYSE_OFF_CACHE;
  let off = false; try { off = !!(await _getMeta(env, 'nyse_retired')); } catch (e) {}
  _NYSE_OFF_CACHE = off; return off;
}
async function _nyseGate(env, ex, origin){
  const E = String(ex || '').toUpperCase();
  if (E !== 'NYSE' && E !== 'NASDAQ' && E !== 'AMEX') return null;
  if (!(await _nyseOffFlag(env))) return null;
  return json(_NYSE_GONE_MSG, 410, origin);
}

function adminAuth(request, env){
  if(!env.ADMIN_KEY)return { status: 403, body: { error: 'admin is disabled until the ADMIN_KEY secret is set' } };
  const sent = request.headers.get('X-Insight-Admin') || '';
  if(!_ctEq(sent, String(env.ADMIN_KEY)))return { status: 401, body: { error: 'bad admin key' } };
  return null;
}

// ── Request bounds ────────────────────────────────────────────────────────
// Checked BEFORE the body is read, because the damage is done by parsing it.
const _MAX_BODY_BYTES = 48 * 1024 * 1024;   // a full-ASX replay measures ~42 MB
const _MAX_SHARES     = 9000;               // ASX + NYSE together is ~7,600
const _MAX_BARS       = 2000;               // ~8 years of daily bars
function _bodyTooBig(request){
  const n = parseInt(request.headers.get('Content-Length') || '0', 10);
  return (isFinite(n) && n > _MAX_BODY_BYTES);
}
// Cap the shares AND the bars inside them. One share with two million bars was
// enough to add 116 MB against a 128 MB isolate limit.
function _capShares(shares){
  const out = [];
  for(let i = 0; i < shares.length && out.length < _MAX_SHARES; i++){
    const s = shares[i];
    if(!s || !Array.isArray(s.series))continue;
    if(s.series.length > _MAX_BARS)s.series = s.series.slice(-_MAX_BARS);
    out.push(s);
  }
  return out;
}

// ── Cache keys that describe what was actually computed ───────────────────
// Every part of the old key came from the caller's own body, and nothing tied
// the stored answer to the payload that produced it — so one customer could
// decide the graded evidence table every other customer saw for twenty hours.
// A fingerprint of the shares themselves closes that.
//
// It must cover the PRICES, not just the shape. My first version hashed only
// tickers, dates and lengths — and a fabricated market with the same tickers
// over the same dates collided with the real one, which is exactly the attack.
// Numbers are mixed arithmetically rather than via strings, so hashing a full
// 42 MB payload costs single-digit milliseconds.
function _fingerprint(shares){
  let h = 0x811c9dc5;
  const mixNum = (n) => { h = ((h ^ (n | 0)) * 0x01000193) >>> 0; };
  const mixStr = (str) => { for(let i = 0; i < str.length; i++){ h = ((h ^ str.charCodeAt(i)) * 0x01000193) >>> 0; } };
  mixNum(shares.length); mixStr('#');
  for(const s of shares){
    const ser = (s && s.series) || [];
    mixStr(String((s && s.ticker) || '')); mixNum(ser.length);
    for(let i = 0; i < ser.length; i++){
      const b = ser[i]; if(!b)continue;
      mixNum(Math.round((+b.c || 0) * 10000));
      mixNum(+b.v || 0);
      if(i === 0 || i === ser.length - 1)mixStr(String(b.d || ''));
    }
  }
  return h.toString(36);
}

// ═══ end scan engine + security helpers ═══════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// w509 — LOOKALIKE INDEX (server). Nightly, after the ASX ingest, every liquid
// share's ~3 years of bars are swept once. Each share-day gets a fingerprint
// (volume band vs trailing-63 avg, day-change band, up-streak band, near-high)
// and its forward outcomes land in per-fingerprint HISTOGRAMS for three
// horizons (5/10/20 trading days) plus the drawdown along the 10-day path
// (closing basis). ~180 tiny buckets replace millions of rows; /lookalike/idx
// hands the whole market's memory to the app in one ~15KB fetch.
// Base rates, not predictions — same bands as the app's on-device fallback.
// ═════════════════════════════════════════════════════════════════════════════
const LA_EDGES = [-100,-60,-40,-30,-25,-20,-16,-12,-9,-6,-4,-2,0,2,4,6,9,12,16,20,25,30,40,60,100,200];
function laBin(x){ for (let i = LA_EDGES.length - 1; i >= 0; i--) { if (x >= LA_EDGES[i]) return i; } return 0; }
function laMkH(){ return { n:0, pos:0, mn:null, mx:null, b:new Array(LA_EDGES.length).fill(0) }; }
function laAdd(h,x){ h.n++; if (x > 0) h.pos++; if (h.mn == null || x < h.mn) h.mn = x; if (h.mx == null || x > h.mx) h.mx = x; h.b[laBin(x)]++; }
function laNotable(f){ const p=f.split('|'); return p[0]==='V2'||p[0]==='V3'||p[0]==='V15'||p[1]==='C10'||p[1]==='C5'||p[1]==='C2'||p[1]==='Cm5'||p[2]==='S2'||p[2]==='S4'; }
function laFinger(chg, volR, streak, nearHi){
  const vb = volR>=3?'V3':volR>=2?'V2':volR>=1.5?'V15':volR>=1?'V1':'V0';
  const cb = chg>=10?'C10':chg>=5?'C5':chg>=2?'C2':chg>=0?'C0':chg>=-5?'Cm':'Cm5';
  const sb = streak>=4?'S4':streak>=2?'S2':'S0';
  return vb+'|'+cb+'|'+sb+'|'+(nearHi?'H':'-');
}
async function laRebuild(env, exch){
  exch = exch || 'ASX';
  // w527: the lookalike window goes to the full stored decade. Rebuilt locally
  // over the same bars first, so the effect is known rather than hoped for:
  // 481k events -> 1.33M, fingerprints with under 400 events 58 -> 31. The big
  // buckets barely move (their answers were already precise to a fraction of a
  // percent) but they move DOWN slightly and consistently — 52.9% -> 52.3%
  // finished higher on the commonest fingerprint — because three years of
  // 2023-2026 was a kinder market than the decade containing 2016-19 and the
  // COVID crash. The shorter window was quietly flattering the base rates.
  const since  = new Date(Date.now() - 3660*864e5).toISOString().slice(0,10);
  const recent = new Date(Date.now() -   10*864e5).toISOString().slice(0,10);
  const tl = await env.MARKET_DB.prepare('SELECT ticker FROM bars WHERE exch=? AND d>=? AND c>0 AND v>0 GROUP BY ticker HAVING AVG(c*v)>=?').bind(exch, recent, 250000).all();
  const tickers = ((tl && tl.results) || []).map(r => r.ticker);
  const buckets = {}; let days = 0, shares = 0;
  // w527: 25 not 40 — each ticker now carries ~3x the rows, so the page size
  // comes down to keep one query's result set the size it used to be.
  for (let off = 0; off < tickers.length; off += 25) {
    const page = tickers.slice(off, off + 25);
    const ph = page.map(() => '?').join(',');
    const rs = await env.MARKET_DB.prepare('SELECT ticker,d,c,v FROM bars WHERE exch=? AND d>=? AND ticker IN (' + ph + ') ORDER BY ticker,d').bind(exch, since, ...page).all();
    const rows = (rs && rs.results) || [];
    let cur = null, ser = [];
    const flush = () => {
      if (ser.length < 80) { ser = []; return; }
      shares++;
      let vsum = 0, vn = 0, streak = 0, prevF = null; const win = [], hiWin = []; // w511: prevF gates episodes
      for (let i = 0; i < ser.length; i++) {
        const c = +ser[i].c || 0, v = +ser[i].v || 0, prev = i > 0 ? (+ser[i-1].c || 0) : 0;
        const chg = prev > 0 ? ((c - prev) / prev) * 100 : 0;
        streak = (i > 0 && c > prev) ? streak + 1 : 0;
        const avg = vn >= 10 ? vsum / vn : 0;
        const volR = (avg > 0 && v > 0) ? v / avg : 0;
        const hi = hiWin.length ? Math.max.apply(null, hiWin) : 0;
        const nearHi = hi > 0 && c >= hi * 0.95;
        if (i >= 20 && avg > 0 && v > 0 && c > 0) {
          const f = laFinger(chg, volR, streak, nearHi);
          const isNew = (f !== prevF); prevF = f; // w511: consecutive same-fingerprint days on one share = ONE episode
          if (isNew) {
          const B = buckets[f] || (buckets[f] = { h5: laMkH(), h10: laMkH(), h20: laMkH(), dd: laMkH(), _r: { h5: [], h10: [], h20: [], dd: [] }, ex: [] });
          [[ 'h5',5 ],[ 'h10',10 ],[ 'h20',20 ]].forEach(pair => {
            const hk = pair[0], k = pair[1];
            if (i + k < ser.length) {
              const fc = +ser[i+k].c || 0;
              if (fc > 0) {
                const fv = (fc - c) / c * 100; laAdd(B[hk], fv); B._r[hk].push(fv); // w511: raw values for exact quantiles
                if (hk === 'h10') {
                  days++;
                  let mn = c;
                  for (let j2 = i + 1; j2 <= i + 10 && j2 < ser.length; j2++) { const cc = +ser[j2].c || 0; if (cc > 0 && cc < mn) mn = cc; }
                  const ddv = (mn - c) / c * 100; laAdd(B.dd, ddv); B._r.dd.push(ddv);
                  if (B.ex.length < 3) B.ex.push({ t: ser[i].ticker, d: ser[i].d }); // w511: example days
                }
              }
            }
          });
          } // end isNew
        }
        win.push(v > 0 ? v : 0); if (v > 0) { vsum += v; vn++; }
        if (win.length > 63) { const o = win.shift(); if (o > 0) { vsum -= o; vn--; } }
        hiWin.push(c); if (hiWin.length > 250) hiWin.shift();
      }
      ser = [];
    };
    for (const r of rows) { if (r.ticker !== cur) { flush(); cur = r.ticker; } ser.push(r); }
    flush();
  }
  await env.MARKET_DB.prepare('CREATE TABLE IF NOT EXISTS la_idx (finger TEXT PRIMARY KEY, data TEXT, built_d TEXT)').run();
  await env.MARKET_DB.prepare('DELETE FROM la_idx').run();
  const today = new Date().toISOString().slice(0,10);
  const keys = Object.keys(buckets);
  for (let i = 0; i < keys.length; i += 20) {
    const chunk = keys.slice(i, i + 20);
    const stmts = chunk.map(f => env.MARKET_DB.prepare('INSERT INTO la_idx (finger,data,built_d) VALUES (?,?,?)').bind(f, JSON.stringify((function(B){ const q=(a,fr)=>{ if(!a||!a.length) return null; const b=a.slice().sort((x,y)=>x-y); return +b[Math.min(b.length-1,Math.floor(b.length*fr))].toFixed(2); }; const X=(hk)=>{ const h=B[hk]||{}; const r=(B._r&&B._r[hk])||[]; return Object.assign({}, h, { med:q(r,0.5), q1:q(r,0.25), q3:q(r,0.75) }); }; return { h5:X('h5'), h10:X('h10'), h20:X('h20'), dd:X('dd'), ex:(B.ex||[]) }; })(buckets[f])), today));
    await env.MARKET_DB.batch(stmts);
  }
  await env.MARKET_DB.prepare('INSERT INTO meta (k,v,updated) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated=excluded.updated').bind('la_built', today, Date.now()).run();
  return { tickers: tickers.length, shares, days, buckets: keys.length };
}

export default {
  // Nightly EOD ingest — fires on the cron triggers, gated to the Sydney close.
  // Cloudflare cron is UTC-only, so we schedule the UTC times for BOTH daylight
  // offsets and let this handler run only when it's actually ~5:00pm / ~6:30pm
  // in Sydney — so it stays correct across the AEST⇄AEDT switch automatically.
  
async scheduled(event, env, ctx) {
    const t = sydneyNow();
    const pass = _ingestPass(t);
    let _ingASX = null;
    if (pass) { try { _ingASX = await ingestDay(env, t.date, pass, 'ASX'); } catch (e) {} }
    const tn = nyNow();                                           // v384: New York close
    const passNY = NYSE_RETIRED ? null : _ingestPassNY(tn); // w406: NYSE retired — no new ingest, tech52, or R2 copies
    if (passNY) { try { await ingestDay(env, tn.date, passNY, 'NYSE'); } catch (e) {} }
    // v390: the net. Only runs when the scheduled pass for that exchange did NOT
    // fire this tick, so it never duplicates an upstream call — it exists purely
    // to rescue a trading day that the windows above missed altogether.
    if (!pass) { try { _ingASX = await _ingestCatchUp(env, 'ASX', t); } catch (e) {} }
    // w523: EODHD's evening AU file can carry PRELIMINARY volumes (late trades
    // and crossings keep reporting for hours — GML printed 1.7M at 8pm against
    // a larger final figure). Once per day, re-pull the PREVIOUS trading day so
    // yesterday's bars settle onto final numbers. Self-stamped: one bulk call.
    try {
      const _lc = _lastClosedDay(t, _INGEST.CLOSE_HOUR);
      const _pv = _lc ? _bfPrevWeekday(_lc) : null;
      if (_pv && !(await _getMeta(env, 'refine_ASX_' + _pv)) && (await _getMeta(env, 'ingest_ASX_' + _pv))) {
        // w550: stamp AFTER the re-pull lands, never before. 14 Aug 2026 was lost to
        // exactly this order: the stamp was burned first, the ingest behind it never
        // completed, and the burned stamp then blocked every retry forever - the day
        // sat at eodhd-final:1951 while its neighbours refined to ~2,300. A bounded
        // tries counter (same pattern as catchup_) stops a dead upstream turning the
        // retry into an every-tick fetch.
        const _rm = String((await _getMeta(env, 'refineTry_ASX')) || '');
        const _rc = _rm.indexOf(':');
        const _rt = (_rc > 0 && _rm.slice(0, _rc) === _pv) ? (parseInt(_rm.slice(_rc + 1), 10) || 0) : 0;
        if (_rt < _INGEST.MAX_TRIES) {
          await _setMeta(env, 'refineTry_ASX', _pv + ':' + (_rt + 1));
          const _rr = await ingestDay(env, _pv, 'refine', 'ASX');
          if (_rr && _rr.ok && _rr.count > 0) await _setMeta(env, 'refine_ASX_' + _pv, '1');
        }
      }
      // w552: nightly picks email - fires once per day, only AFTER the bot lane's
      // pick run has stamped for that day (so it always carries final decisions),
      // stamped mail_ASX_<day> ONLY on a confirmed 2xx from Resend (the 14 Aug
      // lesson: never record intent as completion), bounded to 5 tries a day.
      try {
        if (env.RESEND_KEY && env.PICKS_EMAIL_TO && env.MARKET_DB) {
          let _mpr = null;
          try { _mpr = JSON.parse(String((await _getMeta(env, 'picks_run_mine_ASX')) || '') || 'null'); } catch (e) {}
          const _mday = (_mpr && _mpr.ok && _mpr.day) ? String(_mpr.day) : '';
          if (_mday && !(await _getMeta(env, 'mail_ASX_' + _mday))) {
            const _mm = String((await _getMeta(env, 'mailTry_ASX')) || '');
            const _mx = _mm.indexOf(':');
            const _mt = (_mx > 0 && _mm.slice(0, _mx) === _mday) ? (parseInt(_mm.slice(_mx + 1), 10) || 0) : 0;
            if (_mt < 5) {
              await _setMeta(env, 'mailTry_ASX', _mday + ':' + (_mt + 1));
              const _mr = await _picksMailSend(env, _mday);
              if (_mr && _mr.ok) await _setMeta(env, 'mail_ASX_' + _mday, new Date().toISOString() + '|' + (_mr.picks || 0));
            }
          }
        }
      } catch (e) {}
    } catch (e) {}
    if (!NYSE_RETIRED && !passNY) { try { await _ingestCatchUp(env, 'NYSE', tn); } catch (e) {} } // w406
    // w544: one heavy job per tick. If this invocation just ingested a meaningful
    // slice of the market, STOP HERE — grading, lanes and the rebuilds get fresh
    // invocations via the checklist (which already self-heals tick to tick). Before
    // this, close night packed ingest + grading + lanes into one invocation and the
    // platform killed it mid-flight, freezing the whole pipeline at the same rows.
    if (_ingASX && _ingASX.written > 100) { return; }
    try { await _backfillTick(env); } catch (e) {}                // v384: depth crawler rides every firing
    // w400: rebuild the 52-week table for whichever exchange just took a real
    // close. Only after a genuine pass — the depth crawler walks BACKWARDS, so
    // rebuilding on its firings would burn the query for no new information.
    // w522: tech52 + warm + picks + lookalike + R2 all moved into _dayCloseTasks,
    // fired on every tick the moment the close's data actually exists (see the
    // function for the 13 Aug post-mortem that forced this).
    try { await _dayCloseTasks(env, t); } catch (e) {}
    // (w522: the old final-pass pick block lived here; _dayCloseTasks owns it now.)
     // w460: the new-rules report picks itself daily, right after the day's evidence is fresh
    if (passNY === 'final') { try { await buildTech52(env, 'NYSE'); } catch (e) {} }
    // w401: and the day's copy to R2, if a bucket is bound. Nothing happens at
    // all when it is not — no error, no half-state.
    // w522: the ASX R2 copy runs from _dayCloseTasks, keyed to the real close day.
    if (passNY === 'final') { try { await pantryToR2(env, 'NYSE', tn.date); } catch (e) {} }
    try { await _newsTick(env); } catch (e) {}                    // v386: poll a few shortlist tickers for real news
  },
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    // w407: the admin panel is served FROM this worker, and browsers attach an
    // Origin header to its POSTs — the worker's own origin must be on its own
    // guest list, or the panel's buttons 403 themselves ("forbidden origin",
    // which is exactly how the NYSE delete button failed). Same-origin only;
    // foreign origins are refused exactly as before.
    // w408: /admin/ routes are exempt from the origin allowlist entirely. Their
    // real lock is ADMIN_KEY (constant-time, per-route) — an Origin check adds
    // nothing there and has twice refused the panel's own buttons. Cross-site
    // abuse stays impossible: a foreign page cannot attach X-Insight-Admin
    // without a CORS preflight, and the preflight never approves foreign
    // origins — and without the header, adminAuth answers 401 anyway.
    if (origin && origin !== url.origin && !ALLOWED_ORIGINS.includes(origin) && !url.pathname.startsWith('/admin/')) return json({ error: 'forbidden origin' }, 403, origin);

    // Access gate (v380): computed once per request. `locked()` is the uniform 401
    // the app watches for to raise its password screen.
    const gate = await gateStatus(request, env);
    const locked = () => json({ error: 'locked', hint: 'This preview is password-protected.' }, 401, origin);

    // ---- POST /news/watch — the app registers the shares it cares about (v386).
    //      Send the CURRENT shortlist every time; it replaces what was there.
    //      { exch:'ASX', hold:['BHP'], watch:['CBA'], picks:['XYZ'] }            ----
    // ---- GET /picks — the daily picks, for the APP rather than the admin page.
    //      w499. On the app's own access gate, not the admin password: the app
    //      already sends X-Insight-Access on every call, and a report you cannot
    //      reach without opening a separate admin page is a report nobody reads.
    //      READ ONLY on purpose. Clearing, running and queueing all change state
    //      and stay behind the admin password on the admin page — the app can
    //      look, not act. ?mode=trail serves the trailing set, default is 15/15.
    // w505 — the bot's saved rules live on the server too. POST stores the
    // sanitized blob; GET returns what will drive tonight's saved-rules run.
    if (url.pathname === '/bot/rules') {
      if (gate.configured && !gate.ok) return locked();
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      if (request.method === 'POST') {
        let body; try { body = await request.json(); } catch (e) { return json({ error: 'bad json body' }, 400, origin); }
        if (body && body.clear === true) {
          try { await env.MARKET_DB.prepare('INSERT INTO meta (k,v,updated) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated=excluded.updated').bind('bot_rules','',new Date().toISOString()).run(); } catch (e) {}
          return json({ ok: true, cleared: true, workerV: _WV }, 200, origin);
        }
        const v = _botRulesSanitize(body);
        if (!v.ok) return json({ error: v.error }, 400, origin);
        try { await env.MARKET_DB.prepare('INSERT INTO meta (k,v,updated) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated=excluded.updated').bind('bot_rules', JSON.stringify(v.rules), new Date().toISOString()).run(); }
        catch (e) { return json({ error: 'could not store the rules' }, 500, origin); }
        return json({ ok: true, saved: v.rules, workerV: _WV, note: 'these rules now drive the nightly saved-rules pick run (mode=mine)' }, 200, origin);
      }
      const cur = await _botRulesGet(env);
      return json({ ok: true, rules: cur, workerV: _WV, note: cur ? 'these drive the nightly saved-rules pick run (mode=mine)' : 'no saved rules yet - the nightly run covers only the two built-in control sets' }, 200, origin);
    }

    if (url.pathname === '/lookalike/idx') {
        if (gate.configured && !gate.ok) return locked();
        if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
        try {
          const rs = await env.MARKET_DB.prepare('SELECT finger,data,built_d FROM la_idx').all();
          const rows = (rs && rs.results) || [];
          if (!rows.length) return json({ ok: false, empty: true, note: 'index not built yet - it builds after the next evening ingest, or POST /admin/lookalike/rebuild' }, 200, origin);
          const buckets = {};
          rows.forEach(r => { try { buckets[r.finger] = JSON.parse(r.data); } catch (e) {} });
          return json({ ok: true, built: rows[0].built_d, edges: LA_EDGES, buckets }, 200, origin);
        } catch (e) { return json({ error: String((e && e.message) || e) }, 500, origin); }
      }
      if (method === 'POST' && url.pathname === '/admin/lookalike/rebuild') {
        { const d = adminAuth(request, env); if (d) { if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900)) return json({ error: 'too many attempts, try later' }, 429, origin); return json(d.body, d.status, origin); } }
        if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
        try { const r = await laRebuild(env, 'ASX'); return json({ ok: true, ...r }, 200, origin); }
        catch (e) { return json({ error: String((e && e.message) || e) }, 500, origin); }
      }
      

      // ═══ w528: SCAN GRADES — the app's grading, served from the pantry ═══
      if (url.pathname === '/admin/grade/step') {
        const aerr = adminAuth(request, env); if (aerr) return aerr;
        if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
        const exch = (url.searchParams.get('exch') || 'ASX').toUpperCase();
        if (url.searchParams.get('reset') === '1') { try { await _setMeta(env, 'sg_cursor_' + exch, '0'); await _setMeta(env, 'sg_day_' + exch, ''); } catch (e) {} }
        try { const r = await _scanGradeStep(env, exch, 3500); return json({ ok: !r.error, ...r }, r.error ? 500 : 200, origin); }
        catch (e) { return json({ error: String((e && e.message) || e) }, 500, origin); }
      }
      if (url.pathname === '/grades/status') {
        if (gate.configured && !gate.ok) { const aerr = adminAuth(request, env); if (aerr) return locked(); } // w529: the admin panel may ask with the admin key
        if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
        const exch = (url.searchParams.get('exch') || 'ASX').toUpperCase();
        try {
          await _scanGradesEnsure(env);
          const r = await env.MARKET_DB.prepare('SELECT d, COUNT(*) AS n FROM scan_grades WHERE exch=? GROUP BY d ORDER BY d DESC LIMIT 1').bind(exch).first();
          const cur = parseInt(await _getMeta(env, 'sg_cursor_' + exch) || '0', 10) || 0;
          const tot = await env.MARKET_DB.prepare('SELECT COUNT(DISTINCT ticker) AS n FROM bars WHERE exch=?').bind(exch).first();
          return json({ ok: true, exch, day: (r && r.d) || null, graded: (r && r.n) || 0, cursor: cur, total: (tot && tot.n) || 0 }, 200, origin);
        } catch (e) { return json({ error: String((e && e.message) || e) }, 500, origin); }
      }
      if (url.pathname.startsWith('/grades/day/')) {
        if (gate.configured && !gate.ok) return locked();
        if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
        const exch = String(url.pathname.slice('/grades/day/'.length) || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
        if (!exch) return json({ error: 'want /grades/day/EXCH' }, 400, origin);
        try {
          await _scanGradesEnsure(env);
          const latest = await env.MARKET_DB.prepare('SELECT MAX(d) AS d FROM scan_grades WHERE exch=?').bind(exch).first();
          const day = latest && latest.d;
          if (!day) return json({ ok: true, exch, day: null, grades: {} }, 200, origin);
          const rs = await env.MARKET_DB.prepare('SELECT ticker, g FROM scan_grades WHERE exch=? AND d=?').bind(exch, day).all();
          const grades = {};
          for (const r of ((rs && rs.results) || [])) { try { grades[r.ticker] = JSON.parse(r.g); } catch (e) {} }
          return json({ ok: true, exch, day, count: Object.keys(grades).length, grades }, 200, origin);
        } catch (e) { return json({ error: String((e && e.message) || e) }, 500, origin); }
      }

      // ═══ w512: EODHD 10-year backfill (admin, cursor-stepped) ═══
      if (url.pathname === '/admin/eodhd/backfill') {
        const aerr = adminAuth(request, env); if (aerr) return aerr;
        if (!env.EODHD_KEY) return json({ ok:false, error:'EODHD_KEY secret not set' }, 500, corsHeaders);
        const exch = (url.searchParams.get('exch') || 'ASX').toUpperCase();
        const sfx = exch === 'ASX' ? '.AU' : '.US';
        const metaK = 'eodhd_backfill_' + exch;
        let cur = 0;
        try { const m = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind(metaK).first(); if (m && m.v) cur = +JSON.parse(m.v).cursor || 0; } catch (e) {}
        if (url.searchParams.get('reset') === '1') cur = 0;
        const tl = await env.MARKET_DB.prepare('SELECT DISTINCT ticker FROM bars WHERE exch=? ORDER BY ticker').bind(exch).all();
        const tickers = ((tl && tl.results) || []).map(r => r.ticker);
        const BATCH = 15; const page = tickers.slice(cur, cur + BATCH);
        const from = new Date(Date.now() - 3700*864e5).toISOString().slice(0,10);
        let bars = 0, errs = 0;
        for (const tk of page) {
          try {
            const r = await fetch('https://eodhd.com/api/eod/' + encodeURIComponent(tk) + sfx + '?api_token=' + env.EODHD_KEY + '&period=d&fmt=json&from=' + from, { headers: { accept: 'application/json' } });
            if (!r.ok) { errs++; continue; }
            const arr = await r.json(); if (!Array.isArray(arr)) { errs++; continue; }
            const stmts = [];
            for (const b of arr) {
              const rawC = +b.close || 0;
              const c = +(b.adjusted_close != null ? b.adjusted_close : b.close) || 0; const v = +b.volume || 0; const d = String(b.date || '').slice(0,10);
              if (!(c > 0) || !d) continue;
              // w520: keep open/high/low, scaled onto the SAME basis as the adjusted
              // close, or a split leaves high < close and every candle is nonsense.
              const adj = (rawC > 0) ? (c / rawC) : 1;
              const sc = (x) => { const r = +x; return (isFinite(r) && r > 0) ? +(r * adj).toFixed(6) : null; };
              let o = sc(b.open), h = sc(b.high), l = sc(b.low);
              // never let a rounded band exclude the close it belongs to
              if (h != null && h < c) h = c;
              if (l != null && l > c) l = c;
              if (h != null && l != null && l > h) { const t = h; h = l; l = t; }
              stmts.push(env.MARKET_DB.prepare('INSERT INTO bars (exch,ticker,d,o,h,l,c,v) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(exch,ticker,d) DO UPDATE SET o=COALESCE(excluded.o,bars.o), h=COALESCE(excluded.h,bars.h), l=COALESCE(excluded.l,bars.l), c=excluded.c, v=excluded.v').bind(exch, tk, d, o, h, l, c, v));
              bars++;
              if (stmts.length >= 40) { await env.MARKET_DB.batch(stmts.splice(0)); }
            }
            if (stmts.length) await env.MARKET_DB.batch(stmts);
          } catch (e) { errs++; }
        }
        const next = cur + page.length; const done = next >= tickers.length;
        await env.MARKET_DB.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(metaK, JSON.stringify({ cursor: done ? 0 : next, total: tickers.length, at: new Date().toISOString(), lastBars: bars, lastErrs: errs })).run();
        return json({ ok:true, exch, processed: page.length, cursor: done ? 0 : next, total: tickers.length, done, bars, errs, note: done ? 'backfill complete — rerun laRebuild and the study' : 'call again to continue' }, 200, corsHeaders);
      }


      // ═══ w517: DECADE GRADING in quarters — the real gradeShares math on 10y,
      // one deterministic quarter of the universe per invocation (CPU-safe),
      // stored beside (never inside) the live grading path. ═══
      if (url.pathname === '/admin/grades/decade') {
        const aerr = adminAuth(request, env); if (aerr) return aerr;
        const exch = (url.searchParams.get('exch') || 'ASX').toUpperCase();
        const part = Math.max(1, Math.min(4, +(url.searchParams.get('part') || 1)));
        const HOLD = Math.max(5, Math.min(30, +(url.searchParams.get('hold') || 10)));
        const recent = new Date(Date.now() - 10*864e5).toISOString().slice(0,10);
        const since = new Date(Date.now() - 3700*864e5).toISOString().slice(0,10);
        const tl = await env.MARKET_DB.prepare('SELECT ticker FROM bars WHERE exch=? AND d>=? AND c>0 AND v>0 GROUP BY ticker HAVING AVG(c*v)>=? ORDER BY ticker').bind(exch, recent, 250000).all();
        const all = ((tl && tl.results) || []).map(r => r.ticker);
        const mine = all.filter((t, ix) => (ix % 4) === (part - 1));
        const shares = [];
        for (let off = 0; off < mine.length; off += 25) {
          const pg = mine.slice(off, off + 25); const ph = pg.map(() => '?').join(',');
          const rs = await env.MARKET_DB.prepare('SELECT ticker,d,c,v FROM bars WHERE exch=? AND d>=? AND ticker IN (' + ph + ') ORDER BY ticker,d').bind(exch, since, ...pg).all();
          const rows = (rs && rs.results) || []; let cur = null, ser = null;
          for (const r of rows) { if (r.ticker !== cur) { if (ser && ser.length >= 120) shares.push({ ticker: cur, series: ser }); cur = r.ticker; ser = []; } ser.push({ d: r.d, c: +r.c, v: +r.v }); }
          if (ser && ser.length >= 120) shares.push({ ticker: cur, series: ser });
        }
        let annPS = null; try { annPS = await _annFromStore(env, exch); } catch (e) { annPS = null; }
        const A = gradeShares(shares, HOLD, annPS, 250000);
        const body = JSON.stringify({ ok: true, part, of: 4, hold: HOLD, from: since, shares: shares.length, A });
        const metaK = 'grades10_' + exch + '_' + HOLD + '_' + part;
        if (body.length <= 900000) {
          await env.MARKET_DB.prepare('INSERT INTO meta (k,v,updated) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated=excluded.updated').bind(metaK, body, new Date().toISOString()).run();
          return json({ ok: true, part, of: 4, hold: HOLD, shares: shares.length, stored: metaK, note: part < 4 ? 'now run part ' + (part + 1) : 'all four quarters done — read /grades/decade' }, 200, corsHeaders);
        }
        return json({ ok: false, error: 'grade table too large to store', bytes: body.length }, 500, corsHeaders);
      }
      if (url.pathname === '/grades/decade') {
        const aok = !adminAuth(request, env);
        if (!aok) { const gerr = gate(request, env); if (gerr) return gerr; }
        const exch = (url.searchParams.get('exch') || 'ASX').toUpperCase();
        const HOLD = Math.max(5, Math.min(30, +(url.searchParams.get('hold') || 10)));
        const parts = [];
        for (let pI = 1; pI <= 4; pI++) {
          try { const m = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind('grades10_' + exch + '_' + HOLD + '_' + pI).first();
            if (m && m.v) parts.push(JSON.parse(m.v)); } catch (e) {}
        }
        if (!parts.length) return json({ ok: false, empty: true }, 200, corsHeaders);
        return json({ ok: true, hold: HOLD, partsStored: parts.length, of: 4,
          note: 'Each quarter is an internally complete decade grading of a deterministic quarter of the liquid universe (edge measured against its own quarter-market). A key that earns its tier in all stored quarters has decade-robust evidence.',
          parts }, 200, corsHeaders);
      }

// ═══ w518: DECADE PORTFOLIO SIMULATOR — pure replay core (testable) ═══
// Replays $50k · 10 slots through time. THREE portfolios on identical picks:
//   0: dip 5% limit + 20% trail (the product)   1: market next close + 20% trail
//   2: dip 5% limit + fixed 15/15 (control)
// $3/side + slippage on every fill. Closes-only fills (stated). Pure function:
// same inputs, same dollars — verified against a planted-truth market.
function simReplayCore(days, picksByDay, closeAt, S, cfg){
  const SLIP=cfg.slip, STAKE=cfg.stake, SLOTS=cfg.slots, FEE=cfg.fee;
  const pf=S.pf;
  for (const d of days){
    for (let P=0; P<3; P++){
      const F=pf[P];
      for (let oi=F.open.length-1; oi>=0; oi--){
        const o=F.open[oi]; const c=closeAt(o.tk, d); if(!(c>0)){ o.age++; continue; }
        if (c>o.peak) o.peak=c;
        o.age++;
        let sell=false;
        if (P===2){ const r=(c-o.ep)/o.ep*100; if (r>=15||r<=-15||o.age>=120) sell=true; }
        else { if ((c-o.peak)/o.peak*100<=-20 || o.age>=240) sell=true; }
        if (sell){ const px=c*(1-SLIP); const proceeds=o.qty*px-FEE;
          F.cash+=proceeds; const net=(proceeds-o.cost)/o.cost*100;
          F.trades.push(+net.toFixed(3)); F.open.splice(oi,1); }
      }
      if (P!==1){ for (let pi=F.pend.length-1; pi>=0; pi--){
        const q=F.pend[pi]; const c=closeAt(q.tk, d);
        if (c>0 && c<=q.lim && F.open.length<SLOTS && F.cash>=STAKE){
          const px=q.lim*(1+SLIP); const qty=Math.floor((STAKE-FEE)/px);
          if (qty>0){ const cost=qty*px+FEE; F.cash-=cost;
            F.open.push({tk:q.tk, ep:px, peak:c, age:0, qty:qty, cost:cost}); }
          F.pend.splice(pi,1); continue; }
        q.left--; if (q.left<=0) F.pend.splice(pi,1);
      } } else { for (let pi=F.pend.length-1; pi>=0; pi--){
        const q=F.pend[pi]; if(!q.mkt) continue;
        if (q.queuedDay===undefined){ q.queuedDay=d; continue; }
        const c=closeAt(q.tk, d);
        if (c>0 && F.open.length<SLOTS && F.cash>=STAKE){
          const px=c*(1+SLIP); const qty=Math.floor((STAKE-FEE)/px);
          if (qty>0){ const cost=qty*px+FEE; F.cash-=cost;
            F.open.push({tk:q.tk, ep:px, peak:c, age:0, qty:qty, cost:cost}); } }
        F.pend.splice(pi,1);
      } }
      const picks=picksByDay[d]||[];
      for (const pk of picks){
        if (P===1) F.pend.push({tk:pk.tk, lim:Infinity, left:2, mkt:1, queuedDay:d}); // stamped on the SIGNAL day → fills next session
        else F.pend.push({tk:pk.tk, lim:pk.rc*0.95, left:5});
      }
    }
    S.lastDay=d;
  }
  return S;
}
function simEquity(F, closeAt, lastDay){
  let eq=F.cash;
  for (const o of F.open){ const c=closeAt(o.tk, lastDay)||o.ep; eq+=o.qty*c; }
  return eq;
}

      // ═══ w518: decade portfolio sim — stepped by TIME, state carried ═══
      if (url.pathname === '/admin/sim/decade/step') {
        const aerr = adminAuth(request, env); if (aerr) return aerr;
        const exch = (url.searchParams.get('exch') || 'ASX').toUpperCase();
        const metaK = 'sim10_' + exch;
        let S = null;
        try { const m = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind(metaK).first(); if (m && m.v && url.searchParams.get('reset') !== '1') S = JSON.parse(m.v); } catch (e) {}
        if (!S) S = { chunk: 0, pf: [0,1,2].map(()=>({cash:50000, open:[], pend:[], trades:[]})) };
        const CHUNKS = 5;
        if (S.chunk >= CHUNKS) return json({ ok:true, done:true, note:'already complete — read /sim/decade' }, 200, corsHeaders);
        const spanD = 3700, chunkD = Math.ceil(spanD / CHUNKS), look = 400;
        const start = new Date(Date.now() - (spanD - S.chunk*chunkD)*864e5).toISOString().slice(0,10);
        const end   = new Date(Date.now() - Math.max(0,(spanD - (S.chunk+1)*chunkD))*864e5).toISOString().slice(0,10);
        const loadFrom = new Date(new Date(start).getTime() - look*864e5).toISOString().slice(0,10);
        const recent = new Date(Date.now() - 10*864e5).toISOString().slice(0,10);
        const tl = await env.MARKET_DB.prepare('SELECT ticker FROM bars WHERE exch=? AND d>=? AND c>0 AND v>0 GROUP BY ticker HAVING AVG(c*v)>=?').bind(exch, recent, 250000).all();
        const tickers = ((tl && tl.results) || []).map(r => r.ticker).filter(t => !_NONEQUITY_EXCLUDE.has(t));
        const shares = [];
        for (let off = 0; off < tickers.length; off += 25) {
          const pg = tickers.slice(off, off + 25); const ph = pg.map(() => '?').join(',');
          const rs = await env.MARKET_DB.prepare('SELECT ticker,d,c,v FROM bars WHERE exch=? AND d>=? AND d<=? AND ticker IN (' + ph + ') ORDER BY ticker,d').bind(exch, loadFrom, end, ...pg).all();
          const rows = (rs && rs.results) || []; let cur = null, ser = null;
          for (const r of rows) { if (r.ticker !== cur) { if (ser && ser.length >= 60) shares.push({ ticker: cur, series: ser }); cur = r.ticker; ser = []; } ser.push({ d: r.d, c: +r.c, v: +r.v }); }
          if (ser && ser.length >= 60) shares.push({ ticker: cur, series: ser });
        }
        if (!shares.length) { S.chunk++; await env.MARKET_DB.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(metaK, JSON.stringify(S)).run(); return json({ ok:true, chunk:S.chunk, of:CHUNKS, note:'empty chunk skipped' }, 200, corsHeaders); }
        const X = _auditNewCtx(shares, 5, null, 250000); _auditRunAll(X); const A = _auditFinalize(X); const M = A.M;
        const EXCLUDE = { di:1, 'vr-':1, 'blk-':1, vr:1, blk:1 };
        const shareByTicker = {}; for (const s2 of shares) shareByTicker[s2.ticker] = s2;
        const idxByTicker = {}; for (const s2 of shares){ const mm={}; s2.series.forEach((b,bi)=>{mm[b.d]=bi;}); idxByTicker[s2.ticker]=mm; }
        const closeAt = (tk, d) => { const sh=shareByTicker[tk]; if(!sh) return 0; const ix=idxByTicker[tk][d]; return ix==null?0:(sh.series[ix].c||0); };
        const picksByDay = {};
        for (const rec of (X.recs||[])) {
          if (rec.d < start || rec.d > end) continue;
          const rc = closeAt(rec.ticker, rec.d);
          if (!(rc > 0.20 && rc <= 0.99)) continue;
          let best = null;
          for (const k of rec.ks) { if (EXCLUDE[k]) continue; const m = M[k]; if (!m) continue;
            const sc = _cardScore10(m); if (sc < 7) continue;
            if (!best || sc > best.score || (sc === best.score && (m.edge||0) > (best.edge||0))) best = { score: sc, edge: m.edge||0 }; }
          if (best) (picksByDay[rec.d] || (picksByDay[rec.d] = [])).push({ tk: rec.ticker, rc: rc, score: best.score, edge: best.edge });
        }
        Object.keys(picksByDay).forEach(d => { picksByDay[d].sort((a,b)=> (b.score-a.score)||(b.edge-a.edge)); picksByDay[d] = picksByDay[d].slice(0,4); });
        const allDays = {}; for (const s2 of shares) for (const b of s2.series) if (b.d >= start && b.d <= end) allDays[b.d]=1;
        const days = Object.keys(allDays).sort();
        simReplayCore(days, picksByDay, closeAt, S, { slip:0.01, stake:5000, slots:10, fee:3 });
        S.chunk++;
        const done = S.chunk >= CHUNKS;
        if (done){ S.finished = new Date().toISOString(); S.equity = S.pf.map(F => +simEquity(F, closeAt, S.lastDay).toFixed(2)); }
        await env.MARKET_DB.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(metaK, JSON.stringify(S)).run();
        return json({ ok:true, chunk:S.chunk, of:CHUNKS, done, days:days.length, openNow:S.pf.map(F=>F.open.length) }, 200, corsHeaders);
      }
      if (url.pathname === '/sim/decade') {
        const aok = !adminAuth(request, env);
        if (!aok) { const gerr = gate(request, env); if (gerr) return gerr; }
        const exch = (url.searchParams.get('exch') || 'ASX').toUpperCase();
        try { const m = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind('sim10_' + exch).first();
          if (!m || !m.v) return json({ ok:false, empty:true }, 200, corsHeaders);
          const S = JSON.parse(m.v);
          const names = ['dip 5% + trail 20% (the product)','market next close + trail 20%','dip 5% + fixed 15/15 (control)'];
          const out = { ok:true, done: S.chunk>=5, chunks:S.chunk, portfolios: S.pf.map((F,ix)=>{
            const tr=F.trades.slice().sort((a,b)=>b-a);
            const wins=F.trades.filter(x=>x>0).length;
            const eq=(S.equity&&S.equity[ix])!=null?S.equity[ix]:null;
            const top3=tr.slice(0,3).reduce((a,b)=>a+b,0);
            return { name:names[ix], closedTrades:F.trades.length, stillOpen:F.open.length,
              winRate: F.trades.length?Math.round(wins/F.trades.length*100):null,
              equity: eq, returnPct: eq!=null?+(((eq-50000)/50000)*100).toFixed(1):null,
              top3NetPctSum:+top3.toFixed(1) }; }) };
          return json(out, 200, corsHeaders);
        } catch (e) { return json({ ok:false, error:String(e).slice(0,200) }, 500, corsHeaders); }
      }
      // ═══ w515: decade STRATEGY tests (bands × exits × entries), stepped ═══
      if (url.pathname === '/admin/study/strat/step') {
        const aerr = adminAuth(request, env); if (aerr) return aerr;
        const exch = (url.searchParams.get('exch') || 'ASX').toUpperCase();
        const metaK = 'strat_study_' + exch;
        let st = { cursor: 0, cells: {} };
        try { const m = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind(metaK).first(); if (m && m.v && url.searchParams.get('reset') !== '1') st = JSON.parse(m.v); } catch (e) {}
        const recent = new Date(Date.now() - 10*864e5).toISOString().slice(0,10);
        const tl = await env.MARKET_DB.prepare('SELECT ticker FROM bars WHERE exch=? AND d>=? AND c>0 AND v>0 GROUP BY ticker HAVING AVG(c*v)>=?').bind(exch, recent, 250000).all();
        const tickers = ((tl && tl.results) || []).map(r => r.ticker);
        const since = new Date(Date.now() - 3700*864e5).toISOString().slice(0,10);
        const page = tickers.slice(st.cursor, st.cursor + 20);
        const COST = 1.2; // $6 round trip on a $500 position, in %
        const cell = (k) => st.cells[k] || (st.cells[k] = [0,0,0]); // trades, sumNet, wins
        if (page.length) {
          const ph = page.map(() => '?').join(',');
          const rs = await env.MARKET_DB.prepare('SELECT ticker,d,c,v FROM bars WHERE exch=? AND d>=? AND ticker IN (' + ph + ') ORDER BY ticker,d').bind(exch, since, ...page).all();
          const rows = (rs && rs.results) || []; let cur2 = null, ser = [];
          const runSeries = () => { if (ser.length < 120) { ser = []; return; }
            let vsum=0, vn=0, streak=0, prevF=null; const win=[], hiWin=[];
            let busyUntil=-1;
            for (let i2=0;i2<ser.length;i2++){
              const c=+ser[i2].c||0, v=+ser[i2].v||0, prev=i2>0?(+ser[i2-1].c||0):0;
              const chg=prev>0?((c-prev)/prev)*100:0;
              streak=(i2>0&&c>prev)?streak+1:0;
              const avg=vn>=10?vsum/vn:0; const volR=(avg>0&&v>0)?v/avg:0;
              const hi=hiWin.length?Math.max.apply(null,hiWin):0; const nearHi=hi>0&&c>=hi*0.95;
              if (i2>=20&&avg>0&&v>0&&c>0&&i2+70<ser.length){
                const f=laFinger(chg,volR,streak,nearHi);
                const isNew=(f!==prevF); prevF=f;
                if (isNew && laNotable(f) && i2>busyUntil){
                  const band = c<1?'u1':(c<=5?'b15':'o5');
                  // two entries: market (next close), dip (-5% limit filled on a close within 5 sessions)
                  const entries=[['mkt', i2+1, +ser[i2+1].c||0]];
                  const lim=c*0.95; let de=-1, dpx=0;
                  for(let k2=1;k2<=5;k2++){ const cc=+ser[i2+k2].c||0; if(cc>0&&cc<=lim){ de=i2+k2; dpx=cc; break; } }
                  if(de>0) entries.push(['dip', de, dpx]);
                  let far=0;
                  for(const en of entries){
                    const ei=en[1], ep=en[2]; if(!(ep>0)) continue;
                    // exit A: fixed 15/15 · exit B: 20% trail — 60-session cap
                    for(const ex of ['fx','tr']){
                      let out=null, peak=ep;
                      for(let k3=1;k3<=60;k3++){ const cc=+ser[ei+k3].c||0; if(!(cc>0)) continue;
                        if(cc>peak) peak=cc;
                        const r=(cc-ep)/ep*100;
                        if(ex==='fx'){ if(r>=15||r<=-15){ out=r; break; } }
                        else { if((cc-peak)/peak*100<=-20){ out=(cc-ep)/ep*100; break; } }
                        if(k3===60) out=r;
                      }
                      if(out==null) continue;
                      const net=out-COST; const K=band+'|'+en[0]+'|'+ex; const C=cell(K);
                      C[0]++; C[1]+=net; if(net>0)C[2]++;
                    }
                    if(ei+60>far) far=ei+60;
                  }
                  busyUntil=far||i2+60; // one campaign per share at a time
                }
              } else if(i2>=20){ prevF=laFinger(chg,volR,streak,nearHi); }
              win.push(v>0?v:0); if(v>0){vsum+=v;vn++;} if(win.length>63){const o=win.shift(); if(o>0){vsum-=o;vn--;}}
              hiWin.push(c); if(hiWin.length>250)hiWin.shift();
            } ser=[]; };
          for (const r of rows){ if(r.ticker!==cur2){ runSeries(); cur2=r.ticker; } ser.push(r); }
          runSeries();
        }
        st.cursor += page.length;
        const done = st.cursor >= tickers.length; if (done) st.done = new Date().toISOString();
        await env.MARKET_DB.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(metaK, JSON.stringify(st)).run();
        return json({ ok:true, cursor: st.cursor, total: tickers.length, done }, 200, corsHeaders);
      }
      if (url.pathname === '/study/strat') {
        const aok = !adminAuth(request, env);
        if (!aok) { const gerr = gate(request, env); if (gerr) return gerr; }
        const exch = (url.searchParams.get('exch') || 'ASX').toUpperCase();
        try { const m = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind('strat_study_' + exch).first();
          if (!m || !m.v) return json({ ok:false, empty:true }, 200, corsHeaders);
          const st = JSON.parse(m.v); const out = { ok:true, done: !!st.done, cells: {} };
          Object.keys(st.cells).forEach(k => { const C = st.cells[k]; out.cells[k] = { trades: C[0], avgNet: C[0] ? +(C[1]/C[0]).toFixed(2) : null, won: C[0] ? Math.round(C[2]/C[0]*100) : null }; });
          return json(out, 200, corsHeaders);
        } catch (e) { return json({ ok:false, error:String(e).slice(0,200) }, 500, corsHeaders); }
      }
      // ═══ w512: server gate study over the FULL pantry (admin step + gated read) ═══
      if (url.pathname === '/admin/study/gate/step') {
        const aerr = adminAuth(request, env); if (aerr) return aerr;
        const exch = (url.searchParams.get('exch') || 'ASX').toUpperCase();
        const metaK = 'gate_study_' + exch;
        let st = { cursor: 0, phase: 'train', train: {}, base: [0,0], gates: { g50:[0,0,0], g60:[0,0,0], g70:[0,0,0] }, cut: null, trainDays: 0, testDays: 0 };
        try { const m = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind(metaK).first(); if (m && m.v && url.searchParams.get('reset') !== '1') st = JSON.parse(m.v); } catch (e) {}
        const recent = new Date(Date.now() - 10*864e5).toISOString().slice(0,10);
        const tl = await env.MARKET_DB.prepare('SELECT ticker FROM bars WHERE exch=? AND d>=? AND c>0 AND v>0 GROUP BY ticker HAVING AVG(c*v)>=?').bind(exch, recent, 250000).all();
        const tickers = ((tl && tl.results) || []).map(r => r.ticker);
        if (!st.cut) { const dr = await env.MARKET_DB.prepare('SELECT MIN(d) mn, MAX(d) mx FROM bars WHERE exch=?').bind(exch).first(); const t0 = new Date(dr.mn).getTime(), t1 = new Date(dr.mx).getTime(); st.cut = new Date(t0 + (t1 - t0) * 0.6).toISOString().slice(0,10); }
        const since = new Date(Date.now() - 3700*864e5).toISOString().slice(0,10);
        const BATCH = 25; const page = tickers.slice(st.cursor, st.cursor + BATCH);
        const phase = st.phase || 'train';
        const ph = page.map(() => '?').join(',');
        if (page.length) {
          const rs = await env.MARKET_DB.prepare('SELECT ticker,d,c,v FROM bars WHERE exch=? AND d>=? AND ticker IN (' + ph + ') ORDER BY ticker,d').bind(exch, since, ...page).all();
          const rows = (rs && rs.results) || []; let cur2 = null, ser = [];
          const flush = () => { if (ser.length < 120) { ser = []; return; }
            let vsum = 0, vn = 0, streak = 0, prevF = null; const win = [], hiWin = [];
            for (let i2 = 0; i2 < ser.length; i2++) {
              const c = +ser[i2].c || 0, v = +ser[i2].v || 0, prev = i2 > 0 ? (+ser[i2-1].c || 0) : 0;
              const chg = prev > 0 ? ((c - prev) / prev) * 100 : 0;
              streak = (i2 > 0 && c > prev) ? streak + 1 : 0;
              const avg = vn >= 10 ? vsum / vn : 0; const volR = (avg > 0 && v > 0) ? v / avg : 0;
              const hi = hiWin.length ? Math.max.apply(null, hiWin) : 0; const nearHi = hi > 0 && c >= hi * 0.95;
              if (i2 >= 20 && avg > 0 && v > 0 && c > 0) {
                const f = laFinger(chg, volR, streak, nearHi);
                const isNew = (f !== prevF); prevF = f;
                if (isNew && i2 + 10 < ser.length) {
                  const fc = +ser[i2+10].c || 0;
                  if (fc > 0) { const fwd = (fc - c) / c * 100;
                    if (phase === 'train') { if (ser[i2].d < st.cut) { const t = st.train[f] || (st.train[f] = [0,0]); t[0]++; if (fwd > 0) t[1]++; st.trainDays++; } }
                    else if (ser[i2].d >= st.cut) {
                      st.base[0]++; st.base[1] += fwd; st.testDays++;
                      const t = st.train[f];
                      if (t && t[0] >= 30 && laNotable(f)) { const pos = t[1] / t[0] * 100;
                        [['g50',50],['g60',60],['g70',70]].forEach(g => { if (pos >= g[1]) { const G = st.gates[g[0]]; G[0]++; G[1] += fwd; if (fwd > 0) G[2]++; } });
                      }
                    }
                  }
                }
              }
              win.push(v > 0 ? v : 0); if (v > 0) { vsum += v; vn++; } if (win.length > 63) { const o = win.shift(); if (o > 0) { vsum -= o; vn--; } }
              hiWin.push(c); if (hiWin.length > 250) hiWin.shift();
            } ser = []; };
          for (const r of rows) { if (r.ticker !== cur2) { flush(); cur2 = r.ticker; } ser.push(r); }
          flush();
        }
        st.cursor += page.length;
        let done = false;
        if (st.cursor >= tickers.length) { if (phase === 'train') { st.phase = 'test'; st.cursor = 0; } else { done = true; st.done = new Date().toISOString(); } }
        await env.MARKET_DB.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(metaK, JSON.stringify(st)).run();
        return json({ ok:true, phase: st.phase, cursor: st.cursor, total: tickers.length, done, cut: st.cut, trainEvents: st.trainDays, testEvents: st.testDays }, 200, corsHeaders);
      }
      if (url.pathname === '/study/gate') {
        const aok = !adminAuth(request, env);
        if (!aok) { const gerr = gate(request, env); if (gerr) return gerr; }
        const exch = (url.searchParams.get('exch') || 'ASX').toUpperCase();
        try { const m = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind('gate_study_' + exch).first();
          if (!m || !m.v) return json({ ok:false, empty:true }, 200, corsHeaders);
          const st = JSON.parse(m.v);
          const base = st.base[0] ? st.base[1] / st.base[0] : 0;
          const out = { ok:true, done: !!st.done, cut: st.cut, trainEvents: st.trainDays, testEvents: st.testDays, baseline: +base.toFixed(3), gates: {} };
          Object.keys(st.gates).forEach(k => { const G = st.gates[k]; out.gates[k] = { events: G[0], avg: G[0] ? +(G[1]/G[0]).toFixed(3) : null, won: G[0] ? Math.round(G[2]/G[0]*100) : null, lift: G[0] ? +((G[1]/G[0]) - base).toFixed(3) : null }; });
          return json(out, 200, corsHeaders);
        } catch (e) { return json({ ok:false, error:String(e).slice(0,200) }, 500, corsHeaders); }
      }

      // ═══ w531: GET /brief — the Starter Today page, composed ONCE on the server ═══
      // Phase 2 of the Starter redesign (16 Aug): one fetch gives the app everything
      // the ☀ brief needs — yesterday's market breadth, the month's climate word
      // (from the 16-Aug decade seasonality study), and the single strongest pick —
      // so the phone paints instantly with no client-side composition. READ ONLY,
      // additive, cached in meta per (exch, day): the expensive breadth join runs
      // once per trading day no matter how many phones ask.
      if (url.pathname === '/brief') {
        if (gate.configured && !gate.ok) return locked();
        if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
        const exchB = (url.searchParams.get('exch') || 'ASX').toUpperCase();
        try {
          const dd = await env.MARKET_DB.prepare('SELECT DISTINCT d FROM bars WHERE exch=? ORDER BY d DESC LIMIT 2').bind(exchB).all();
          const days = ((dd && dd.results) || []).map(r => r.d);
          if (days.length < 2) return json({ ok: false, empty: true, note: 'not enough stored days yet' }, 200, origin);
          const day = days[0], prev = days[1];
          const ck = 'brief_' + exchB + '_' + day;
          try { const c = await _getMeta(env, ck); if (c) return json(Object.assign(JSON.parse(c), { cached: true }), 200, origin); } catch (e) {}
          // breadth: ordinaries only (3-char tickers — every 6-char is a derivative), latest vs previous close
          const t = await env.MARKET_DB.prepare(
            'SELECT COUNT(*) AS n, SUM(CASE WHEN b1.c>b0.c THEN 1 ELSE 0 END) AS up' +
            ' FROM bars b1 JOIN bars b0 ON b0.exch=b1.exch AND b0.ticker=b1.ticker AND b0.d=?' +
            ' WHERE b1.exch=? AND b1.d=? AND length(b1.ticker)=3 AND b1.c>0 AND b0.c>0')
            .bind(prev, exchB, day).first();
          const n = (t && +t.n) || 0, up = (t && +t.up) || 0;
          // month climate — words from the published decade study (21.5M day-changes; v794 carries the full table in-app)
          const MONTH = { '01': ['usually a decent month for small shares', 1], '02': ['often a soft patch for small shares', -1],
            '03': ['often a soft patch for small shares', -1], '04': ['usually a decent month', 1], '05': ['no strong lean either way', 0],
            '06': ['usually the toughest month - end-of-financial-year selling', -1], '07': ['historically the strongest month of the year', 1],
            '08': ['usually a decent month for small shares', 1], '09': ['no strong lean either way', 0], '10': ['no strong lean either way', 0],
            '11': ['no strong lean either way', 0], '12': ['no strong lean either way', 0] };
          const mk = String(day).slice(5, 7); const mc = MONTH[mk] || ['no strong lean either way', 0];
          // the single strongest pick from tonight's default (fixed) lane
          let pick = null;
          try {
            await _newRulesEnsureTable(env);
            const pr = await env.MARKET_DB.prepare(
              'SELECT ticker, limit_price, target_price, stop_price, evidence_key, score, tier, edge, first_seen_day' +
              ' FROM new_rules_picks WHERE exch=? AND status!=? ORDER BY first_seen_day DESC, score DESC LIMIT 1')
              .bind(exchB, 'skipped').first();
            if (pr && pr.ticker && +pr.limit_price > 0) pick = pr;
          } catch (e) {}
          const out = { ok: true, exch: exchB, workerV: _WV, day,
            tape: { n, up, pctUp: n ? Math.round(up / n * 100) : null, basis: 'ordinaries, last close vs the close before' },
            month: { key: mk, word: mc[0], tone: mc[1] },
            pick, built: new Date().toISOString() };
          try { await _setMeta(env, ck, JSON.stringify(out)); } catch (e) {}
          return json(out, 200, origin);
        } catch (e) { return json({ error: String((e && e.message) || e) }, 500, origin); }
      }

      if (url.pathname === '/picks') {
      if (gate.configured && !gate.ok) return locked();
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchP = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const modeP = url.searchParams.get('mode') || 'fixed';
      const TRAILP = (modeP === 'trail');
      const MINEP = (modeP === 'mine');   // w505: the saved-rules lane
      try { await _newRulesEnsureTable(env); await _trailRulesEnsureTable(env); if (MINEP) await _botRulesEnsureTable(env); } catch (e) {}
      let rows = [];
      try {
        const rs = await env.MARKET_DB.prepare(
          'SELECT * FROM ' + (MINEP ? 'bot_rules_picks' : TRAILP ? 'trail_rules_picks' : 'new_rules_picks') +
          ' WHERE exch=? ORDER BY first_seen_day DESC, score DESC').bind(exchP).all();
        rows = rs.results || [];
      } catch (e) { return json({ error: 'could not read the picks', detail: String((e && e.message) || e) }, 500, origin); }
      let latestBar = null;
      try {
        const b = await env.MARKET_DB.prepare('SELECT MAX(d) AS d FROM bars WHERE exch=?').bind(exchP).first();
        latestBar = (b && b.d) || null;
      } catch (e) {}
      let latestPick = null;
      for (const r of rows) if (r.first_seen_day && (!latestPick || r.first_seen_day > latestPick)) latestPick = r.first_seen_day;
      const RBv = MINEP ? await _botRulesGet(env) : null;   // w505
      // w510 — the lane's last-run stamp rides along, so the app can tell an
      // empty night ("ran, chose nothing") from a night the cron never ran.
      let lastRun = null;
      try {
        const lr = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?')
          .bind('picks_run_' + (MINEP ? 'mine' : TRAILP ? 'trail' : 'fixed') + '_' + exchP).first();
        if (lr && lr.v) lastRun = JSON.parse(lr.v);
      } catch (e) { lastRun = null; }
      return json({ ok: true, exch: exchP, workerV: _WV,
        mode: (MINEP ? 'mine' : TRAILP ? 'trail' : 'fixed'),
        lastRun,
        latestBar, latestPick, stale: !!(latestBar && latestPick && latestPick < latestBar),
        rules: MINEP
          ? (RBv || { note: 'no saved rules on the server yet' })
          : TRAILP
          ? { trailPct: _TRAIL_RULES_TRAIL_PCT, targetPct: null, stopPct: null,
              dipPct: _NEW_RULES_DIP_PCT, minScore: _NEW_RULES_MINSCORE, topN: _NEW_RULES_TOPN,
              minPrice: _NEW_RULES_MIN_PRICE, maxPrice: _NEW_RULES_MAX_PRICE, amount: _NEW_RULES_AMOUNT }
          : { trailPct: null, targetPct: _NEW_RULES_TARGET_PCT, stopPct: _NEW_RULES_STOP_PCT,
              dipPct: _NEW_RULES_DIP_PCT, minScore: _NEW_RULES_MINSCORE, topN: _NEW_RULES_TOPN,
              minPrice: _NEW_RULES_MIN_PRICE, maxPrice: _NEW_RULES_MAX_PRICE, amount: _NEW_RULES_AMOUNT },
        rows }, 200, origin);
    }

    if (method === 'POST' && url.pathname === '/news/watch') {
      if (gate.configured && !gate.ok) return locked();
      if (!env.MARKET_DB) return json({ error: 'news store not configured (no MARKET_DB binding)' }, 503, origin);
      if (!_newsOn(env)) return json({ ok: true, off: true, tracked: 0, note: 'news is off — set the NEWS_ON variable to 1' }, 200, origin);
      let body; try { body = await request.json(); } catch (e) { return json({ error: 'bad json body' }, 400, origin); }
      if (!(await _newsEnsure(env))) return json({ error: 'news store setup failed' }, 500, origin);
      const nExch = _newsExch(body && body.exch);
      const want = new Map();
      for (const [k, p] of [['hold', 3], ['watch', 2], ['picks', 1]]) {
        const arr = (body && Array.isArray(body[k])) ? body[k] : [];
        for (const raw of arr.slice(0, _NEWS.MAX_WATCH)) {
          const t = _newsTicker(raw && raw.ticker ? raw.ticker : raw);
          if (!t) continue;
          // v387: the company name comes along for the relevance test. Send
          // {ticker:'BHP',name:'BHP Group Limited'} — a bare 'BHP' still works,
          // it just means we can only match on the ticker itself.
          const nm = String((raw && raw.name) || '').slice(0, 80);
          const prev = want.get(t);
          if (!prev) want.set(t, { p, nm });
          else { if (p > prev.p) prev.p = p; if (nm && !prev.nm) prev.nm = nm; }
        }
      }
      const list = Array.from(want.entries()).slice(0, _NEWS.MAX_WATCH);
      if (!list.length) return json({ ok: true, exch: nExch, tracked: 0 }, 200, origin);
      const nowW = new Date().toISOString();
      const wstmt = env.MARKET_DB.prepare('INSERT INTO news_watch (exch,ticker,prio,seen,name) VALUES (?,?,?,?,?) ON CONFLICT(exch,ticker) DO UPDATE SET prio=excluded.prio, seen=excluded.seen, name=COALESCE(NULLIF(excluded.name,\'\'),news_watch.name)');
      let tracked = 0;
      try {
        // ONE batch = one transaction. The inserts stamp every current row with
        // seen=nowW; the trailing DELETE then removes anything older on this
        // exchange — shares the app no longer cares about. Doing it in a single
        // batch means two browser tabs posting at once can't leave a half-list.
        const b = list.map(x => wstmt.bind(nExch, x[0], x[1].p, nowW, x[1].nm || null));
        b.push(env.MARKET_DB.prepare('DELETE FROM news_watch WHERE exch=? AND seen<?').bind(nExch, nowW));
        await env.MARKET_DB.batch(b);
        tracked = list.length;
      } catch (e) { return json({ error: 'shortlist write failed' }, 500, origin); }
      return json({ ok: true, exch: nExch, tracked }, 200, origin);
    }

    // ---- POST /bridge/push — the app queues the auto-pilot's picks (v382) ----
    if (method === 'POST' && url.pathname === '/bridge/push') {
      // w392: CREATING orders now needs the same dedicated key that READING
      // them needs. It was protected by the shared customer password while the
      // read side had its own secret — backwards, since creating is the side
      // that reaches a trading bridge.
      { const denied = bridgeAuth(request, env, url);
        if (denied) {
          if (denied.status === 401 && await _rlOver(env, 'bridge|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(denied.body, denied.status, origin);
        } }
      if (!env.MARKET_DB) return json({ error: 'queue store not configured (no MARKET_DB binding)' }, 503, origin);
      let body; try { body = await request.json(); } catch (e) { return json({ error: 'bad json body' }, 400, origin); }
      const day = String((body && body.day) || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: 'bad day (want YYYY-MM-DD)' }, 400, origin);
      const raw = (body && Array.isArray(body.orders)) ? body.orders.slice(0, 24) : [];
      const orders = raw.map(_sanOrder).filter(Boolean);
      if (!orders.length) return json({ ok: true, day, received: raw.length, stored: 0 }, 200, origin);
      const now = new Date().toISOString();
      const stmt = env.MARKET_DB.prepare(_BQ_INSERT);
      const batch = orders.map(o => stmt.bind(o.id, day, o.exchange, JSON.stringify(o), now));
      let stored = 0;
      try {
        const res = await env.MARKET_DB.batch(batch);
        for (const r of (res || [])) stored += (r && r.meta && r.meta.changes) ? r.meta.changes : 0;
      } catch (e) { return json({ error: 'queue write failed' }, 500, origin); }
      // w392: nothing ever deleted from this table. Sweep anything older than a
      // fortnight — the bridge only ever reads today.
      try {
        const cut = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
        ctx.waitUntil(env.MARKET_DB.prepare('DELETE FROM bridge_queue WHERE day < ?').bind(cut).run());
      } catch (e) {}
      return json({ ok: true, day, received: raw.length, stored }, 200, origin);
    }

    // ---- POST /bridge/ack — the bridge marks orders handled (v382) ----
    if (method === 'POST' && url.pathname === '/bridge/ack') {
      const denied = bridgeAuth(request, env, url);
      if (denied) return json(denied.body, denied.status, origin);
      if (!env.MARKET_DB) return json({ error: 'queue store not configured (no MARKET_DB binding)' }, 503, origin);
      let body; try { body = await request.json(); } catch (e) { return json({ error: 'bad json body' }, 400, origin); }
      const ids = ((body && Array.isArray(body.ids)) ? body.ids : []).slice(0, 200)
        .map(x => String(x || '').trim().slice(0, 64)).filter(Boolean);
      if (!ids.length) return json({ ok: true, acked: 0 }, 200, origin);
      const now = new Date().toISOString();
      const stmt = env.MARKET_DB.prepare(_BQ_ACK);
      let acked = 0;
      try {
        const res = await env.MARKET_DB.batch(ids.map(id => stmt.bind(now, id)));
        for (const r of (res || [])) acked += (r && r.meta && r.meta.changes) ? r.meta.changes : 0;
      } catch (e) { return json({ error: 'queue update failed' }, 500, origin); }
      return json({ ok: true, acked }, 200, origin);
    }


    // ---- POST /scan — the rule predicates themselves, server-side (w392) ----
    // The app sends PRICE SERIES. It does not get to tell us the indicators:
    // an endpoint that answers "does this number fire?" is an oracle, and the
    // audit cracked every threshold through the old one in three requests.

    // ---- POST /reports — which shares each report picks (w395, stage 3) ----
    // Nothing in the app calls this yet. It exists so that the deciding can be
    // proved live and identical BEFORE a single threshold is deleted from
    // index.html. Server before app.
    if (method === 'POST' && url.pathname === '/reports') {
      if (gate.configured && !gate.ok) return locked();
      if (_bodyTooBig(request)) return json({ error: 'payload too large' }, 413, origin);
      let rp;
      try { rp = await request.json(); } catch (e) { return json({ error: 'bad json body' }, 400, origin); }
      const rExch = String((rp && rp.exch) || 'ASX').slice(0, 8);
      { const g = await _nyseGate(env, rExch, origin); if (g) return g; } // w406
      const rDate = String((rp && rp.dataDate) || '').slice(0, 10);
      const rShares = _capShares((rp && Array.isArray(rp.shares)) ? rp.shares : []);
      if (!rShares.length) return json({ error: 'no shares supplied' }, 400, origin);
      if (await _rlOver(env, 'reports|' + _ip(request), 60, 3600))
        return json({ error: 'too many report runs in the last hour' }, 429, origin);
      // How deep the store is for THIS exchange, from the cached count...
      const rDeep = +((await _getMeta(env, 'days_' + rExch)) || 0);
      // ...and whether we can actually READ a year of highs, which is a
      // different question. `_reportBars` fetches ONE day — today's — because
      // that is all Gap Report needs. The 52-week extremes behind these two
      // reports need every day's high and low, and fetching 1.3 million rows
      // per request is not an option, so a nightly per-share digest has to
      // exist first. Until it does, depth alone would unlock reports the
      // server cannot yet compute the same way the app does — measured, not
      // assumed: with only today's bar the running order moves on 567 of 600
      // shares for Technical Signals.
      const rDigest = String((await _getMeta(env, 'tech52_' + rExch)) || '');
      const rLatest = String((await _getMeta(env, 'latest_' + rExch)) || '');
      const deepOK = (rDeep >= _DEEP_DAYS) && !!rDigest && rDigest === rLatest;
      const servable = REPORTS_OPEN.concat(deepOK ? REPORTS_DEEP : []);
      const asked = (rp && Array.isArray(rp.reports) && rp.reports.length)
        ? rp.reports.map(function (x) { return String(x).slice(0, 24); }) : servable.slice();
      const want = asked.filter(function (k) { return servable.indexOf(k) >= 0; });
      // Say what was refused and why, with the actual numbers, rather than
      // returning a short list and letting the caller assume it asked wrongly.
      const held = {};
      asked.forEach(function (k) {
        if (servable.indexOf(k) < 0) {
          held[k] = (REPORTS_DEEP.indexOf(k) >= 0)
            ? ((rDeep < _DEEP_DAYS)
                ? ('needs a year of ' + (REPORTS_HELD[k] || 'history') + ' — the store holds ' +
                   rDeep + ' of the ' + _DEEP_DAYS + ' trading days needed for ' + rExch)
                : ('the store has the ' + rDeep + ' days it needs, but the nightly 52-week ' +
                   'table for ' + rExch + ' is not built yet' + (rDigest ? ' (last built ' + rDigest + ', data is ' + rLatest + ')' : '')))
            : 'unknown report';
        }
      });
      if (!want.length) return json({ ok: true, date: rDate, picks: {}, held: held, graded: 0,
        servable: servable, days: rDeep, deepNeeded: _DEEP_DAYS }, 200, origin);
      const opts = {
        exch: rExch,
        cap: String((rp && rp.cap) || 'any').slice(0, 8),
        sensitivity: String((rp && rp.sensitivity) || 'normal').slice(0, 8),
        minDays: (rp && +rp.minDays > 0) ? +rp.minDays : 3,
        scanAll: !!(rp && rp.scanAll)
      };
      const rDay = rDate || (await _getMeta(env, 'latest_' + rExch)) || '';
      const rBars = await _reportBars(env, rExch, rDay);
      // only fetched when a report that needs them was actually asked for
      const needDeep = want.some(function (k) { return REPORTS_DEEP.indexOf(k) >= 0; });
      const rRecent = needDeep ? await _reportRecent(env, rExch, 14) : null;
      const rExt = needDeep ? await _reportExt(env, rExch) : null;
      let R2;
      try { R2 = await runReports(rShares, want, opts, rBars, rRecent, rExt); }
      catch (e) { return json({ error: 'reports failed' }, 500, origin); }
      return json({ ok: true, date: rDate, v: _WV, picks: R2.picks, held: held,
        graded: R2.graded, bars: Object.keys(rBars).length,
        servable: servable, days: rDeep, deepNeeded: _DEEP_DAYS }, 200, origin);
    }

    if (method === 'POST' && url.pathname === '/scan') {
      if (gate.configured && !gate.ok) return locked();
      if (_bodyTooBig(request)) return json({ error: 'payload too large' }, 413, origin);
      let sp;
      try { sp = await request.json(); } catch (e) { return json({ error: 'bad json body' }, 400, origin); }
      const sExch = String((sp && sp.exch) || 'ASX').slice(0, 8);
      { const g = await _nyseGate(env, sExch, origin); if (g) return g; } // w406
      const sDate = String((sp && sp.dataDate) || '').slice(0, 24);
      const need = (sp && +sp.need > 0) ? +sp.need : 0;
      const sShares = _capShares((sp && Array.isArray(sp.shares)) ? sp.shares : []);
      // `fp` may be sent WITHOUT the shares: the cheap probe asking "is today
      // already done?" without uploading tens of megabytes. It is the caller's
      // claim about their own payload, which is fine for a LOOKUP — a wrong
      // claim just misses — and is never trusted when STORING (see below).
      const sFp = sShares.length ? _fingerprint(sShares) : (sp && sp.pantry === true ? 'pantry' : String((sp && sp.fp) || '').slice(0, 16));
      const cache = caches.default;
      const sKey = new Request(url.origin + '/scan-cache?exch=' + encodeURIComponent(sExch) +
        '&date=' + encodeURIComponent(sDate) + '&need=' + need + '&fp=' + encodeURIComponent(sFp), { method: 'GET' });
      if (sDate && sFp) {
        const hit = await cache.match(sKey);
        if (hit) {
          const h = new Headers(hit.headers);
          for (const [k, v] of Object.entries(corsHeaders(origin))) h.set(k, v);
          h.set('X-Insight-Scan', 'HIT');
          return new Response(hit.body, { status: 200, headers: h });
        }
      }
      if (sDate && sFp) {
        const d1v = await _d1cGet(env, sKey.url);
        if (d1v) {
          try { ctx.waitUntil(cache.put(sKey, new Response(d1v, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${GRADE_CACHE_SECONDS}` } }))); } catch (e) {}
          return new Response(d1v, { status: 200, headers: { 'Content-Type': 'application/json', 'X-Insight-Scan': 'D1', ...corsHeaders(origin) } });
        }
      }
      // ---- w504 PANTRY MODE ------------------------------------------------
      // `pantry:true` with no shares asks the worker to grade from its OWN
      // bars table via _pantrySeries (w419) - the exact machinery the admin
      // backtests already trust - instead of receiving a tens-of-megabytes
      // upload of data this store holds 99% complete. Three gates decide
      // whether the pantry may answer, and every refusal NAMES itself (ok:false
      // + why) so the app falls back to the upload path without guessing:
      //   floor - below $50k the generous prefilter would read most of the
      //           exchange's 560-day tail (millions of D1 rows); refused, the
      //           upload path still serves "Any".
      //   date  - the pantry answers only for ITS newest day. A caller asking
      //           about a different day is told so, never answered about the
      //           wrong day dressed as the right one.
      //   depth - under 50 shares clearing the prefilter means the store is
      //           thin here; refused rather than graded thin.
      // Cache: fp='pantry' - safe to SHARE between callers, unlike upload
      // fingerprints (the w474 oracle rule), because no caller supplied any
      // input: the payload IS the server's own store. The first device each
      // day pays the D1 read; every later one hits the cache for free.
      let sEff = sShares, sPantry = false;
      if (!sShares.length && sp && sp.pantry === true) {
        if (!(need >= 50000)) return json({ ok: false, why: 'floor too low for pantry mode' }, 200, origin);
        const pNew = await env.MARKET_DB.prepare('SELECT MAX(d) AS d FROM bars WHERE exch=?').bind(sExch).first().catch(() => null);
        const pDay = (pNew && pNew.d) ? String(pNew.d).slice(0, 10) : '';
        if (!pDay || pDay !== String(sDate).slice(0, 10))
          return json({ ok: false, why: 'pantry not at that day', pantryDay: pDay }, 200, origin);
        if (await _rlOver(env, 'scan|' + _ip(request), 40, 3600))
          return json({ error: 'too many scans in the last hour' }, 429, origin);
        const ps = await _pantrySeries(env, sExch, need).catch(() => null);
        if (!ps || !Array.isArray(ps.shares) || ps.shares.length < 50)
          return json({ ok: false, why: 'pantry too thin for this floor' }, 200, origin);
        sEff = _capShares(ps.shares); sPantry = true;
      }
      if (!sEff.length) return json({ error: 'no shares supplied' }, 400, origin);
      // A real replay is expensive, so it is also rate-limited per caller.
      if (!sPantry && await _rlOver(env, 'scan|' + _ip(request), 40, 3600))
        return json({ error: 'too many scans in the last hour' }, 429, origin);
      const { FACTS, COV } = await _scanNewsMaps(env, sExch);
      let R, todayFires;
      try { R = scanReplay(sEff, need, FACTS, COV, sExch); }
      catch (e) { return json({ error: 'replay failed' }, 500, origin); }
      // w392: today's firing signals ride back with the year's grades, derived
      // from the same series. This is what replaced the day-mode oracle, and it
      // saves the app a second round trip as well.
      try { todayFires = scanToday(sEff, FACTS, COV, sDate); }
      catch (e) { todayFires = null; }
      // The date the firing list belongs to travels WITH it. A year's grades
      // age gracefully and may be reused tomorrow; a list of which shares fired
      // today does not, and must be refusable by the app on sight.
      if (R) R.todayDate = sDate;
      if (!R) return json({ ok: true, date: sDate, mode: 'replay', R: null, todayFires, todayDate: sDate, why: 'not enough history' }, 200, origin);
      const sBody = JSON.stringify({ ok: true, date: sDate, mode: 'replay', src: (sPantry ? 'pantry' : 'upload'), R, todayFires, todayDate: sDate });
      // Only ever cached under a key derived from the payload WE fingerprinted.
      if (sDate) {
        const toCache = new Response(sBody, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${GRADE_CACHE_SECONDS}` } });
        ctx.waitUntil(cache.put(new Request(url.origin + '/scan-cache?exch=' + encodeURIComponent(sExch) +
          '&date=' + encodeURIComponent(sDate) + '&need=' + need + '&fp=' + encodeURIComponent(sPantry ? 'pantry' : _fingerprint(sShares)), { method: 'GET' }), toCache));
        try { _d1cPut(env, ctx, url.origin + '/scan-cache?exch=' + encodeURIComponent(sExch) + '&date=' + encodeURIComponent(sDate) + '&need=' + need + '&fp=' + encodeURIComponent(sPantry ? 'pantry' : _fingerprint(sShares)), sBody); } catch (e) {}
      }
      return new Response(sBody, { status: 200, headers: { 'Content-Type': 'application/json', 'X-Insight-Scan': 'FRESH', ...corsHeaders(origin) } });
    }

    // ---- GET /admin/backtest-streaks — w428: does a longer up or down price
    //      streak actually predict a bigger forward move, isolated from
    //      volume/accumulation entirely (which Accum conflated together).
    if (url.pathname === '/admin/backtest-streaks') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exch2 = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      let pan2;
      try { pan2 = await _pantrySeries(env, exch2, 50000); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!pan2 || !pan2.shares || !pan2.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let out2;
      try { out2 = _streakReplay(pan2.shares, 250000); }
      catch (e) { return json({ error: 'replay failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!out2) return json({ error: 'not enough stored history yet to replay (need a few months)' }, 503, origin);
      return json({ ok: true, exch: exch2, universe: pan2.universe, from: pan2.from, result: out2 }, 200, origin);
    }

    // ---- GET /admin/evidence-top7 — w433: every day in the replay, which
    //      shares had the strongest PROVEN signal firing that day, and what
    //      did those actual shares (real tickers, listed out) do over the
    //      next hold window? One hold per call — the admin panel calls this
    //      three times (5/10/30) rather than one request doing all three,
    //      to stay well inside the request's CPU-time budget.
    if (url.pathname === '/admin/evidence-top7') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exch4 = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const hold4 = [5, 10, 30].includes(+url.searchParams.get('hold')) ? +url.searchParams.get('hold') : 5;
      const topN4 = Math.max(1, Math.min(20, +url.searchParams.get('n') || 7));
      const noETF4 = url.searchParams.get('excludeETF') === '1'; // w435
      const noNonEq4 = url.searchParams.get('excludeNonEquity') === '1'; // w436: ETFs + hybrids/preference shares + govt bonds, combined
      const excl4 = noNonEq4 ? _NONEQUITY_EXCLUDE : (noETF4 ? _ETF_EXCLUDE : null);
      let pan4;
      try { pan4 = await _pantrySeries(env, exch4, 50000); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!pan4 || !pan4.shares || !pan4.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let out4;
      try { out4 = _evidenceTopN(pan4.shares, hold4, 250000, topN4, excl4); }
      catch (e) { return json({ error: 'evidence-top7 failed', detail: String((e && e.message) || e) }, 500, origin); }
      return json({ ok: true, exch: exch4, universe: pan4.universe, from: pan4.from, excludedETF: noETF4, excludedNonEquity: noNonEq4, result: out4 }, 200, origin);
    }

    // w437 — Tony's dip-ladder backtest: 6 weeks back, first 2 weeks as an
    // entry window using the same best-evidence top-N-per-day selection as
    // /admin/evidence-top7 (restricted to those specific days), four parallel
    // entries per candidate (three limit dips + market), tracked through the
    // full 6 weeks with a trailing stop, an uncapped 5%-step profit ladder,
    // and a one-time 50% scale-out at +20% (app's own v384 default).
    if (url.pathname === '/admin/dip-ladder-backtest') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exch5 = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const q = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const params5 = {
        entryWeeks: Math.max(1, Math.min(4, q('entryWeeks', 2))),
        totalWeeks: Math.max(2, Math.min(12, q('totalWeeks', 6))),
        topN: Math.max(1, Math.min(20, q('topN', 7))),
        amountPerLevel: Math.max(1, q('amount', 5000)),
        trailPct: Math.max(0, q('trailPct', 10)),
        ladderStep: Math.max(0, q('ladderStep', 5)),
        ladderMargin: Math.max(0, q('ladderMargin', 0)), // no separate margin was specified — honest assumption, not a silent guess
        scaleTrigger: Math.max(0, q('scaleTrigger', 20)),
        scalePct: Math.max(0, Math.min(100, q('scalePct', 50))), // app's own v384 default
        levels: [-10, -5, -2.5, 0],
        liqFloor: Math.max(1, q('liqFloor', 250000))
      };
      let pan5;
      try { pan5 = await _pantrySeriesOHLC(env, exch5, params5.liqFloor); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!pan5 || !pan5.shares || !pan5.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let out5;
      try { out5 = _dipLadderBacktest(pan5.shares, params5); }
      catch (e) { return json({ error: 'dip-ladder backtest failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (out5 && out5.error) return json({ error: out5.error }, 400, origin);
      return json({ ok: true, exch: exch5, universe: pan5.universe, result: out5 }, 200, origin);
    }

    // w439 — Tony's follow-up: same test, broader (default 12 months) and
    // buying every week rather than once.
    if (url.pathname === '/admin/dip-ladder-backtest-recurring') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exch6 = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const q6 = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const params6 = {
        entryDays: Math.max(1, Math.min(10, q6('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(104, q6('totalWeeks', 52))),
        topN: Math.max(1, Math.min(20, q6('topN', 7))),
        amountPerLevel: Math.max(1, q6('amount', 5000)),
        trailPct: Math.max(0, q6('trailPct', 10)),
        ladderStep: Math.max(0, q6('ladderStep', 5)),
        ladderMargin: Math.max(0, q6('ladderMargin', 0)),
        scaleTrigger: Math.max(0, q6('scaleTrigger', 20)),
        scalePct: Math.max(0, Math.min(100, q6('scalePct', 50))),
        levels: [-10, -5, -2.5, 0],
        liqFloor: Math.max(1, q6('liqFloor', 250000))
      };
      let pan6;
      try { pan6 = await _pantrySeriesOHLC(env, exch6, params6.liqFloor); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!pan6 || !pan6.shares || !pan6.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let out6;
      try { out6 = _dipLadderBacktestRecurring(pan6.shares, params6); }
      catch (e) { return json({ error: 'recurring dip-ladder backtest failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (out6 && out6.error) return json({ error: out6.error }, 400, origin);
      return json({ ok: true, exch: exch6, universe: pan6.universe, result: out6 }, 200, origin);
    }

    // w440 — Tony's follow-up: same weekly-recurring structure, but a
    // simple fixed target/stop exit (no trailing stop, no ladder, no
    // scale-out) and GLOBAL dedupe ("don't buy same share twice"). Runs
    // BOTH requested combinations (10%/10% and 5%/10%) against the SAME
    // single pantry fetch and grading pass, for a direct side-by-side.
    if (url.pathname === '/admin/dip-ladder-backtest-fixedts') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exch7 = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const q7 = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const base7 = {
        entryDays: Math.max(1, Math.min(10, q7('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(104, q7('totalWeeks', 52))),
        topN: Math.max(1, Math.min(20, q7('topN', 7))),
        amountPerLevel: Math.max(1, q7('amount', 5000)),
        levels: [-10, -5, -2.5, 0],
        liqFloor: Math.max(1, q7('liqFloor', 250000))
      };
      let pan7;
      try { pan7 = await _pantrySeriesOHLC(env, exch7, base7.liqFloor); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!pan7 || !pan7.shares || !pan7.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outA, outB;
      try {
        outA = _dipLadderBacktestFixedTS(pan7.shares, Object.assign({}, base7, { targetPct: 10, stopPct: 10 }));
        outB = _dipLadderBacktestFixedTS(pan7.shares, Object.assign({}, base7, { targetPct: 5, stopPct: 10 }));
      } catch (e) { return json({ error: 'fixed target/stop backtest failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (outA && outA.error) return json({ error: outA.error }, 400, origin);
      if (outB && outB.error) return json({ error: outB.error }, 400, origin);
      return json({ ok: true, exch: exch7, universe: pan7.universe, combos: [
        { label: '10% target / 10% stop', result: outA },
        { label: '5% target / 10% stop', result: outB }
      ] }, 200, origin);
    }

    // w443 — Tony's fine-tune: same once-only, 4-level fixed target/stop
    // rig, but top 4 by evidence instead of top 7, and 10%/10% vs 7%/10%
    // instead of 10%/10% vs 5%/10%. Reuses _dipLadderBacktestFixedTS
    // completely unchanged — this is purely new parameter values, not new
    // logic, so no fresh simulation code was needed here.
    if (url.pathname === '/admin/dip-ladder-backtest-fixedts-top4') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchA = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qA = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const baseA = {
        entryDays: Math.max(1, Math.min(10, qA('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(104, qA('totalWeeks', 52))),
        topN: Math.max(1, Math.min(20, qA('topN', 4))),
        amountPerLevel: Math.max(1, qA('amount', 5000)),
        levels: [-10, -5, -2.5, 0],
        liqFloor: Math.max(1, qA('liqFloor', 250000))
      };
      let panA;
      try { panA = await _pantrySeriesOHLC(env, exchA, baseA.liqFloor); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panA || !panA.shares || !panA.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outE, outF;
      try {
        outE = _dipLadderBacktestFixedTS(panA.shares, Object.assign({}, baseA, { targetPct: 10, stopPct: 10 }));
        outF = _dipLadderBacktestFixedTS(panA.shares, Object.assign({}, baseA, { targetPct: 7, stopPct: 10 }));
      } catch (e) { return json({ error: 'fixed target/stop (top-4) backtest failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (outE && outE.error) return json({ error: outE.error }, 400, origin);
      if (outF && outF.error) return json({ error: outF.error }, 400, origin);
      return json({ ok: true, exch: exchA, universe: panA.universe, combos: [
        { label: '10% target / 10% stop', result: outE },
        { label: '7% target / 10% stop', result: outF }
      ] }, 200, origin);
    }

    // w444 — Tony's fine-tune: same as the top-4 comparison, but the
    // evidence filter now requires a computed score of 7+ (matching the
    // app's own "min score" auto-pilot gate) instead of simply excluding
    // 'early' tier — lets through solid signals plus any strong-promising
    // ones scoring as well as a solid one would.
    if (url.pathname === '/admin/dip-ladder-backtest-fixedts-scored') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchB = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qB = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const baseB = {
        entryDays: Math.max(1, Math.min(10, qB('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(104, qB('totalWeeks', 52))),
        topN: Math.max(1, Math.min(20, qB('topN', 4))),
        amountPerLevel: Math.max(1, qB('amount', 5000)),
        minScore: Math.max(0, Math.min(10, qB('minScore', 7))),
        levels: [-10, -5, -2.5, 0],
        liqFloor: Math.max(1, qB('liqFloor', 250000))
      };
      let panB;
      try { panB = await _pantrySeriesOHLC(env, exchB, baseB.liqFloor); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panB || !panB.shares || !panB.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outG, outH;
      try {
        outG = _dipLadderBacktestFixedTSScored(panB.shares, Object.assign({}, baseB, { targetPct: 10, stopPct: 10 }));
        outH = _dipLadderBacktestFixedTSScored(panB.shares, Object.assign({}, baseB, { targetPct: 7, stopPct: 10 }));
      } catch (e) { return json({ error: 'fixed target/stop (scored) backtest failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (outG && outG.error) return json({ error: outG.error }, 400, origin);
      if (outH && outH.error) return json({ error: outH.error }, 400, origin);
      return json({ ok: true, exch: exchB, universe: panB.universe, combos: [
        { label: '10% target / 10% stop', result: outG },
        { label: '7% target / 10% stop', result: outH }
      ] }, 200, origin);
    }

    // w445 — a real cap on concurrent positions (matching the app's own
    // maxPositions setting), rather than assuming every evidence pick gets
    // bought at once. Capital required is now a fixed, known number:
    // maxPositions * amountPerLevel.
    if (url.pathname === '/admin/dip-ladder-backtest-capped') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchC = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qC = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const baseC = {
        entryDays: Math.max(1, Math.min(10, qC('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(104, qC('totalWeeks', 52))),
        topN: Math.max(1, Math.min(20, qC('topN', 4))),
        amountPerLevel: Math.max(1, qC('amount', 5000)),
        minScore: Math.max(0, Math.min(10, qC('minScore', 7))),
        buyLevel: qC('buyLevel', -5),
        maxPositions: Math.max(1, Math.min(50, qC('maxPositions', 8))),
        liqFloor: Math.max(1, qC('liqFloor', 250000))
      };
      let panC;
      try { panC = await _pantrySeriesOHLC(env, exchC, baseC.liqFloor); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panC || !panC.shares || !panC.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outI, outJ;
      try {
        outI = _dipLadderBacktestCapped(panC.shares, Object.assign({}, baseC, { targetPct: 10, stopPct: 10 }));
        outJ = _dipLadderBacktestCapped(panC.shares, Object.assign({}, baseC, { targetPct: 7, stopPct: 10 }));
      } catch (e) { return json({ error: 'capped dip-ladder backtest failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (outI && outI.error) return json({ error: outI.error }, 400, origin);
      if (outJ && outJ.error) return json({ error: outJ.error }, 400, origin);
      return json({ ok: true, exch: exchC, universe: panC.universe, combos: [
        { label: '10% target / 10% stop', result: outI },
        { label: '7% target / 10% stop', result: outJ }
      ] }, 200, origin);
    }

    // w446 — Tony asked what the evidence points to for the single best
    // target/stop pair, plus what else could help. Sweeps target AND stop
    // together (the stop has never been varied before, only the target),
    // with the ETF/hybrid/bond exclusion on by default (proven to help the
    // evidence-top7 edge earlier tonight, never applied to this framework
    // until now). Grades and builds the once-only candidate list ONCE,
    // then re-runs the cheap simulation per grid cell.
    if (url.pathname === '/admin/dip-ladder-grid-search') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchD = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qD = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const parseList = (raw, def) => { if (!raw) return def; const arr = raw.split(',').map(s => +s.trim()).filter(n => isFinite(n)); return arr.length ? arr : def; };
      const baseD = {
        entryDays: Math.max(1, Math.min(10, qD('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(104, qD('totalWeeks', 52))),
        topN: Math.max(1, Math.min(20, qD('topN', 4))),
        amountPerLevel: Math.max(1, qD('amount', 5000)),
        minScore: Math.max(0, Math.min(10, qD('minScore', 7))),
        targets: parseList(url.searchParams.get('targets'), [7, 10, 12, 15, 20]),
        stops: parseList(url.searchParams.get('stops'), [5, 7, 10, 12, 15]),
        excludeNonEquity: url.searchParams.get('excludeNonEquity') !== '0',
        liqFloor: Math.max(1, qD('liqFloor', 250000))
      };
      let panD;
      try { panD = await _pantrySeriesOHLC(env, exchD, baseD.liqFloor); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panD || !panD.shares || !panD.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outK;
      try { outK = _dipLadderGridSearch(panD.shares, baseD); }
      catch (e) { return json({ error: 'grid search failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (outK && outK.error) return json({ error: outK.error }, 400, origin);
      return json({ ok: true, exch: exchD, universe: panD.universe, result: outK }, 200, origin);
    }

    // w447 — the first grid was perfectly monotonic in BOTH directions at
    // every one of its 25 cells (wider target always won, wider stop always
    // won), meaning it found the edge of what was tested, not a peak. This
    // pushes the range further to see where — if anywhere — that stops
    // being true. Same engine, same once-only/score-filter/exclusion setup,
    // just wider targets and stops, with a couple of overlap points (15/20
    // target, 10/15 stop) kept so the two runs can be cross-checked.
    if (url.pathname === '/admin/dip-ladder-grid-search-extended') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchE = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qE = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const parseListE = (raw, def) => { if (!raw) return def; const arr = raw.split(',').map(s => +s.trim()).filter(n => isFinite(n)); return arr.length ? arr : def; };
      const baseE = {
        entryDays: Math.max(1, Math.min(10, qE('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(104, qE('totalWeeks', 52))),
        topN: Math.max(1, Math.min(20, qE('topN', 4))),
        amountPerLevel: Math.max(1, qE('amount', 5000)),
        minScore: Math.max(0, Math.min(10, qE('minScore', 7))),
        targets: parseListE(url.searchParams.get('targets'), [15, 20, 25, 30, 40]),
        stops: parseListE(url.searchParams.get('stops'), [10, 15, 20, 25, 30]),
        excludeNonEquity: url.searchParams.get('excludeNonEquity') !== '0',
        liqFloor: Math.max(1, qE('liqFloor', 250000))
      };
      let panE;
      try { panE = await _pantrySeriesOHLC(env, exchE, baseE.liqFloor); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panE || !panE.shares || !panE.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outL;
      try { outL = _dipLadderGridSearch(panE.shares, baseE); }
      catch (e) { return json({ error: 'extended grid search failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (outL && outL.error) return json({ error: outL.error }, 400, origin);
      return json({ ok: true, exch: exchE, universe: panE.universe, result: outL }, 200, origin);
    }

    // w448 — the extended grid found the FIRST interior peak anywhere in
    // this exploration (target 15/20% actually does worse at stop -30 than
    // -25), but everywhere else — every wider target, every wider stop for
    // target 25/30/40 — was STILL climbing at the edge, with the overall
    // winner still the widest corner tested (40/-30). This pushes further
    // into exactly that still-climbing region to find where it actually
    // turns over. Same engine, same setup. Keeps (30,-25)/(30,-30)/(40,-25)/
    // (40,-30) as overlap points against the previous run.
    if (url.pathname === '/admin/dip-ladder-grid-search-far') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchF = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qF = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const parseListF = (raw, def) => { if (!raw) return def; const arr = raw.split(',').map(s => +s.trim()).filter(n => isFinite(n)); return arr.length ? arr : def; };
      const baseF = {
        entryDays: Math.max(1, Math.min(10, qF('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(104, qF('totalWeeks', 52))),
        topN: Math.max(1, Math.min(20, qF('topN', 4))),
        amountPerLevel: Math.max(1, qF('amount', 5000)),
        minScore: Math.max(0, Math.min(10, qF('minScore', 7))),
        targets: parseListF(url.searchParams.get('targets'), [30, 40, 50, 60, 80]),
        stops: parseListF(url.searchParams.get('stops'), [25, 30, 40, 50, 60]),
        excludeNonEquity: url.searchParams.get('excludeNonEquity') !== '0',
        liqFloor: Math.max(1, qF('liqFloor', 250000))
      };
      let panF;
      try { panF = await _pantrySeriesOHLC(env, exchF, baseF.liqFloor); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panF || !panF.shares || !panF.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outM;
      try { outM = _dipLadderGridSearch(panF.shares, baseF); }
      catch (e) { return json({ error: 'far grid search failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (outM && outM.error) return json({ error: outM.error }, 400, origin);
      return json({ ok: true, exch: exchF, universe: panF.universe, result: outM }, 200, origin);
    }

    // w449 — three grid rounds in a row found the widest tested corner
    // still winning, with the pattern never once turning over. Before
    // pushing wider again, this checks WHY: for a handful of specific
    // pairs, it tallies how each position actually exited — target hit,
    // stop hit, or ran out the window still open. If wider pairs win
    // mostly by increasingly hitting window-end rather than a genuine
    // target, the "optimum" is measuring buy-and-hold over this one
    // mostly-rising year, not real exit discipline.
    if (url.pathname === '/admin/dip-ladder-grid-diagnostic') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchG = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qG = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const parsePairs = (raw, def) => {
        if (!raw) return def;
        const pairs = raw.split(';').map(p => p.split(',').map(s => +s.trim())).filter(p => p.length === 2 && p.every(n => isFinite(n)));
        return pairs.length ? pairs : def;
      };
      const baseG = {
        entryDays: Math.max(1, Math.min(10, qG('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(104, qG('totalWeeks', 52))),
        topN: Math.max(1, Math.min(20, qG('topN', 4))),
        amountPerLevel: Math.max(1, qG('amount', 5000)),
        minScore: Math.max(0, Math.min(10, qG('minScore', 7))),
        pairs: parsePairs(url.searchParams.get('pairs'), [[10, 10], [20, 15], [40, 30], [80, 60]]),
        excludeNonEquity: url.searchParams.get('excludeNonEquity') !== '0',
        liqFloor: Math.max(1, qG('liqFloor', 250000))
      };
      let panG;
      try { panG = await _pantrySeriesOHLC(env, exchG, baseG.liqFloor); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panG || !panG.shares || !panG.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outN;
      try { outN = _dipLadderGridDiagnostic(panG.shares, baseG); }
      catch (e) { return json({ error: 'grid diagnostic failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (outN && outN.error) return json({ error: outN.error }, 400, origin);
      return json({ ok: true, exch: exchG, universe: panG.universe, result: outN }, 200, origin);
    }

    // w449 — Tony's own read on why wider keeps winning: wider gap means
    // longer holds, which means fewer round-trips of the same capital and,
    // under a REAL position cap, more candidates turned away rather than
    // taken. This runs the capped backtest (the one with a real
    // maxPositions limit and a fixed, known capital figure) at the same
    // handful of pairs as the exit-reason diagnostic, so the cap-skip count
    // and hold time can be compared directly against the return on that
    // fixed capital -- not just the unlimited-buying-power total from the
    // grid search.
    if (url.pathname === '/admin/dip-ladder-capital-cost') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchH = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qH = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const parsePairsH = (raw, def) => {
        if (!raw) return def;
        const pairs = raw.split(';').map(p => p.split(',').map(s => +s.trim())).filter(p => p.length === 2 && p.every(n => isFinite(n)));
        return pairs.length ? pairs : def;
      };
      const baseH = {
        entryDays: Math.max(1, Math.min(10, qH('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(104, qH('totalWeeks', 52))),
        topN: Math.max(1, Math.min(20, qH('topN', 4))),
        amountPerLevel: Math.max(1, qH('amount', 5000)),
        minScore: Math.max(0, Math.min(10, qH('minScore', 7))),
        buyLevel: qH('buyLevel', -5),
        maxPositions: Math.max(1, Math.min(50, qH('maxPositions', 8))),
        liqFloor: Math.max(1, qH('liqFloor', 250000))
      };
      const pairsH = parsePairsH(url.searchParams.get('pairs'), [[10, 10], [20, 15], [40, 30], [80, 60]]);
      let panH;
      try { panH = await _pantrySeriesOHLC(env, exchH, baseH.liqFloor); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panH || !panH.shares || !panH.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      const rowsH = [];
      try {
        for (const pair of pairsH) {
          const out = _dipLadderBacktestCapped(panH.shares, Object.assign({}, baseH, { targetPct: pair[0], stopPct: pair[1] }));
          if (out && out.error) return json({ error: out.error }, 400, origin);
          rowsH.push({ targetPct: pair[0], stopPct: pair[1], fixedCapitalRequired: out.fixedCapitalRequired, summary: out.summary });
        }
      } catch (e) { return json({ error: 'capital cost comparison failed', detail: String((e && e.message) || e) }, 500, origin); }
      return json({ ok: true, exch: exchH, universe: panH.universe, maxPositions: baseH.maxPositions, rows: rowsH }, 200, origin);
    }

    // w451 — Tony asked to run the capital-cost comparison over 3 years
    // instead of 1, since a single mostly-rising year is exactly the kind
    // of sample that would make "wider is better" look stronger than it
    // really is. Same comparison, same pairs, same real position cap —
    // just a 156-week window instead of 52, using the longer-history
    // fetch so it isn't silently truncated to ~2.15 years by the normal
    // 560-bar pantry read.
    if (url.pathname === '/admin/dip-ladder-capital-cost-3yr') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchI = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qI = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const parsePairsI = (raw, def) => {
        if (!raw) return def;
        const pairs = raw.split(';').map(p => p.split(',').map(s => +s.trim())).filter(p => p.length === 2 && p.every(n => isFinite(n)));
        return pairs.length ? pairs : def;
      };
      const baseI = {
        entryDays: Math.max(1, Math.min(10, qI('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(525, qI('totalWeeks', 140))),
        topN: Math.max(1, Math.min(20, qI('topN', 4))),
        amountPerLevel: Math.max(1, qI('amount', 5000)),
        minScore: Math.max(0, Math.min(10, qI('minScore', 7))),
        buyLevel: qI('buyLevel', -5),
        maxPositions: Math.max(1, Math.min(50, qI('maxPositions', 8))),
        liqFloor: Math.max(1, qI('liqFloor', 250000))
      };
      const pairsI = parsePairsI(url.searchParams.get('pairs'), [[10, 10], [20, 15], [40, 30], [80, 60]]);
      let panI;
      try { panI = await _pantrySeriesOHLCLong(env, exchI, baseI.liqFloor, _maxBars(url)); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panI || !panI.shares || !panI.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      const rowsI = [];
      try {
        for (const pair of pairsI) {
          const out = _dipLadderBacktestCapped(panI.shares, Object.assign({}, baseI, { targetPct: pair[0], stopPct: pair[1] }));
          if (out && out.error) return json({ error: out.error, requestedWeeks: baseI.totalWeeks, historyFrom: panI.from }, 200, origin);
          rowsI.push({ targetPct: pair[0], stopPct: pair[1], fixedCapitalRequired: out.fixedCapitalRequired, windowStartDate: out.windowStartDate, windowEndDate: out.windowEndDate, summary: out.summary });
        }
      } catch (e) { return json({ error: '3-year capital cost comparison failed', detail: String((e && e.message) || e) }, 500, origin); }
      return json({ ok: true, exch: exchI, universe: panI.universe, historyFrom: panI.from, maxPositions: baseI.maxPositions, rows: rowsI }, 200, origin);
    }

    // w452 — Tony asked to check 10/15, 15/15, 20/20 specifically — filling
    // in around the 20/15 zone that looked most defensible, rather than the
    // wide spread from before. Same capped mechanism, same everything, just
    // these three pairs. 1-year version.
    if (url.pathname === '/admin/dip-ladder-capital-cost-narrow') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchJ = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qJ = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const parsePairsJ = (raw, def) => {
        if (!raw) return def;
        const pairs = raw.split(';').map(p => p.split(',').map(s => +s.trim())).filter(p => p.length === 2 && p.every(n => isFinite(n)));
        return pairs.length ? pairs : def;
      };
      const baseJ = {
        entryDays: Math.max(1, Math.min(10, qJ('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(104, qJ('totalWeeks', 52))),
        topN: Math.max(1, Math.min(20, qJ('topN', 4))),
        amountPerLevel: Math.max(1, qJ('amount', 5000)),
        minScore: Math.max(0, Math.min(10, qJ('minScore', 7))),
        buyLevel: qJ('buyLevel', -5),
        maxPositions: Math.max(1, Math.min(50, qJ('maxPositions', 8))),
        liqFloor: Math.max(1, qJ('liqFloor', 250000))
      };
      const pairsJ = parsePairsJ(url.searchParams.get('pairs'), [[10, 15], [15, 15], [20, 20]]);
      let panJ;
      try { panJ = await _pantrySeriesOHLC(env, exchJ, baseJ.liqFloor); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panJ || !panJ.shares || !panJ.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      const rowsJ = [];
      try {
        for (const pair of pairsJ) {
          const out = _dipLadderBacktestCapped(panJ.shares, Object.assign({}, baseJ, { targetPct: pair[0], stopPct: pair[1] }));
          if (out && out.error) return json({ error: out.error }, 400, origin);
          rowsJ.push({ targetPct: pair[0], stopPct: pair[1], fixedCapitalRequired: out.fixedCapitalRequired, windowStartDate: out.windowStartDate, windowEndDate: out.windowEndDate, summary: out.summary });
        }
      } catch (e) { return json({ error: 'narrow capital cost comparison failed', detail: String((e && e.message) || e) }, 500, origin); }
      return json({ ok: true, exch: exchJ, universe: panJ.universe, maxPositions: baseJ.maxPositions, rows: rowsJ }, 200, origin);
    }

    // w452 — same three pairs (10/15, 15/15, 20/20), 3-year version.
    if (url.pathname === '/admin/dip-ladder-capital-cost-narrow-3yr') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchK = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qK = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const parsePairsK = (raw, def) => {
        if (!raw) return def;
        const pairs = raw.split(';').map(p => p.split(',').map(s => +s.trim())).filter(p => p.length === 2 && p.every(n => isFinite(n)));
        return pairs.length ? pairs : def;
      };
      const baseK = {
        entryDays: Math.max(1, Math.min(10, qK('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(525, qK('totalWeeks', 140))),
        topN: Math.max(1, Math.min(20, qK('topN', 4))),
        amountPerLevel: Math.max(1, qK('amount', 5000)),
        minScore: Math.max(0, Math.min(10, qK('minScore', 7))),
        buyLevel: qK('buyLevel', -5),
        maxPositions: Math.max(1, Math.min(50, qK('maxPositions', 8))),
        liqFloor: Math.max(1, qK('liqFloor', 250000))
      };
      const pairsK = parsePairsK(url.searchParams.get('pairs'), [[10, 15], [15, 15], [20, 20]]);
      let panK;
      try { panK = await _pantrySeriesOHLCLong(env, exchK, baseK.liqFloor, _maxBars(url)); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panK || !panK.shares || !panK.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      const rowsK = [];
      try {
        for (const pair of pairsK) {
          const out = _dipLadderBacktestCapped(panK.shares, Object.assign({}, baseK, { targetPct: pair[0], stopPct: pair[1] }));
          if (out && out.error) return json({ error: out.error, requestedWeeks: baseK.totalWeeks, historyFrom: panK.from }, 200, origin);
          rowsK.push({ targetPct: pair[0], stopPct: pair[1], fixedCapitalRequired: out.fixedCapitalRequired, windowStartDate: out.windowStartDate, windowEndDate: out.windowEndDate, summary: out.summary });
        }
      } catch (e) { return json({ error: 'narrow 3-year capital cost comparison failed', detail: String((e && e.message) || e) }, 500, origin); }
      return json({ ok: true, exch: exchK, universe: panK.universe, historyFrom: panK.from, maxPositions: baseK.maxPositions, rows: rowsK }, 200, origin);
    }

    // w457 — Tony asked to run 15/15 over the ~2.7-year window, starting
    // with $50,000 and COMPOUNDING, rather than a fixed dollar amount per
    // trade. Uses the same longer-history fetch as the other ~2.7-year
    // routes (900-bar cap, 140-week default).
    if (url.pathname === '/admin/dip-ladder-compounding') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchM = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qM = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const baseM = {
        entryDays: Math.max(1, Math.min(10, qM('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(525, qM('totalWeeks', 140))),
        topN: Math.max(1, Math.min(20, qM('topN', 4))),
        minScore: Math.max(0, Math.min(10, qM('minScore', 7))),
        buyLevel: qM('buyLevel', -5),
        targetPct: Math.max(0, qM('targetPct', 15)), stopPct: Math.max(0, qM('stopPct', 15)),
        maxPositions: Math.max(1, Math.min(50, qM('maxPositions', 8))),
        startingCapital: Math.max(1, qM('startingCapital', 50000)),
        excludeNonEquity: url.searchParams.get('excludeNonEquity') !== '0',
        liqFloor: Math.max(1, qM('liqFloor', 250000))
      };
      let panM;
      try { panM = await _pantrySeriesOHLCLong(env, exchM, baseM.liqFloor, _maxBars(url)); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panM || !panM.shares || !panM.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outP;
      try { outP = _dipLadderCompounding(panM.shares, baseM); }
      catch (e) { return json({ error: 'compounding backtest failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (outP && outP.error) return json({ error: outP.error, requestedWeeks: baseM.totalWeeks, historyFrom: panM.from }, 200, origin);
      return json({ ok: true, exch: exchM, universe: panM.universe, historyFrom: panM.from, result: outP }, 200, origin);
    }

    // w462 — Tony checked which score everything tonight has actually been
    // filtering on (the signal report card's tier/edge/fire-count score, NOT
    // the Watch Score) and asked to run the same compounding test using the
    // OTHER score instead, so the two can be compared directly rather than
    // assumed. Same window, same target/stop/dip, same cap — only the
    // candidate scoring/filtering method changes.
    if (url.pathname === '/admin/dip-ladder-compounding-watchscore') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchW = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qW = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const baseW = {
        entryDays: Math.max(1, Math.min(10, qW('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(525, qW('totalWeeks', 140))),
        topN: Math.max(1, Math.min(20, qW('topN', 4))),
        minScore: Math.max(0, Math.min(10, qW('minScore', 7))),
        buyLevel: qW('buyLevel', -5),
        targetPct: Math.max(0, qW('targetPct', 15)), stopPct: Math.max(0, qW('stopPct', 15)),
        maxPositions: Math.max(1, Math.min(50, qW('maxPositions', 8))),
        startingCapital: Math.max(1, qW('startingCapital', 50000)),
        excludeNonEquity: url.searchParams.get('excludeNonEquity') !== '0',
        liqFloor: Math.max(1, qW('liqFloor', 250000))
      };
      let panW;
      try { panW = await _pantrySeriesOHLCLong(env, exchW, baseW.liqFloor, _maxBars(url)); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panW || !panW.shares || !panW.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outW;
      try { outW = _dipLadderCompoundingWatchScore(panW.shares, baseW); }
      catch (e) { return json({ error: 'watch-score compounding backtest failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (outW && outW.error) return json({ error: outW.error, requestedWeeks: baseW.totalWeeks, historyFrom: panW.from }, 200, origin);
      return json({ ok: true, exch: exchW, universe: panW.universe, historyFrom: panW.from, result: outW }, 200, origin);
    }

    // w465 — Tony's price-band question, parked the EODData 401 for now:
    // same agreed 15/15, same -5% dip, same everything, but run as five
    // INDEPENDENT $50,000 compounding tests, one per share-price tier, over
    // the same ~2.7-year window that already works. Reuses the 900-bar
    // long fetch unchanged; only the simulation function differs.
    if (url.pathname === '/admin/dip-ladder-compounding-pricebands') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchPB = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qPB = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const basePB = {
        entryDays: Math.max(1, Math.min(10, qPB('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(525, qPB('totalWeeks', 140))),
        topN: Math.max(1, Math.min(20, qPB('topN', 4))),
        minScore: Math.max(0, Math.min(10, qPB('minScore', 7))),
        buyLevel: qPB('buyLevel', -5),
        targetPct: Math.max(0, qPB('targetPct', 15)), stopPct: Math.max(0, qPB('stopPct', 15)),
        maxPositions: Math.max(1, Math.min(50, qPB('maxPositions', 8))),
        startingCapital: Math.max(1, qPB('startingCapital', 50000)),
        excludeNonEquity: url.searchParams.get('excludeNonEquity') !== '0',
        liqFloor: Math.max(1, qPB('liqFloor', 250000))
      };
      let panPB;
      try { panPB = await _pantrySeriesOHLCLong(env, exchPB, basePB.liqFloor, _maxBars(url)); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panPB || !panPB.shares || !panPB.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outPB;
      try { outPB = _dipLadderCompoundingByPriceBand(panPB.shares, basePB); }
      catch (e) { return json({ error: 'price-band compounding backtest failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (outPB && outPB.error) return json({ error: outPB.error, requestedWeeks: basePB.totalWeeks, historyFrom: panPB.from }, 200, origin);
      return json({ ok: true, exch: exchPB, universe: panPB.universe, historyFrom: panPB.from, result: outPB }, 200, origin);
    }

    // w466 — Tony's follow-up: same rules, but 10/10 and 20/15 instead of
    // 15/15, top-6/day instead of top-4, over two FIXED, overlapping ranges
    // ($0.20-$1.50 and $0.20-$0.99, not a 5-way partition) rather than the
    // full price-band split above. Same underlying function, just a
    // different (and smaller, purpose-built) set of bands and a
    // configurable target/stop/topN via query params.
    if (url.pathname === '/admin/dip-ladder-compounding-pricebands-custom') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchPC = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qPC = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const basePC = {
        entryDays: Math.max(1, Math.min(10, qPC('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(525, qPC('totalWeeks', 140))),
        topN: Math.max(1, Math.min(20, qPC('topN', 4))),
        minScore: Math.max(0, Math.min(10, qPC('minScore', 7))),
        buyLevel: qPC('buyLevel', -5),
        targetPct: Math.max(0, qPC('targetPct', 15)), stopPct: Math.max(0, qPC('stopPct', 15)),
        maxPositions: Math.max(1, Math.min(50, qPC('maxPositions', 8))),
        startingCapital: Math.max(1, qPC('startingCapital', 50000)),
        excludeNonEquity: url.searchParams.get('excludeNonEquity') !== '0',
        liqFloor: Math.max(1, qPC('liqFloor', 250000)),
        bands: [
          { label: '$0.20 \u2013 $1.50', min: 0.20, max: 1.50 },
          { label: '$0.20 \u2013 $0.99', min: 0.20, max: 0.99 }
        ]
      };
      let panPC;
      try { panPC = await _pantrySeriesOHLCLong(env, exchPC, basePC.liqFloor, _maxBars(url)); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panPC || !panPC.shares || !panPC.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outPC;
      try { outPC = _dipLadderCompoundingByPriceBand(panPC.shares, basePC); }
      catch (e) { return json({ error: 'custom price-band compounding backtest failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (outPC && outPC.error) return json({ error: outPC.error, requestedWeeks: basePC.totalWeeks, historyFrom: panPC.from }, 200, origin);
      return json({ ok: true, exch: exchPC, universe: panPC.universe, historyFrom: panPC.from, result: outPC }, 200, origin);
    }

    // w468 — Tony's follow-up: slightly widen the range ($0.20-$1.50 to
    // $0.15-$1.75), same $0.20-$0.99 for comparison, and add buyLevel as a
    // query param so the SAME route can be called once at -5% (dip) and
    // once at 0 (market) for a direct dip-vs-no-dip comparison. A new route
    // (not editing the one above) since its bands are hard-coded and other
    // buttons still depend on those exact boundaries.
    if (url.pathname === '/admin/dip-ladder-compounding-pricebands-v2') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchV2 = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qV2 = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const baseV2 = {
        entryDays: Math.max(1, Math.min(10, qV2('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(525, qV2('totalWeeks', 140))),
        topN: Math.max(1, Math.min(20, qV2('topN', 4))),
        minScore: Math.max(0, Math.min(10, qV2('minScore', 7))),
        buyLevel: qV2('buyLevel', -5),
        targetPct: Math.max(0, qV2('targetPct', 20)), stopPct: Math.max(0, qV2('stopPct', 15)),
        maxPositions: Math.max(1, Math.min(50, qV2('maxPositions', 8))),
        startingCapital: Math.max(1, qV2('startingCapital', 50000)),
        excludeNonEquity: url.searchParams.get('excludeNonEquity') !== '0',
        liqFloor: Math.max(1, qV2('liqFloor', 250000)),
        gradeDays: Math.max(0, Math.min(3000, qV2('gradeDays', 0))),
        exitMode: (url.searchParams.get('exitMode') === 'trail') ? 'trail' : 'fixed',
        // w496 — the pullback arm, drivable from the sweep button.
        entryMode: (url.searchParams.get('entryMode') === 'pullback') ? 'pullback' : 'dip',
        pullWaitDays: +url.searchParams.get('pullWaitDays') || 5,
        pullMinPct: url.searchParams.has('pullMinPct') ? +url.searchParams.get('pullMinPct') : 5,
        pullMaxPct: url.searchParams.has('pullMaxPct') ? +url.searchParams.get('pullMaxPct') : 10,
        trailPct: Math.max(0, Math.min(90, qV2('trailPct', 0))),
        feePerSide: Math.max(0, Math.min(500, qV2('feePerSide', 0))),
        slipPct: Math.max(0, Math.min(10, qV2('slipPct', 0))),
        bands: [
          { label: '$0.15 \u2013 $1.75', min: 0.15, max: 1.75 },
          { label: '$0.20 \u2013 $0.99', min: 0.20, max: 0.99 }
        ]
      };
      let panV2;
      try { panV2 = await _pantrySeriesOHLCLong(env, exchV2, baseV2.liqFloor, _maxBars(url)); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panV2 || !panV2.shares || !panV2.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outV2;
      try { outV2 = _dipLadderCompoundingByPriceBand(panV2.shares, baseV2); }
      catch (e) { return json({ error: 'adjusted price-band compounding backtest failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (outV2 && outV2.error) return json({ error: outV2.error, requestedWeeks: baseV2.totalWeeks, historyFrom: panV2.from }, 200, origin);
      return json({ ok: true, exch: exchV2, universe: panV2.universe, historyFrom: panV2.from, result: outV2 }, 200, origin);
    }

    // w476 — the benchmark. Read-only, admin-gated, one pantry read.
    if (url.pathname === '/admin/benchmark-bands') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchBM = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qBM = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const baseBM = {
        totalWeeks: Math.max(4, Math.min(525, qBM('totalWeeks', 145))),
        targetPct: Math.max(0, qBM('targetPct', 20)), stopPct: Math.max(0, qBM('stopPct', 15)),
        maxPositions: Math.max(1, Math.min(50, qBM('maxPositions', 10))),
        startingCapital: Math.max(1, qBM('startingCapital', 100000)),
        excludeNonEquity: url.searchParams.get('excludeNonEquity') !== '0',
        liqFloor: Math.max(1, qBM('liqFloor', 250000)),
        randomRuns: Math.max(20, Math.min(500, qBM('randomRuns', 200))),
        tradesToMatch: Math.max(0, Math.min(500, qBM('tradesToMatch', 72))),
        seed: Math.max(1, qBM('seed', 20260801))
      };
      let panBM;
      try { panBM = await _pantrySeriesOHLCLong(env, exchBM, baseBM.liqFloor, _maxBars(url)); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panBM || !panBM.shares || !panBM.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outBM;
      try { outBM = _benchmarkBands(panBM.shares, baseBM); }
      catch (e) { return json({ error: 'benchmark failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (outBM && outBM.error) return json({ error: outBM.error, historyFrom: panBM.from }, 200, origin);
      return json({ ok: true, exch: exchBM, universe: panBM.universe, historyFrom: panBM.from, result: outBM }, 200, origin);
    }

    // w474 — the deep data audit. Read-only: one pantry read, no writes, no
    // external calls, admin-gated like every backtest route. floor defaults to
    // the engine's own $50k so it covers everything that could ever be graded;
    // pass floor=1 to sweep the lot (slower).
    if (url.pathname === '/admin/deep-data-audit') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json(d.body === undefined ? { error: 'auth' } : d.body, d.status, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchDA = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qDA = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const floorDA = Math.max(1, qDA('floor', 50000));
      let panDA;
      try { panDA = await _pantrySeriesOHLCLong(env, exchDA, floorDA, 2700); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panDA || !panDA.shares || !panDA.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outDA;
      try { outDA = _deepDataAudit(panDA.shares, { gapMin: Math.max(2, qDA('gapMin', 5)), flatMin: Math.max(5, qDA('flatMin', 15)), maxPer: Math.max(10, Math.min(200, qDA('maxPer', 40))) }); }
      catch (e) { return json({ error: 'audit failed', detail: String((e && e.message) || e) }, 500, origin); }
      return json({ ok: true, exch: exchDA, floor: floorDA, audit: outDA }, 200, origin);
    }

    // w460 — the new-rules daily report: run-now (manual trigger, mainly for
    // testing without waiting on the cron), picks-data (JSON for the report
    // page), and buy (queues a real order into the SAME bridge_queue the
    // app's own buy flow uses — the local bridge, still DRY_RUN/per-order-
    // approve per Tony's own go-live plan, decides what actually happens).
    if (method === 'POST' && url.pathname === '/admin/new-rules-run-now') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchR = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      let outR;
      try {
        const mR = url.searchParams.get('mode');
        if (mR === 'mine') {                                   // w505: run the saved-rules lane on demand
          const RBr = await _botRulesGet(env);
          if (!RBr) return json({ error: 'no saved rules on the server yet - save your rules in the app first (or POST /bot/rules)' }, 400, origin);
          outR = await _newRulesDailyPick(env, exchR, '', RBr);
        } else outR = await _newRulesDailyPick(env, exchR, (mR==='trail')?'trail':'fixed');
      }
      catch (e) { return json({ error: 'daily pick run failed', detail: String((e && e.message) || e) }, 500, origin); }
      return json(outR, outR.ok ? 200 : 400, origin);
    }

    // w485 — clear SUGGESTED picks. The table dedups once-per-ticker-ever, so a
    // suggestion written under older rules sits there permanently: the report
    // was still showing $2.19 and $1.89 names picked on 22 July, outside the
    // $0.20-$0.99 band and priced off a stale close. New rules cannot reach
    // rows that already exist, so there has to be a way to clear them.
    // QUEUED rows are never touched — those became real orders on the bridge and
    // deleting them would erase a record of something that actually happened.
    if (method === 'POST' && url.pathname === '/admin/new-rules-clear') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchC = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const scope = (url.searchParams.get('scope') || 'outofband');
      const _cm = url.searchParams.get('mode'); const TBL = _cm === 'trail' ? 'trail_rules_picks' : _cm === 'mine' ? 'bot_rules_picks' : 'new_rules_picks'; // w506
      try { await _newRulesEnsureTable(env); await _trailRulesEnsureTable(env); await _botRulesEnsureTable(env); } catch (e) {}
      try {
        let res;
        if (scope === 'everything') {
          // w488 — reaches QUEUED rows too. Deliberately a separate scope: this
          // table is a record of what was picked, and a queued row means a push
          // to the bridge queue actually happened. Deleting the record here does
          // NOT cancel that bridge order — it only forgets that this ticker was
          // ever picked, which is what lets it be re-picked under new rules.
          res = await env.MARKET_DB.prepare(
            'DELETE FROM ' + TBL + ' WHERE exch=?').bind(exchC).run();
        } else if (scope === 'all') {
          res = await env.MARKET_DB.prepare(
            "DELETE FROM " + TBL + " WHERE exch=? AND status='suggested'").bind(exchC).run();
        } else {
          // only the rows the current band would never have produced
          res = await env.MARKET_DB.prepare(
            "DELETE FROM " + TBL + " WHERE exch=? AND status='suggested' AND (ref_close<=? OR ref_close>?)")
            .bind(exchC, _NEW_RULES_MIN_PRICE, _NEW_RULES_MAX_PRICE).run();
        }
        const removed = (res && res.meta && res.meta.changes) || 0;
        return json({ ok: true, exch: exchC, scope, removed,
          band: _NEW_RULES_MIN_PRICE + '-' + _NEW_RULES_MAX_PRICE,
          note: (scope==='everything')
            ? 'queued records were removed too — any order already pushed to the bridge is NOT cancelled by this'
            : 'queued picks were left alone — they became real orders' }, 200, origin);
      } catch (e) { return json({ error: 'clear failed', detail: String((e && e.message) || e) }, 500, origin); }
    }

    if (url.pathname === '/admin/new-rules-picks-data') {
      const TRAILV = (url.searchParams.get('mode') === 'trail');
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchP = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      try { await _newRulesEnsureTable(env); } catch (e) {}
      let rows;
      try {
        const rs = await env.MARKET_DB.prepare(
          'SELECT exch,ticker,first_seen_day,evidence_key,score,tier,edge,ref_close,limit_price,target_price,stop_price,qty,status,queued_order_id,created FROM new_rules_picks WHERE exch=? ORDER BY created DESC LIMIT 200'
        ).bind(exchP).all();
        rows = rs.results || [];
      } catch (e) { return json({ error: 'read failed', detail: String((e && e.message) || e) }, 500, origin); }
      // w486 — the dates. Every number on this page is derived from a session,
      // and until now the page never said WHICH. A pick from 22 July looked
      // identical to one made this morning. The newest stored session and the
      // newest session that produced a pick are both reported, so "how old is
      // this?" is answered on the page rather than inferred from a ticker.
      let latestBar = null, latestPick = null;
      try {
        const b = await env.MARKET_DB.prepare('SELECT MAX(d) AS d FROM bars WHERE exch=?').bind(exchP).first();
        latestBar = (b && b.d) || null;
      } catch (e) {}
      try { for (const r of rows) if (r.first_seen_day && (!latestPick || r.first_seen_day > latestPick)) latestPick = r.first_seen_day; } catch (e) {}
      return json({ ok: true, exch: exchP, rows,
        latestBar, latestPick,
        stale: !!(latestBar && latestPick && latestPick < latestBar),
        workerV: _WV, mode: (TRAILV?'trail':'fixed'), trailPct: _TRAIL_RULES_TRAIL_PCT,
        config: { targetPct: _NEW_RULES_TARGET_PCT, stopPct: _NEW_RULES_STOP_PCT, dipPct: _NEW_RULES_DIP_PCT, minScore: _NEW_RULES_MINSCORE, minPrice: _NEW_RULES_MIN_PRICE, maxPrice: _NEW_RULES_MAX_PRICE, topN: _NEW_RULES_TOPN, amountPerOrder: _NEW_RULES_AMOUNT } }, 200, origin);
    }

    if (method === 'POST' && url.pathname === '/admin/new-rules-buy') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      let body; try { body = await request.json(); } catch (e) { return json({ error: 'bad json body' }, 400, origin); }
      const exchB = String((body && body.exch) || 'ASX').toUpperCase().slice(0, 8);
      const tickerB = String((body && body.ticker) || '').toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 12);
      if (!tickerB) return json({ error: 'ticker required' }, 400, origin);
      try { await _newRulesEnsureTable(env); } catch (e) {}
      let pick;
      try {
        const rs = await env.MARKET_DB.prepare('SELECT * FROM ' + (TRAILV?'trail_rules_picks':'new_rules_picks') + ' WHERE exch=? AND ticker=?').bind(exchB, tickerB).all();
        pick = (rs.results || [])[0];
      } catch (e) { return json({ error: 'lookup failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!pick) return json({ error: 'no such pick on file for ' + exchB + ':' + tickerB }, 404, origin);
      if (pick.status !== 'suggested') return json({ error: 'already ' + pick.status, pick }, 409, origin);
      const day = new Date().toISOString().slice(0, 10);
      const orderId = 'newrules-' + day + '-' + tickerB;
      const order = _sanOrder({
        id: orderId, action: 'BUY', ticker: tickerB, qty: pick.qty, exchange: exchB,
        order_type: 'LIMIT', limit: pick.limit_price, target: pick.target_price, stop: pick.stop_price,
        note: 'new-rules 15/15 -5%dip, score ' + (+pick.score).toFixed(1),
      });
      if (!order) return json({ error: 'could not build a valid order from this pick' }, 400, origin);
      try {
        const res = await env.MARKET_DB.prepare(_BQ_INSERT).bind(order.id, day, exchB, JSON.stringify(order), new Date().toISOString()).run();
        if (!(res && res.meta && res.meta.changes)) return json({ error: 'order id already queued (duplicate)', orderId }, 409, origin);
      } catch (e) { return json({ error: 'queue write failed', detail: String((e && e.message) || e) }, 500, origin); }
      try { await env.MARKET_DB.prepare('UPDATE new_rules_picks SET status=?, queued_order_id=? WHERE exch=? AND ticker=?').bind('queued', order.id, exchB, tickerB).run(); } catch (e) {}
      return json({ ok: true, queued: order, note: 'inserted into bridge_queue — the local bridge (still DRY_RUN / per-order-approve) decides what happens next, same as any other queued order' }, 200, origin);
    }

    if (url.pathname === '/admin/new-rules-report') {
      return new Response(NEW_RULES_REPORT_HTML, { status: 200, headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow'
      } });
    }

    // w441 — Tony's follow-up: same fixed target/stop comparison, but
    // multiple buys of the same share ARE allowed across different weeks
    // (dedupe resets weekly rather than persisting all year). Also reports
    // concurrent-$-exposure so the result comes with an honest read on
    // whether it's executable on a real account, not just the total P&L.
    if (url.pathname === '/admin/dip-ladder-backtest-fixedts-multi') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exch8 = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const q8 = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const base8 = {
        entryDays: Math.max(1, Math.min(10, q8('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(104, q8('totalWeeks', 52))),
        topN: Math.max(1, Math.min(20, q8('topN', 7))),
        amountPerLevel: Math.max(1, q8('amount', 5000)),
        levels: [-10, -5, -2.5, 0],
        liqFloor: Math.max(1, q8('liqFloor', 250000))
      };
      let pan8;
      try { pan8 = await _pantrySeriesOHLC(env, exch8, base8.liqFloor); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!pan8 || !pan8.shares || !pan8.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outC, outD;
      try {
        outC = _dipLadderBacktestFixedTSMulti(pan8.shares, Object.assign({}, base8, { targetPct: 10, stopPct: 10 }));
        outD = _dipLadderBacktestFixedTSMulti(pan8.shares, Object.assign({}, base8, { targetPct: 5, stopPct: 10 }));
      } catch (e) { return json({ error: 'fixed target/stop (multi-buy) backtest failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (outC && outC.error) return json({ error: outC.error }, 400, origin);
      if (outD && outD.error) return json({ error: outD.error }, 400, origin);
      return json({ ok: true, exch: exch8, universe: pan8.universe, combos: [
        { label: '10% target / 10% stop', result: outC },
        { label: '5% target / 10% stop', result: outD }
      ] }, 200, origin);
    }

    // w442 — the missing comparison: the app's OWN current best-practice
    // defaults (20% target / 8% stop / 8% trail / breakeven-arm at +5% /
    // 10-day max hold) vs the new 10%/10% fixed target/stop, both on the
    // SAME once-only picks and the SAME single -5% dip buy level, so only
    // the exit mechanism differs.
    if (url.pathname === '/admin/dip-ladder-vs-app-default') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exch9 = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const q9 = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const params9 = {
        entryDays: Math.max(1, Math.min(10, q9('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(104, q9('totalWeeks', 52))),
        topN: Math.max(1, Math.min(20, q9('topN', 7))),
        amountPerLevel: Math.max(1, q9('amount', 5000)),
        buyLevel: q9('buyLevel', -5),
        appTarget: Math.max(0, q9('appTarget', 20)), appStop: Math.max(0, q9('appStop', 8)),
        appTrail: Math.max(0, q9('appTrail', 8)), appBE: Math.max(0, q9('appBE', 5)), appHold: Math.max(0, q9('appHold', 10)),
        newTarget: Math.max(0, q9('newTarget', 10)), newStop: Math.max(0, q9('newStop', 10)),
        liqFloor: Math.max(1, q9('liqFloor', 250000))
      };
      let pan9;
      try { pan9 = await _pantrySeriesOHLC(env, exch9, params9.liqFloor); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!pan9 || !pan9.shares || !pan9.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let out9;
      try { out9 = _dipLadderVsAppDefault(pan9.shares, params9); }
      catch (e) { return json({ error: 'app-default comparison failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (out9 && out9.error) return json({ error: out9.error }, 400, origin);
      return json({ ok: true, exch: exch9, universe: pan9.universe, result: out9 }, 200, origin);
    }

    // w455 — same head-to-head as above, but rebuilt on the current-standard
    // selection (score>=7, top 4, ETFs/hybrids/bonds excluded) that
    // everything since the original 10/10 test — including the 15/15
    // answer itself — was actually established with. Comparing 15/15
    // against the OLDER tier-rank/topN=7 candidate pool above would not be
    // a fair test of the conclusion Tony is actually checking.
    if (url.pathname === '/admin/dip-ladder-vs-app-default-v2') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exchL = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const qL = (k, d) => { const raw = url.searchParams.get(k); if (raw === null || raw === '') return d; const v = +raw; return isFinite(v) ? v : d; };
      const paramsL = {
        entryDays: Math.max(1, Math.min(10, qL('entryDays', 5))),
        totalWeeks: Math.max(4, Math.min(104, qL('totalWeeks', 52))),
        topN: Math.max(1, Math.min(20, qL('topN', 4))),
        amountPerLevel: Math.max(1, qL('amount', 5000)),
        buyLevel: qL('buyLevel', -5),
        minScore: Math.max(0, Math.min(10, qL('minScore', 7))),
        excludeNonEquity: url.searchParams.get('excludeNonEquity') !== '0',
        appTarget: Math.max(0, qL('appTarget', 20)), appStop: Math.max(0, qL('appStop', 8)),
        appTrail: Math.max(0, qL('appTrail', 8)), appBE: Math.max(0, qL('appBE', 5)), appHold: Math.max(0, qL('appHold', 10)),
        newTarget: Math.max(0, qL('newTarget', 15)), newStop: Math.max(0, qL('newStop', 15)),
        liqFloor: Math.max(1, qL('liqFloor', 250000))
      };
      let panL;
      try { panL = await _pantrySeriesOHLC(env, exchL, paramsL.liqFloor); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!panL || !panL.shares || !panL.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let outO;
      try { outO = _dipLadderVsAppDefaultV2(panL.shares, paramsL); }
      catch (e) { return json({ error: 'app-default v2 comparison failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (outO && outO.error) return json({ error: outO.error }, 400, origin);
      return json({ ok: true, exch: exchL, universe: panL.universe, result: outO }, 200, origin);
    }

    // ---- GET /admin/opposite-sweep — w431: does the EXTREME end of a
    //      well-known bullish indicator predict a WORSE forward return,
    //      the systematic version of what the streak test found.
    if (url.pathname === '/admin/opposite-sweep') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exch3 = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      let pan3;
      try { pan3 = await _pantrySeries(env, exch3, 50000); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!pan3 || !pan3.shares || !pan3.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let out3;
      try { out3 = _oppositeSweep(pan3.shares, 250000); }
      catch (e) { return json({ error: 'sweep failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!out3) return json({ error: 'not enough stored history yet to replay (need a few months)' }, 503, origin);
      return json({ ok: true, exch: exch3, universe: pan3.universe, from: pan3.from, result: out3 }, 200, origin);
    }

    // ---- GET /admin/backtest-accum-score — w426: the actual replay, run on
    //      real stored history. Answers, with real numbers: does a higher
    //      Accum count or Score band actually predict a better forward
    //      return, or has it never been checked until now.
    if (url.pathname === '/admin/backtest-accum-score') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exch = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      let pan;
      try { pan = await _pantrySeries(env, exch, 50000); }
      catch (e) { return json({ error: 'pantry read failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!pan || !pan.shares || !pan.shares.length) return json({ error: 'no stored history for this exchange yet' }, 503, origin);
      let out;
      try { out = _accScoreReplay(pan.shares, 250000); }
      catch (e) { return json({ error: 'replay failed', detail: String((e && e.message) || e) }, 500, origin); }
      if (!out) return json({ error: 'not enough stored history yet to replay (need a few months)' }, 503, origin);
      return json({ ok: true, exch, universe: pan.universe, from: pan.from, result: out }, 200, origin);
    }

    // ---- GET /admin/warm-now — w423: trigger TODAY's grade warm immediately.
    //      _gradeWarm only ever runs from inside scheduled() (the market-close
    //      cron) — pasting new worker code does NOT retroactively run it, so a
    //      worker update after today's close already fired means the fuller
    //      warm has to wait for TOMORROW's close before it helps anyone. This
    //      route closes that gap: hit it once after a paste (or any time you
    //      want today's grades refreshed) and it runs the exact same warm the
    //      close would have, for whichever exchange/date you ask for, on
    //      demand. Same admin gate as every other /admin/ route.
    if (url.pathname === '/admin/picks-amount') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exch = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const set = url.searchParams.get('set');
      if (set != null) {
        const v = Math.round(+set);
        if (!isFinite(v) || v < 100 || v > 5000)
          return json({ error: 'amount must be $100-$5000' }, 400, origin);
        await _setMeta(env, 'picks_amount_' + exch, String(v));
        return json({ ok: true, exch, amount: v, note: 'applies to the next nightly run of the two evidence lanes' }, 200, origin);
      }
      const cur = await _picksAmount(env, exch);
      return json({ ok: true, exch, amount: cur || _NEW_RULES_AMOUNT, isDefault: !cur, min: 100, max: 5000 }, 200, origin);
    }

    // ── w524 · trial keys ────────────────────────────────────────────────
    if (url.pathname.startsWith('/admin/keys')) {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      await _akInit(env);
      const P = url.searchParams;
      const code = String(P.get('code') || '').trim().toUpperCase();
      try {
        if (url.pathname === '/admin/keys/create') {
          const label = String(P.get('label') || '').slice(0, 60) || 'unnamed';
          const days = Math.max(1, Math.min(365, +P.get('days') || 30));
          const cap = Math.max(1, Math.min(10, +P.get('devices') || 2));
          const nc = _akNewCode();
          const exp = new Date(Date.now() + days * 86400000).toISOString();
          await env.MARKET_DB.prepare('INSERT INTO access_keys (code,label,created,expires,revoked,max_devices,devices,hits) VALUES (?,?,?,?,0,?,"",0)')
            .bind(nc, label, new Date().toISOString(), exp, cap).run();
          return json({ ok: true, code: nc, label, expires: exp, max_devices: cap }, 200, origin);
        }
        if (url.pathname === '/admin/keys/revoke' && code) {
          await env.MARKET_DB.prepare('UPDATE access_keys SET revoked=1 WHERE code=?').bind(code).run();
          return json({ ok: true, code, revoked: true }, 200, origin);
        }
        if (url.pathname === '/admin/keys/restore' && code) {
          await env.MARKET_DB.prepare('UPDATE access_keys SET revoked=0 WHERE code=?').bind(code).run();
          return json({ ok: true, code, revoked: false }, 200, origin);
        }
        if (url.pathname === '/admin/keys/extend' && code) {
          const days = Math.max(1, Math.min(365, +P.get('days') || 30));
          const row = await env.MARKET_DB.prepare('SELECT expires FROM access_keys WHERE code=?').bind(code).first();
          if (!row) return json({ error: 'no such code' }, 404, origin);
          // extend from today when it already lapsed, else from the existing end
          const base = (row.expires && new Date(row.expires) > new Date()) ? new Date(row.expires) : new Date();
          const exp = new Date(base.getTime() + days * 86400000).toISOString();
          await env.MARKET_DB.prepare('UPDATE access_keys SET expires=?, revoked=0 WHERE code=?').bind(exp, code).run();
          return json({ ok: true, code, expires: exp }, 200, origin);
        }
        if (url.pathname === '/admin/keys/reset-devices' && code) {
          await env.MARKET_DB.prepare('UPDATE access_keys SET devices="" WHERE code=?').bind(code).run();
          return json({ ok: true, code, devices: 0 }, 200, origin);
        }
        // default: list
        const rs = await env.MARKET_DB.prepare('SELECT * FROM access_keys ORDER BY created DESC LIMIT 300').all();
        const now = Date.now();
        const rows = (rs.results || []).map(r => ({
          code: r.code, label: r.label, expires: r.expires, revoked: !!r.revoked,
          daysLeft: r.expires ? Math.ceil((new Date(r.expires).getTime() - now) / 86400000) : null,
          devices: String(r.devices || '').split(',').filter(Boolean).length,
          maxDevices: r.max_devices, lastSeen: r.last_seen, lastCity: r.last_city, hits: r.hits
        }));
        return json({ ok: true, keys: rows }, 200, origin);
      } catch (e) { return json({ error: String(e && e.message || e) }, 500, origin); }
    }

    if (url.pathname === '/admin/warm-now') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exch = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const date = url.searchParams.get('date') || sydneyNow().date;
      let out;
      try { out = await _gradeWarm(env, exch, date); }
      catch (e) { return json({ error: 'warm failed', detail: String((e && e.message) || e) }, 500, origin); }
      return json({ ok: true, exch, date, warmed: out }, 200, origin);
    }

    // ---- GET /admin/era-build — w410: one chunk of the three-year era study
    //      per call; the panel button loops it. ?reset=1 restarts on fresher
    //      data (old summary keeps serving until the rebuild completes).
    if (url.pathname === '/admin/era-build') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      if (url.searchParams.get('reset') === '1') {
        try { await _setMeta(env, 'era_state', JSON.stringify({ ver: _ERA.VER, phase: 'A', era: _ERA.ERAS[0], holdIx: 0, cursor: 0, finished: false })); await _setMeta(env, 'era_summary', ''); } catch (e) {}
        for (const e2 of _ERA.ERAS) { for (const hh of _ERA.HOLDS) { try { await _setMeta(env, 'era_day' + e2 + '_h' + hh, '{}'); await _setMeta(env, 'era_m' + e2 + '_h' + hh, JSON.stringify({ keys: {}, from: null, to: null, covered: 0, liqSkipped: 0 })); await _setMeta(env, 'era_c' + e2 + '_h' + hh, '{}'); await _setMeta(env, 'era_summary_h' + hh, ''); } catch (e) {} } try { await _setMeta(env, 'era_day' + e2, '{}'); await _setMeta(env, 'era_m' + e2, '{}'); await _setMeta(env, 'era_c' + e2, '{}'); } catch (e) {} } // w412 full shapes · w416 day map · w417 per-hold keys + legacy cleared
        try { await _setMeta(env, 'era_tickers', ''); } catch (e) {}
        return json({ ok: true, reset: true, note: 'era study restarted — press Build to walk it again' }, 200, origin);
      }
      let out;
      try { out = await _eraBuildStep(env); }
      catch (e) { return json({ error: 'era step failed: ' + (e && e.message || e) }, 500, origin); }
      return json(out, 200, origin);
    }

    // ---- w409: these two admin routes accept POST, so they MUST sit ahead
    //      of the POST catch-all below (which 405s everything except /grades).
    //      The NYSE delete button died on that catch-all; the pantry
    //      Restore-from-file button had been quietly dying on it since the
    //      day import shipped. Route order is behaviour.
    // ---- POST /admin/nyse-retire — w406: delete NYSE rows, chunked. ----
    //      Without ?confirm=NYSE-DELETE it only REPORTS the row counts.
    //      Re-pressable until remaining is all zero; only then does the
    //      nyse_retired flag flip serving to the 410. Download the pantry
    //      months FIRST — deletion does not check that for you, it cannot.
    if (url.pathname === '/admin/nyse-retire') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const _nyTables = ['bars', 'tech52', 'news', 'news_watch'];
      const _nyCounts = async () => { const out = {};
        for (const t of _nyTables) {
          try { const r = await env.MARKET_DB.prepare("SELECT COUNT(*) AS n FROM " + t + " WHERE exch='NYSE'").first(); out[t] = (r && r.n) || 0; }
          catch (e) { out[t] = null; } }
        return out; };
      if (method !== 'POST' || String(url.searchParams.get('confirm') || '') !== 'NYSE-DELETE') {
        return json({ ok: true, armed: false, remaining: await _nyCounts(),
          hint: 'Download every NYSE pantry month FIRST (the export list above). Then POST with ?confirm=NYSE-DELETE. Deletion is chunked \u2014 press until remaining is all zero.' }, 200, origin);
      }
      let deleted = 0;
      for (let i = 0; i < 10; i++) {
        let any = false;
        for (const t of _nyTables) {
          try {
            const r = await env.MARKET_DB.prepare("DELETE FROM " + t + " WHERE rowid IN (SELECT rowid FROM " + t + " WHERE exch='NYSE' LIMIT 25000)").run();
            const ch = (r && r.meta && r.meta.changes) || 0; deleted += ch; if (ch > 0) any = true;
          } catch (e) {}
        }
        if (!any) break;
      }
      const rem = await _nyCounts();
      const done = _nyTables.every(t => rem[t] === 0);
      if (done) {
        try { await _setMeta(env, 'nyse_retired', new Date().toISOString().slice(0, 10)); } catch (e) {}
        // w411: dead cursors invite resurrection — clear every NYSE meta trace.
        for (const mk of ['bf_cursor_NYSE', 'latest_NYSE', 'catchup_NYSE', 'r2_NYSE']) { try { await env.MARKET_DB.prepare('DELETE FROM meta WHERE k=?').bind(mk).run(); } catch (e) {} }
        _NYSE_OFF_CACHE = true;
        try { await _refreshDepth(env); } catch (e) {}
      }
      return json({ ok: true, v: _WV, armed: true, deletedThisCall: deleted, remaining: rem, retired: done,
        note: done ? 'NYSE is retired \u2014 rows gone; NYSE routes now answer an honest 410.'
                   : 'More to delete \u2014 press the button again.' }, 200, origin);
    }

    if (url.pathname.indexOf('/admin/pantry/') === 0) {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const tail = url.pathname.slice('/admin/pantry/'.length);

      if (tail === 'months') return json({ ok: true, months: await pantryMonths(env) }, 200, origin);

      if (tail === 'r2') {
        return json({ ok: true, configured: _r2On(env),
          lastASX: await _getMeta(env, 'r2_ASX'), lastNYSE: await _getMeta(env, 'r2_NYSE'),
          note: _r2On(env) ? 'the nightly copy is running' :
            'no R2 bucket bound — enable R2 and bind it as PANTRY_R2 to switch the nightly copy on' }, 200, origin);
      }

      if (tail === 'export') {
        const ex = String(url.searchParams.get('exch') || 'ASX').slice(0, 8);
        const ym = String(url.searchParams.get('ym') || '').slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(ym)) return json({ error: 'need ym=YYYY-MM' }, 400, origin);
        let out;
        try { out = await pantryExport(env, ex, ym); }
        catch (e) { return json({ error: 'export failed' }, 500, origin); }
        // Plain text, not JSON: the point is a file that goes to disk and can
        // be read by anything, including a person.
        return new Response(out.text, { status: 200, headers: Object.assign({
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': 'attachment; filename="pantry-' + ex + '-' + ym + '.ndjson"',
          'X-Pantry-Rows': String(out.n), 'Cache-Control': 'no-store'
        }, corsHeaders(origin)) });
      }

      if (tail === 'import' && method === 'POST') {
        if (_bodyTooBig(request)) return json({ error: 'payload too large' }, 413, origin);
        const ex = String(url.searchParams.get('exch') || 'ASX').slice(0, 8);
        let text = '';
        try { text = await request.text(); } catch (e) { return json({ error: 'could not read the body' }, 400, origin); }
        const lines = text.split('\n');
        if (lines.length > 8000) return json({ error: 'send at most 8000 rows per request' }, 413, origin);
        let out;
        try { out = await pantryImport(env, ex, lines); }
        catch (e) { return json({ error: 'import failed' }, 500, origin); }
        return json({ ok: true, exch: ex, written: out.written, skipped: out.skipped }, 200, origin);
      }

      return json({ error: 'not found' }, 404, origin);
    }

    // ---- GET /admin/panel — the button, because a link cannot be one --------
    // The admin password travels in the X-Insight-Admin HEADER, deliberately:
    // a key in a query string lands in request logs and browser history. But a
    // browser cannot put a custom header on a link you click, so "click this
    // URL" was never going to work. This page is the smallest thing that can:
    // it asks for the password, keeps it in memory only, and sends it as a
    // header. Serving it needs no password — it is a form, not an answer.
    // ---- POST /grades — grade the signals server-side (Phase 2) ----
    if (method === 'POST') {
      if (url.pathname !== '/grades') return json({ error: 'method not allowed' }, 405, origin);
      if (gate.configured && !gate.ok) return locked();
      if (_bodyTooBig(request)) return json({ error: 'payload too large' }, 413, origin);
      let payload;
      try { payload = await request.json(); } catch (e) { return json({ error: 'bad json body' }, 400, origin); }
      const exch = String((payload && payload.exch) || 'ASX').slice(0, 8);
      const dataDate = String((payload && payload.dataDate) || '').slice(0, 24); // date + count/hold suffixes
      // v383: selectable outcome window. Only 5 / 10 / 30 are legal; anything else is 5.
      const hold = (payload && (payload.hold === 10 || payload.hold === 30)) ? payload.hold : 5;
      const cache = caches.default;
      // w392: the key must describe what was computed, not merely what was
      // asked for. Without the payload fingerprint, one caller's fabricated
      // series became every later caller's cached evidence table for 20 hours.
      const _gShares = _capShares((payload && Array.isArray(payload.shares)) ? payload.shares : []);
      const gFp = _gShares.length ? _fingerprint(_gShares) : String((payload && payload.fp) || '').slice(0, 16);
      const gKey = new Request(url.origin + '/grades-cache?exch=' + encodeURIComponent(exch) + '&date=' + encodeURIComponent(dataDate) + '&hold=' + hold + '&fp=' + encodeURIComponent(gFp), { method: 'GET' });

      if (dataDate && gFp) {
        const hit = await cache.match(gKey);
        if (hit) {
          const h = new Headers(hit.headers);
          for (const [k, v] of Object.entries(corsHeaders(origin))) h.set(k, v);
          h.set('X-Insight-Grades', 'HIT');
          return new Response(hit.body, { status: 200, headers: h });
        }
        const gD1 = await _d1cGet(env, gKey.url);
        if (gD1) {
          try { ctx.waitUntil(cache.put(gKey, new Response(gD1, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${GRADE_CACHE_SECONDS}` } }))); } catch (e) {}
          return new Response(gD1, { status: 200, headers: { 'Content-Type': 'application/json', 'X-Insight-Grades': 'D1', ...corsHeaders(origin) } });
        }
      }
      const shares = _gShares;
      // ---- w419: GRADE FROM THE PANTRY ----------------------------------
      // {exch, dataDate, hold, liqFloor, pantry:true} and NO shares: the
      // worker reads its own bars (the app has been uploading data this
      // store already holds), applies its own gates, and returns the same A.
      // probe:true never computes — it is the cheap "is today cached?" ask.
      // An empty payload WITHOUT pantry:true keeps its old meaning (400),
      // which is what lets an older app fall back to uploading unchanged.
      if (!shares.length && payload && payload.pantry === true) {
        if (!env.MARKET_DB) return json({ error: 'no market store configured' }, 503, origin);
        const fl = Math.max(_AUD.LIQ_FLOOR, Math.min(10000000, Math.floor(+(payload.liqFloor) || _AUD.LIQ_FLOOR)));
        const pKey = new Request(_GC_ORIGIN + '/grades-cache?exch=' + encodeURIComponent(exch) + '&date=' + encodeURIComponent(dataDate) + '&hold=' + hold + '&fp=pantry' + fl, { method: 'GET' });
        if (dataDate) {
          const pHit = await cache.match(pKey);
          if (pHit) {
            const h2 = new Headers(pHit.headers);
            for (const [k, v] of Object.entries(corsHeaders(origin))) h2.set(k, v);
            h2.set('X-Insight-Grades', 'HIT');
            return new Response(pHit.body, { status: 200, headers: h2 });
          }
          const pD1 = await _d1cGet(env, pKey.url);
          if (pD1) {
            try { ctx.waitUntil(cache.put(pKey, new Response(pD1, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${GRADE_CACHE_SECONDS}` } }))); } catch (e) {}
            return new Response(pD1, { status: 200, headers: { 'Content-Type': 'application/json', 'X-Insight-Grades': 'D1', ...corsHeaders(origin) } });
          }
        }
        if (payload.probe === true) return json({ ok: false, miss: true }, 404, origin);
        /* w420: 12/hr proved too tight for real use — every NEW (window, floor)
           pair is a fresh compute, and Tony's desktop and phone share one IP.
           3 windows x 3 floors x 2 devices = 18 legitimate first-computes, so
           the old cap could lock the household out mid-exploration for an
           hour while the radar honestly reported "too many requests". Cache
           hits and probes never touch this bucket, so 30 is still miserly. */
        if (await _rlOver(env, 'gradesP|' + _ip(request), 30, 3600))
          return json({ error: 'too many pantry grade requests in the last hour (limit 30 fresh computes; cached answers are unlimited)' }, 429, origin);
        let pan;
        try { pan = await _pantrySeries(env, exch, fl); } catch (e) { return json({ error: 'pantry read failed' }, 500, origin); }
        if (!pan || !pan.shares.length) return json({ error: 'pantry holds no gradeable shares for ' + exch }, 404, origin);
        let A2; let annPS2 = null;
        try { annPS2 = await _annFromStore(env, exch); } catch (e) { annPS2 = null; }
        try { A2 = gradeShares(pan.shares, hold, annPS2, fl); } catch (e) { return json({ error: 'grading failed' }, 500, origin); }
        try { const es2 = await _eraSummaryCached(env, hold); if (es2 && A2) { A2.eras = es2; _applyEraCap(A2); } } catch (e) {}
        const pBody = JSON.stringify({ ok: true, date: dataDate, src: 'pantry', universe: pan.universe, from: pan.from, A: A2 });
        if (dataDate) {
          const toC = new Response(pBody, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${GRADE_CACHE_SECONDS}` } });
          ctx.waitUntil(cache.put(pKey, toC));
          try { _d1cPut(env, ctx, pKey.url, pBody); } catch (e) {}
        }
        return new Response(pBody, { status: 200, headers: { 'Content-Type': 'application/json', 'X-Insight-Grades': 'FRESH', 'X-Insight-Src': 'pantry', ...corsHeaders(origin) } });
      }
      if (!shares.length) return json({ error: 'no shares supplied' }, 400, origin);
      if (await _rlOver(env, 'grades|' + _ip(request), 40, 3600))
        return json({ error: 'too many grade requests in the last hour' }, 429, origin);
      let A;
      let annPS = null;
      try { annPS = await _annFromStore(env, exch); } catch (e) { annPS = null; }   // v388: real announcements, when the store has them
      try { A = gradeShares(shares, hold, annPS); } catch (e) { return json({ error: 'grading failed' }, 500, origin); }
      try { const es = await _eraSummaryCached(env, hold); if (es && A) { A.eras = es; _applyEraCap(A); } } catch (e) {} // w410 eras ride along · w417: the window-matched set · w432: era cap applied here
      const bodyStr = JSON.stringify({ ok: true, date: dataDate, A });
      if (dataDate) {
        const toCache = new Response(bodyStr, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${GRADE_CACHE_SECONDS}` } });
        ctx.waitUntil(cache.put(gKey, toCache));
        try { _d1cPut(env, ctx, gKey.url, bodyStr); } catch (e) {}
      }
      return new Response(bodyStr, { status: 200, headers: { 'Content-Type': 'application/json', 'X-Insight-Grades': 'FRESH', ...corsHeaders(origin) } });
    }

    if (method !== 'GET') return json({ error: 'method not allowed' }, 405, origin);

    // ---- Health (always public) — reports whether the lock is armed and whether
    //      the market-history store (D1) is wired up. ----
    if (url.pathname === '/' || url.pathname === '/health') {
      // v390: `fresh` says whether each exchange's store is keeping up. It is a
      // boolean per exchange — no dates, no prices — so it stays safe on this
      // ungated endpoint while making a stalled feed impossible to miss.
      // w392: the only unauthenticated route, so it no longer enumerates the
      // security posture for strangers or does D1 reads on their behalf. A
      // caller holding the gate key still gets the full picture, which is who
      // the detail was ever for.
      if (!(gate.configured && gate.ok))
        return json({ ok: true, service: 'insight-data', v: _WV }, 200, origin);
      return json({ ok: true, service: 'insight-data', v: _WV, phase: 2, grades: true, scan: true, reports: REPORTS_OPEN.length + REPORTS_DEEP.length, rules: scanRuleKeys().length, gated: gate.configured, admin: !!env.ADMIN_KEY, training: !!env.TRAINING_CODE, history: !!env.MARKET_DB, bridge: !!env.BRIDGE_KEY, news: _newsOn(env), fresh: await _ingestFresh(env) }, 200, origin);
    }

    // ═════ w507 — BROKER-CONNECT LANE (SnapTrade, orchestrated here, executed by the bridge) ═════
    // The worker never calls SnapTrade itself: request signing lives in the desktop
    // bridge's pinned SDK (v11.0.213), already proven against real Stake accounts.
    // Flow:
    //   app    POST /connect/start            -> row status 'requested'
    //   bridge GET  /bridge/connect/jobs      -> registerUser + portal link via SDK
    //   bridge POST /bridge/connect/result    -> 'portal_ready' (st ids + portal_url)
    //   customer approves on SnapTrade's own page (Stake AUS; password never touches us)
    //   bridge sees accounts appear           -> POST result {connected:true, accounts}
    //   app    GET  /connect/status           -> never returns secrets
    //   app    POST /connect/choose           -> {account_id}
    // st_user_secret lives only in D1 and only the bridge lane can read it.
    if (url.pathname === '/connect/start' && request.method === 'POST') {
      if (gate.configured && !gate.ok) return locked();
      if (!env.MARKET_DB) return json({ error: 'store not configured' }, 503, origin);
      try { await _connEnsure(env); } catch (e) {}
      const cust = String(url.searchParams.get('cust') || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'default';
      const force = url.searchParams.get('force') === '1';
      try {
        const cur = await env.MARKET_DB.prepare('SELECT id,status FROM broker_connect WHERE cust=? ORDER BY id DESC LIMIT 1').bind(cust).first();
        if (cur && !force && cur.status !== 'failed') return json({ ok: true, id: cur.id, status: cur.status, existing: true }, 200, origin);
        const now = new Date().toISOString();
        const res = await env.MARKET_DB.prepare("INSERT INTO broker_connect (cust,status,created,updated) VALUES (?,'requested',?,?)").bind(cust, now, now).run();
        return json({ ok: true, id: (res && res.meta && res.meta.last_row_id) || null, status: 'requested' }, 200, origin);
      } catch (e) { return json({ error: 'connect start failed' }, 500, origin); }
    }
    if (url.pathname === '/connect/status') {
      if (gate.configured && !gate.ok) return locked();
      if (!env.MARKET_DB) return json({ error: 'store not configured' }, 503, origin);
      try { await _connEnsure(env); } catch (e) {}
      const cust = String(url.searchParams.get('cust') || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'default';
      try {
        const r = await env.MARKET_DB.prepare('SELECT id,status,portal_url,accounts,account_id,note,updated FROM broker_connect WHERE cust=? ORDER BY id DESC LIMIT 1').bind(cust).first();
        if (!r) return json({ ok: true, status: null }, 200, origin);
        let accounts = null; try { accounts = r.accounts ? JSON.parse(r.accounts) : null; } catch (e) {}
        return json({ ok: true, id: r.id, status: r.status, portal_url: r.portal_url || null, accounts, account_id: r.account_id || null, note: r.note || null, updated: r.updated }, 200, origin);
      } catch (e) { return json({ error: 'status read failed' }, 500, origin); }
    }
    if (url.pathname === '/connect/choose' && request.method === 'POST') {
      if (gate.configured && !gate.ok) return locked();
      if (!env.MARKET_DB) return json({ error: 'store not configured' }, 503, origin);
      let body; try { body = await request.json(); } catch (e) { return json({ error: 'bad json body' }, 400, origin); }
      const acct = String((body && body.account_id) || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
      if (!acct) return json({ error: 'account_id required' }, 400, origin);
      const cust = String(url.searchParams.get('cust') || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'default';
      try {
        await env.MARKET_DB.prepare("UPDATE broker_connect SET account_id=?, updated=? WHERE cust=? AND status='connected' AND id=(SELECT id FROM broker_connect WHERE cust=? ORDER BY id DESC LIMIT 1)").bind(acct, new Date().toISOString(), cust, cust).run();
        return json({ ok: true, account_id: acct }, 200, origin);
      } catch (e) { return json({ error: 'choose failed' }, 500, origin); }
    }
    if (url.pathname === '/bridge/connect/jobs') {
      const denied = bridgeAuth(request, env, url); if (denied) return json(denied.body, denied.status, origin);
      if (!env.MARKET_DB) return json({ error: 'store not configured' }, 503, origin);
      try { await _connEnsure(env); } catch (e) {}
      try {
        const res = await env.MARKET_DB.prepare("SELECT id,cust,status,st_user_id,st_user_secret,account_id FROM broker_connect WHERE status IN ('requested','portal_ready') ORDER BY id LIMIT 20").all();
        return json({ ok: true, jobs: (res && res.results) || [] }, 200, origin);
      } catch (e) { return json({ error: 'jobs read failed' }, 500, origin); }
    }
    if (url.pathname === '/bridge/connect/result' && request.method === 'POST') {
      const denied = bridgeAuth(request, env, url); if (denied) return json(denied.body, denied.status, origin);
      if (!env.MARKET_DB) return json({ error: 'store not configured' }, 503, origin);
      let body; try { body = await request.json(); } catch (e) { return json({ error: 'bad json body' }, 400, origin); }
      const id = parseInt((body && body.id), 10); if (!id) return json({ error: 'id required' }, 400, origin);
      const now = new Date().toISOString();
      try {
        if (body.error) {
          await env.MARKET_DB.prepare("UPDATE broker_connect SET status='failed', note=?, updated=? WHERE id=?").bind(String(body.error).slice(0, 300), now, id).run();
        } else if (body.connected === true) {
          const acc = JSON.stringify(Array.isArray(body.accounts) ? body.accounts.slice(0, 24) : []);
          await env.MARKET_DB.prepare("UPDATE broker_connect SET status='connected', accounts=?, note=NULL, updated=? WHERE id=?").bind(acc, now, id).run();
        } else if (body.portal_url) {
          await env.MARKET_DB.prepare("UPDATE broker_connect SET status='portal_ready', portal_url=?, st_user_id=?, st_user_secret=?, updated=? WHERE id=?")
            .bind(String(body.portal_url).slice(0, 500), String(body.st_user_id || '').slice(0, 80), String(body.st_user_secret || '').slice(0, 200), now, id).run();
        } else return json({ error: 'nothing to record' }, 400, origin);
        return json({ ok: true }, 200, origin);
      } catch (e) { return json({ error: 'result write failed' }, 500, origin); }
    }
    // ---- GET /bridge/pull — the desktop bridge fetches the day's queue (v382) ----
    if (url.pathname === '/bridge/pull') {
      const denied = bridgeAuth(request, env, url);
      if (denied) return json(denied.body, denied.status, origin);
      if (!env.MARKET_DB) return json({ error: 'queue store not configured (no MARKET_DB binding)' }, 503, origin);
      const day = (url.searchParams.get('day') || sydneyNow().date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: 'bad day (want YYYY-MM-DD)' }, 400, origin);
      const all = url.searchParams.get('all') === '1';
      let rows;
      try {
        const res = await env.MARKET_DB.prepare(all ? _BQ_PULL_ALL : _BQ_PULL_NEW).bind(day).all();
        rows = (res && res.results) || [];
      } catch (e) { return json({ error: 'queue read failed' }, 500, origin); }
      const orders = rows.map(r => {
        let p = {}; try { p = JSON.parse(r.payload) || {}; } catch (e) {}
        return Object.assign(p, { id: r.id, day: r.day, status: r.status });
      });
      return json({ ok: true, day, orders }, 200, origin);
    }

    // ---- GET /gate — lock probe. The app calls this on startup: 200 = you're in
    //      (or no lock set), 401 = a password is required, so raise the lock screen. ----
    // ---- GET /train — is this the training code? (w393) ----
    // It used to be `const TRAINING_CODE='train'` in index.html, compared with
    // ===, in a file anyone can download. So "training mode" was unlocked by
    // reading line 2734 — which matters because training mode hands back every
    // hover explanation that private mode deliberately confiscates.
    if (url.pathname === '/train') {
      if (gate.configured && !gate.ok) return locked();
      if (!env.TRAINING_CODE) return json({ error: 'training mode is disabled until the TRAINING_CODE secret is set' }, 403, origin);
      const sent = request.headers.get('X-Insight-Train') || '';
      if (!_ctEq(sent, String(env.TRAINING_CODE))) {
        if (await _rlOver(env, 'train|' + _ip(request), 8, 900))
          return json({ error: 'too many attempts, try later' }, 429, origin);
        return json({ error: 'wrong code' }, 401, origin);
      }
      return json({ ok: true }, 200, origin);
    }

    // ---- GET /asxann/CODE — announcements, with our token, not the browser's ----
    if (url.pathname.startsWith('/asxann/')) {
      if (gate.configured && !gate.ok) return locked();
      const code = url.pathname.slice('/asxann/'.length).toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 12);
      if (!code) return json({ error: 'bad code' }, 400, origin);
      const aKey = new Request(url.origin + '/asxann-cache/' + code, { method: 'GET' });
      const aCache = caches.default;
      const aHit = await aCache.match(aKey);
      if (aHit) {
        const h = new Headers(aHit.headers);
        for (const [k, v] of Object.entries(corsHeaders(origin))) h.set(k, v);
        h.set('X-Insight-Cache', 'HIT');
        return new Response(aHit.body, { status: 200, headers: h });
      }
      if (await _rlOver(env, 'asxann|' + _ip(request), 120, 3600))
        return json({ error: 'too many announcement lookups in the last hour' }, 429, origin);
      let aResp, aBody;
      try {
        aResp = await fetch('https://asx.api.markitdigital.com/asx-research/1.0/companies/' +
          encodeURIComponent(code) + '/announcements?access_token=' + ASX_ANN_TOKEN + '&itemsPerPage=20',
          { headers: { 'Accept': 'application/json' } });
        aBody = await aResp.text();
      } catch (e) { return json({ error: 'upstream fetch failed' }, 502, origin); }
      // never relay an upstream error body verbatim — it may echo the token
      if (!aResp.ok) return json({ error: 'upstream error', status: aResp.status }, 502, origin);
      if (!/^[\s]*[{\[]/.test(aBody)) return json({ error: 'unexpected upstream body' }, 502, origin);
      ctx.waitUntil(aCache.put(aKey, new Response(aBody, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' } })));
      return new Response(aBody, { status: 200, headers: { 'Content-Type': 'application/json', 'X-Insight-Cache': 'FRESH', ...corsHeaders(origin) } });
    }

    if (url.pathname === '/gate') {
      // w392: this was a free, unthrottled guessing oracle against a single
      // shared password. Twelve wrong answers per IP per quarter-hour is
      // generous for a human and useless for a wordlist.
      if (gate.configured && !gate.ok) {
        if (await _rlOver(env, 'gate|' + _ip(request), 12, 900))
          return json({ error: 'too many attempts, try later' }, 429, origin);
        // w524: name the reason so the app can say 'your trial ended' instead of
        // 'wrong password' — an expired trialist is a customer, not an intruder.
        // v748 reads `reason`; `why` is kept as a synonym so neither side can
        // drift silently. 'revoked' maps to the generic screen by design: a
        // revoked code should not explain itself to whoever holds it.
        return json({ error: 'locked', reason: gate.why || 'bad', why: gate.why || 'bad',
          hint: gate.why === 'expired' ? 'This trial has ended.'
              : gate.why === 'devices' ? 'This code is already in use on its allowed devices.'
              : gate.why === 'revoked' ? 'This code is no longer active.'
              : 'This preview is password-protected.' }, 401, origin);
      }
      return json({ ok: true, gated: gate.configured, trial: !!gate.trial,
        label: gate.label || null, expires: gate.expires || null }, 200, origin);
    }

    // ---- Server-side market history (v381). Dormant until MARKET_DB is bound. ----
    // Newest stored trading date (the app asks this, then pulls any days it lacks).
    if (url.pathname === '/history/latest') {
      if (gate.configured && !gate.ok) return locked();
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exch = (url.searchParams.get('exch') || 'ASX').slice(0, 8);
      { const g = await _nyseGate(env, exch, origin); if (g) return g; } // w406
      const row = await env.MARKET_DB.prepare('SELECT v, updated FROM meta WHERE k=?').bind('latest_' + exch).first();
      return json({ ok: true, exch, date: row ? row.v : null, updated: row ? row.updated : null }, 200, origin);
    }
    // One day's whole-market snapshot (the delta the app merges into its history).
    if (url.pathname.startsWith('/history/day/')) {
      if (gate.configured && !gate.ok) return locked();
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const date = url.pathname.slice('/history/day/'.length).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'bad date (want YYYY-MM-DD)' }, 400, origin);
      const exch = (url.searchParams.get('exch') || 'ASX').slice(0, 8);
      { const g = await _nyseGate(env, exch, origin); if (g) return g; } // w406
      const res = await env.MARKET_DB.prepare('SELECT ticker AS t,o,h,l,c,v FROM bars WHERE exch=? AND d=? ORDER BY ticker').bind(exch, date).all();
      return json({ ok: true, exch, date, rows: (res && res.results) || [] }, 200, origin);
    }
    // v385: one share's recent bars from the store — the fast path for the app's
    // per-share history loader. Depth-guarded client-side; shallow answers just
    // mean "pantry not stocked yet" and the app falls back to the live routes.
    // ---- POST /history/bundle - bars for MANY tickers in one call. w503.
    //      Same data and same shape as /history/series, batched. The app's old
    //      path made one relay request per share; this is one request per batch.
    if (method === 'POST' && url.pathname === '/history/bundle') {
      if (gate.configured && !gate.ok) return locked();
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      if (_bodyTooBig(request)) return json({ error: 'request too large' }, 413, origin);
      let body = null;
      try { body = await request.json(); } catch (e) { return json({ error: 'want JSON {exch,tickers,days}' }, 400, origin); }
      const exch = String((body && body.exch) || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (!exch) return json({ error: 'want an exch' }, 400, origin);
      { const g = await _nyseGate(env, exch, origin); if (g) return g; }
      let tickers = Array.isArray(body && body.tickers) ? body.tickers : [];
      tickers = tickers.map(t => String(t || '').toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 12))
                       .filter(Boolean);
      tickers = [...new Set(tickers)].slice(0, 200);   // capped: a batch, not a dump
      if (!tickers.length) return json({ error: 'want at least one ticker' }, 400, origin);
      let days = parseInt((body && body.days) || 365, 10);
      if (!(days > 0)) days = 365; if (days > 800) days = 800;
      const fromD = new Date(); fromD.setUTCDate(fromD.getUTCDate() - days);
      const from = fromD.toISOString().slice(0, 10);

      const out = {};
      try {
        // one query for the whole batch. IN(...) with bound placeholders - never
        // string-built, or a ticker could carry SQL into the query.
        const marks = tickers.map(() => '?').join(',');
        const res = await env.MARKET_DB.prepare(
          'SELECT ticker,d AS date,o,h,l,c,v FROM bars WHERE exch=? AND ticker IN (' + marks + ') AND d>=? ORDER BY ticker,d'
        ).bind(exch, ...tickers, from).all();
        for (const r of ((res && res.results) || [])) {
          const t = r.ticker;
          (out[t] || (out[t] = [])).push({ date: r.date, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
        }
      } catch (e) {
        return json({ error: 'history read failed', detail: String((e && e.message) || e) }, 500, origin);
      }
      // say plainly which tickers this server has nothing for, so the app can
      // fall back for those rather than silently showing a share with no history
      const missing = tickers.filter(t => !out[t] || !out[t].length);
      return json({ ok: true, exch, workerV: _WV, days,
        asked: tickers.length, found: tickers.length - missing.length, missing,
        series: out }, 200, origin);
    }

    if (url.pathname.startsWith('/history/series/')) {
      if (gate.configured && !gate.ok) return locked();
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const parts = url.pathname.slice('/history/series/'.length).split('/');
      const exch = String(parts[0] || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const ticker = String(parts[1] || '').toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 12);
      if (!exch || !ticker) return json({ error: 'want /history/series/EXCH/TICKER' }, 400, origin);
      { const g = await _nyseGate(env, exch, origin); if (g) return g; } // w406
      let days = parseInt(url.searchParams.get('days') || '365', 10);
      if (!(days > 0)) days = 365; if (days > 800) days = 800;
      const fromD = new Date(); fromD.setUTCDate(fromD.getUTCDate() - days);
      const from = fromD.toISOString().slice(0, 10);
      let rows = [];
      try {
        const res = await env.MARKET_DB.prepare('SELECT d AS date,o,h,l,c,v FROM bars WHERE exch=? AND ticker=? AND d>=? ORDER BY d').bind(exch, ticker, from).all();
        rows = (res && res.results) || [];
      } catch (e) { return json({ error: 'series read failed' }, 500, origin); }
      return json({ ok: true, exch, ticker, from, rows }, 200, origin);
    }
    // ---- GET /news/for?exch=ASX&ticker=BHP&days=60 — one share's headlines (v386) ----
    if (url.pathname === '/news/for') {
      if (gate.configured && !gate.ok) return locked();
      if (!env.MARKET_DB) return json({ error: 'news store not configured' }, 503, origin);
      if (!_newsOn(env)) return json({ ok: true, off: true, rows: [] }, 200, origin);   // dormant: quiet, not broken
      if (!(await _newsEnsure(env))) return json({ ok: true, off: true, rows: [] }, 200, origin);  // armed but not yet stocked
      const nExch = _newsExch(url.searchParams.get('exch'));
      { const g = await _nyseGate(env, nExch, origin); if (g) return g; } // w406
      const nTick = _newsTicker(url.searchParams.get('ticker'));
      if (!nTick) return json({ error: 'want ?exch=ASX&ticker=BHP' }, 400, origin);
      let nDays = parseInt(url.searchParams.get('days') || '60', 10);
      if (!(nDays > 0)) nDays = 60; if (nDays > 400) nDays = 400;
      const nFrom = new Date(Date.now() - nDays * 864e5).toISOString().slice(0, 10);
      let nRows = [];
      try {
        const r = await env.MARKET_DB.prepare('SELECT d,ts,title,url,src,kind,weight FROM news WHERE exch=? AND ticker=? AND d>=? ORDER BY ts DESC LIMIT 200').bind(nExch, nTick, nFrom).all();
        nRows = (r && r.results) || [];
      } catch (e) { return json({ error: 'news read failed' }, 500, origin); }
      return json({ ok: true, exch: nExch, ticker: nTick, from: nFrom, rows: nRows }, 200, origin, { 'Cache-Control': 'private, max-age=600' });
    }

    // ---- GET /news/days?exch=ASX&days=400 — compact per-share-per-day rows for
    //      the report cards: [ticker, day, best weight, how many]. This is what
    //      turns "had news" from an estimate into a fact — but ONLY for shares on
    //      the shortlist; everything else legitimately has no answer here. ----
    if (url.pathname === '/news/days') {
      if (gate.configured && !gate.ok) return locked();
      if (!env.MARKET_DB) return json({ error: 'news store not configured' }, 503, origin);
      if (!_newsOn(env)) return json({ ok: true, off: true, rows: [] }, 200, origin);   // dormant: quiet, not broken
      if (!(await _newsEnsure(env))) return json({ ok: true, off: true, rows: [] }, 200, origin);  // armed but not yet stocked
      const dExch = _newsExch(url.searchParams.get('exch'));
      { const g = await _nyseGate(env, dExch, origin); if (g) return g; } // w406
      let dDays = parseInt(url.searchParams.get('days') || '400', 10);
      if (!(dDays > 0)) dDays = 400; if (dDays > 800) dDays = 800;
      let minW = parseFloat(url.searchParams.get('minw') || '0');
      if (!isFinite(minW) || minW < 0) minW = 0;
      const dFrom = new Date(Date.now() - dDays * 864e5).toISOString().slice(0, 10);
      let out = [];
      try {
        const r = await env.MARKET_DB.prepare('SELECT ticker,d,MAX(weight) AS w,COUNT(*) AS n FROM news WHERE exch=? AND d>=? GROUP BY ticker,d HAVING MAX(weight)>=? ORDER BY ticker,d LIMIT 20000').bind(dExch, dFrom, minW).all();
        out = ((r && r.results) || []).map(x => [x.ticker, x.d, x.w, x.n]);
      } catch (e) { return json({ error: 'news read failed' }, 500, origin); }
      return json({ ok: true, exch: dExch, from: dFrom, rows: out }, 200, origin, { 'Cache-Control': 'private, max-age=900' });
    }

    // ---- GET /news/status — is it armed, what's stored, when did it last run ----
    if (url.pathname === '/news/status') {
      if (gate.configured && !gate.ok) return locked();
      const st = { ok: true, on: _newsOn(env), store: !!env.MARKET_DB, sources: { yahoo: true, google: true, marketaux: !!(env && env.NEWS_KEY) } };
      if (env.MARKET_DB) {
        try { const a = await env.MARKET_DB.prepare('SELECT COUNT(*) AS n FROM news_watch').first(); st.watched = (a && a.n) || 0; } catch (e) { st.watched = null; }
        try { const b = await env.MARKET_DB.prepare('SELECT COUNT(*) AS n, MAX(ts) AS t FROM news').first(); st.headlines = (b && b.n) || 0; st.newest = (b && b.t) || null; } catch (e) { st.headlines = null; }
        try { const c = await env.MARKET_DB.prepare('SELECT v,updated FROM meta WHERE k=?').bind('news_last').first(); st.last = c ? c.v : null; st.lastRun = c ? c.updated : null; } catch (e) {}
      }
      return json(st, 200, origin);
    }

    // ---- GET /admin/news/poll?key=…&n=5 — run a polling pass by hand (v386).
    //      Also /admin/news/watch?key=…&exch=ASX&tickers=BHP,CBA to seed the
    //      shortlist without the app, which is how it gets tested. ----
    if (url.pathname === '/admin/news/poll' || url.pathname === '/admin/news/watch' || url.pathname === '/admin/news/peek' || url.pathname === '/admin/news/reclass') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'news store not configured (add the MARKET_DB binding)' }, 503, origin);
      if (!_newsOn(env)) return json({ error: 'news is off — set the NEWS_ON variable to 1 in the dashboard' }, 503, origin);
      if (!(await _newsEnsure(env))) return json({ error: 'news store setup failed' }, 500, origin);
      if (url.pathname === '/admin/news/reclass') {
        // Re-run the CURRENT relevance test and classifier over headlines that
        // were captured under older rules: drop the ones that were never about
        // the company, re-label the rest. Bounded, and safe to run repeatedly.
        const rExch = _newsExch(url.searchParams.get('exch'));
        let lim = parseInt(url.searchParams.get('n') || '2000', 10);
        if (!(lim > 0)) lim = 2000; if (lim > 20000) lim = 20000;
        let rows = [], names = {};
        try {
          const w = await env.MARKET_DB.prepare('SELECT ticker,name FROM news_watch WHERE exch=?').bind(rExch).all();
          for (const x of ((w && w.results) || [])) names[x.ticker] = x.name || '';
          const r = await env.MARKET_DB.prepare('SELECT id,ticker,title,kind,weight FROM news WHERE exch=? LIMIT ?').bind(rExch, lim).all();
          rows = (r && r.results) || [];
        } catch (e) { return json({ error: 'reclass read failed' }, 500, origin); }
        const drop = [], fix = [];
        for (const x of rows) {
          if (_newsIsNoise(x.title) || !_newsRelevant(x.ticker, names[x.ticker] || '', x.title)) { drop.push(x.id); continue; }
          const c = _newsClassify(x.title);
          if (c.kind !== x.kind || Math.abs((c.weight || 0) - (x.weight || 0)) > 0.001) fix.push([x.id, c.kind, c.weight]);
        }
        try {
          const dstmt = env.MARKET_DB.prepare('DELETE FROM news WHERE id=?');
          for (let i = 0; i < drop.length; i += 80) await env.MARKET_DB.batch(drop.slice(i, i + 80).map(id => dstmt.bind(id)));
          const ustmt = env.MARKET_DB.prepare('UPDATE news SET kind=?, weight=? WHERE id=?');
          for (let i = 0; i < fix.length; i += 80) await env.MARKET_DB.batch(fix.slice(i, i + 80).map(f => ustmt.bind(f[1], f[2], f[0])));
        } catch (e) { return json({ error: 'reclass write failed' }, 500, origin); }
        return json({ ok: true, exch: rExch, examined: rows.length, removed: drop.length, relabelled: fix.length, kept: rows.length - drop.length }, 200, origin);
      }
      if (url.pathname === '/admin/news/peek') {
        const pExch = _newsExch(url.searchParams.get('exch'));
        const pTick = _newsTicker(url.searchParams.get('ticker'));
        try {
          const q = pTick
            ? env.MARKET_DB.prepare('SELECT d,ts,title,kind,weight,src,url FROM news WHERE exch=? AND ticker=? ORDER BY ts DESC LIMIT 50').bind(pExch, pTick)
            : env.MARKET_DB.prepare('SELECT ticker,d,ts,title,kind,weight,src FROM news WHERE exch=? ORDER BY ts DESC LIMIT 50').bind(pExch);
          const r = await q.all();
          const w = await env.MARKET_DB.prepare('SELECT ticker,prio,polled,fails FROM news_watch WHERE exch=? ORDER BY prio DESC, ticker').bind(pExch).all();
          return json({ ok: true, exch: pExch, ticker: pTick || null, shortlist: (w && w.results) || [], headlines: (r && r.results) || [] }, 200, origin);
        } catch (e) { return json({ error: 'peek failed' }, 500, origin); }
      }
      if (url.pathname === '/admin/news/watch') {
        const aExch = _newsExch(url.searchParams.get('exch'));
        const ts = String(url.searchParams.get('tickers') || '').split(',').map(_newsTicker).filter(Boolean).slice(0, _NEWS.MAX_WATCH);
        if (!ts.length) return json({ error: 'want &tickers=BHP,CBA' }, 400, origin);
        const nowA = new Date().toISOString();
        // &names=BHP Group|Commonwealth Bank|Fortescue — positional, optional
        const nms = String(url.searchParams.get('names') || '').split('|').map(x => x.trim().slice(0, 80));
        const s2 = env.MARKET_DB.prepare('INSERT INTO news_watch (exch,ticker,prio,seen,name) VALUES (?,?,3,?,?) ON CONFLICT(exch,ticker) DO UPDATE SET prio=3, seen=excluded.seen, name=COALESCE(NULLIF(excluded.name,\'\'),news_watch.name)');
        try { await env.MARKET_DB.batch(ts.map((t, i) => s2.bind(aExch, t, nowA, nms[i] || null))); } catch (e) { return json({ error: 'shortlist write failed' }, 500, origin); }
        return json({ ok: true, exch: aExch, tracked: ts.length, tickers: ts }, 200, origin);
      }
      // &force=1 (v388): clear the per-ticker 20h stamps for this exchange first,
      // so a manual poll re-fetches immediately. Exists so a mis-ordered admin
      // step never again needs a hand inside the database to undo.
      if (url.searchParams.get('force') === '1') {
        const fExch = _newsExch(url.searchParams.get('exch'));
        try { await env.MARKET_DB.prepare('UPDATE news_watch SET polled=NULL, fails=0 WHERE exch=?').bind(fExch).run(); } catch (e) {}
      }
      const out = await _newsTick(env, url.searchParams.get('n'));
      return json(out, out.ok ? 200 : 503, origin);
    }

    // Manual ingest / backfill trigger (protected by the ACCESS_KEY password).
    // Handy to test end-to-end without waiting for the cron:
    // The password goes in the X-Insight-Admin header, NOT ?key= — use
    // /admin/panel, which is a page that can send a header. A plain link
    // cannot, whatever this comment used to say.



    // ---- GET /ohlc — one share's opens, highs and lows (w402) --------------
    // The app used to fetch these per share from the data provider, which
    // needed the customer's own API key and therefore never worked without
    // one. We hold a year of full bars for every share; hand them over.
    if (url.pathname === '/ohlc') {
      if (gate.configured && !gate.ok) return locked();
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const oEx = String(url.searchParams.get('exch') || 'ASX').slice(0, 8);
      { const g = await _nyseGate(env, oEx, origin); if (g) return g; } // w406
      const oTk = String(url.searchParams.get('ticker') || '').toUpperCase().slice(0, 16);
      if (!/^[A-Z0-9.\-]{1,16}$/.test(oTk)) return json({ error: 'bad ticker' }, 400, origin);
      const oN = Math.max(1, Math.min(400, +url.searchParams.get('days') || 400));
      if (await _rlOver(env, 'ohlc|' + _ip(request), 3000, 3600))
        return json({ error: 'too many history lookups in the last hour' }, 429, origin);
      const out = {};
      let n = 0;
      try {
        const r = await env.MARKET_DB.prepare(
          'SELECT d, o, h, l FROM bars WHERE exch=? AND ticker=? ORDER BY d DESC LIMIT ?')
          .bind(oEx, oTk, oN).all();
        for (const x of ((r && r.results) || [])) {
          if (!x || !x.d) continue;
          const rec = {};
          if (isFinite(x.o) && x.o > 0) rec.o = x.o;
          if (isFinite(x.h) && x.h > 0) rec.h = x.h;
          if (isFinite(x.l) && x.l > 0) rec.l = x.l;
          if (rec.o || rec.h || rec.l) { out[String(x.d)] = rec; n++; }
        }
      } catch (e) { return json({ error: 'lookup failed' }, 500, origin); }
      // A share we hold nothing for is not an error — the app falls back to its
      // own route. Say so rather than returning an empty object that reads like
      // "this share has no highs".
      return json({ ok: true, exch: oEx, ticker: oTk, n: n, ohlc: out,
        held: n > 0 }, 200, origin);
    }

    // ---- the pantry's backup routes (w401) ---------------------------------
    if (url.pathname === '/admin/panel') {
      return new Response(ADMIN_PANEL_HTML, { status: 200, headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow'
      } });
    }


    // ---- GET /admin/tech52 — build the 52-week table now (w400) -------------
    // Driven from /admin/panel. It normally rebuilds itself after the evening
    // ingest; this exists so the first one does not have to wait a day.
    // ---- w538: GET /admin/trailbasis \u2014 the same decade sample, twice:
    // trail ratcheting on CLOSES (what ships) vs on HIGHS (what Tony expected).
    // Everything else identical: same picks, same entry, same intraday trigger,
    // same costs. Whichever wins, the answer gets published either way.
    if (url.pathname === '/admin/trailbasis') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const exch = (url.searchParams.get('exch') || 'ASX').toUpperCase();
      const trailPct = Math.min(Math.max(parseFloat(url.searchParams.get('trail') || '20') || 20, 5), 50);
      const weeks = Math.min(Math.max(parseInt(url.searchParams.get('weeks') || '520', 10) || 520, 26), 520);
      const liqFloor = 250000;
      // w539: the DEEP loader. The 560-bar pantry is ~2.15 years \u2014 asking it for a
      // decade silently guarantees the 'not enough trading history' refusal.
      const maxBars = _maxBars(url) === 900 ? 2700 : _maxBars(url);
      const pan = await _pantrySeriesOHLCLong(env, exch, liqFloor, maxBars);
      if (!pan || !pan.shares || !pan.shares.length) return json({ error: 'no stored history' }, 503, origin);
      // say what window actually loaded, in days and dates, before any result
      let barsLoaded = 0, spanFrom = '', spanTo = '';
      for (const sh of pan.shares) { if (sh.series && sh.series.length > barsLoaded) { barsLoaded = sh.series.length; spanFrom = sh.series[0].d; spanTo = sh.series[sh.series.length-1].d; } }
      const weeksAvailable = Math.floor(barsLoaded / 5);
      if (weeks > weeksAvailable) return json({ ok: false, error: 'the stored history holds ' + barsLoaded +
        ' trading days (' + spanFrom + ' to ' + spanTo + ' \u2248 ' + weeksAvailable + ' weeks) \u2014 not enough for a ' +
        weeks + '-week window. Re-run with weeks=' + weeksAvailable + ' or lower.',
        barsLoaded, weeksAvailable, spanFrom, spanTo }, 200, origin);
      const base = { entryDays: 5, totalWeeks: weeks, topN: 4, minScore: 7, buyLevel: -2,
        maxPositions: 20, startingCapital: 100000, exitMode: 'trail', trailPct,
        feePerSide: 3, slipPct: 0, liqFloor, excludeNonEquity: true,
        bands: [{ label: '$0.20 \u2013 $0.99', min: 0.20, max: 0.99 }] };
      const out = {};
      for (const basis of ['close', 'high']) {
        try {
          const r = _dipLadderCompoundingByPriceBand(pan.shares, { ...base, peakBasis: basis });
          // w539: surface the engine's own refusal verbatim instead of hiding it
          if (r && r.error) { out[basis] = { error: r.error }; continue; }
          const b = (r.bands && r.bands[0]) || null;
          out[basis] = b ? { returnPct: b.totalReturnPct, trades: b.taken, offered: b.offered,
            winRate: b.winRate, finalValue: b.finalAccountValue, drawdown: b.drawdown,
            avgHeldDays: (b.turnover && b.turnover.avgHeldDays) != null ? b.turnover.avgHeldDays : null,
            costShareOfGrossPct: (b.turnover && b.turnover.costShareOfGrossPct) != null ? b.turnover.costShareOfGrossPct : null,
            firstPick: r.firstPickDate, lastPick: r.lastPickDate }
            : { error: 'the engine returned no band \u2014 raw keys: ' + Object.keys(r || {}).join(',') };
        } catch (e) { out[basis] = { error: String((e && e.message) || e).slice(0, 200) }; }
      }
      const C = out.close, H = out.high;
      const bothRan = C && H && C.returnPct != null && H.returnPct != null && C.trades > 0 && H.trades > 0;
      return json({ ok: true, exch, trailPct, weeks, universe: pan.shares.length,
        window: { barsLoaded, weeksAvailable, from: spanFrom, to: spanTo },
        close: C, high: H,
        verdict: bothRan
          ? ((H.returnPct > C.returnPct)
              ? 'HIGH basis wins by ' + (H.returnPct - C.returnPct).toFixed(1) + ' points (' + H.trades + ' vs ' + C.trades + ' trades)'
              : 'CLOSE basis wins by ' + (C.returnPct - H.returnPct).toFixed(1) + ' points (' + C.trades + ' vs ' + H.trades + ' trades)')
          : 'NOT COMPARABLE \u2014 at least one side produced no trades; see the error on each side' }, 200, origin);
    }

    // ---- w537: GET/POST /annbulk \u2014 many tickers, one answer, from OUR store.
    // Body {tickers:[...]} or ?t=AAA,BBB. Reads the announcements w532 already
    // collected market-wide, so it never touches the ASX or a public relay.
    if (url.pathname === '/annbulk') {
      const g = await gateStatus(request, env);
      if (g.configured && !g.ok) return json({ error: 'locked', why: g.why }, 401, origin);
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      let want = [];
      try {
        if (request.method === 'POST') { const b = await request.json(); want = (b && b.tickers) || []; }
        else want = String(url.searchParams.get('t') || '').split(',');
      } catch (e) {}
      want = [...new Set(want.map(x => String(x || '').trim().toUpperCase()).filter(x => /^[A-Z0-9]{3}$/.test(x)))].slice(0, 200);
      if (!want.length) return json({ ok: true, days: 0, by: {} }, 200, origin);
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 120);
      const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
      const by = {};
      for (const t of want) by[t] = [];
      for (let i = 0; i < want.length; i += 60) {
        const ch = want.slice(i, i + 60);
        try {
          const rs = await env.MARKET_DB.prepare(
            'SELECT ticker,d,title,sens,kind,url FROM news WHERE exch=? AND src=? AND d>=? AND ticker IN (' + ch.map(()=>'?').join(',') + ') ORDER BY d DESC LIMIT 1200'
          ).bind('ASX', 'asx', since, ...ch).all();
          for (const r of ((rs && rs.results) || [])) {
            const a = by[r.ticker]; if (!a || a.length >= 12) continue;
            a.push({ d: r.d, t: r.title, ps: r.sens ? 1 : 0, k: r.kind, u: r.url || '' });
          }
        } catch (e) {}
      }
      let start = null; try { start = await _getMeta(env, 'ann_feed_start_ASX'); } catch (e) {}
      // Honesty: say how far back this store actually reaches, so the app can
      // tell "no announcements" apart from "we weren't collecting yet".
      return json({ ok: true, source: 'store', since, feedStart: start || null, by }, 200, origin);
    }

    // ---- w535: SYNCED ACCOUNT ROUTES. gateStatus vouches for the caller
    // (master password or live trial code); the account is keyed to whichever
    // credential unlocked it, so a licence IS an account.
    if (url.pathname === '/acct' || url.pathname.startsWith('/acct/')) {
      const g = await gateStatus(request, env);
      if (g.configured && !g.ok) return json({ error: 'locked', why: g.why }, 401, origin);
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const cust = _acctCust(g, request);
      if (url.pathname === '/acct' && request.method === 'GET') {
        const st = await _acctGet(env, cust);
        const P = await env.MARKET_DB.prepare('SELECT * FROM acct_pos WHERE cust=? ORDER BY id DESC LIMIT 400').bind(cust).all();
        const rows = (P && P.results) || [];
        let rules = null; try { rules = st.rules ? JSON.parse(st.rules) : null; } catch (e) {}
        return json({ ok: true, cust: (cust === 'OWNER' ? 'OWNER' : 'licence'), cash: st.cash, startCash: st.start_cash,
          auto: !!st.auto, rules, steppedDay: st.stepped_day || null,
          open: rows.filter(r => r.status === 'open' || r.status === 'closing'),
          pending: rows.filter(r => r.status === 'pending'),
          closed: rows.filter(r => r.status === 'closed').slice(0, 120),
          expired: rows.filter(r => r.status === 'expired').slice(0, 40) }, 200, origin);
      }
      if (url.pathname === '/acct/rules' && request.method === 'POST') {
        let body = null; try { body = await request.json(); } catch (e) {}
        const v = _botRulesSanitize(body || {});
        if (!v.ok) return json({ ok: false, error: v.error }, 400, origin);
        await _acctGet(env, cust);
        await env.MARKET_DB.prepare('UPDATE acct_state SET rules=?, updated=? WHERE cust=?')
          .bind(JSON.stringify(v.rules), new Date().toISOString(), cust).run();
        return json({ ok: true, rules: v.rules }, 200, origin);
      }
      if (url.pathname === '/acct/auto' && request.method === 'POST') {
        let body = null; try { body = await request.json(); } catch (e) {}
        const on = body && body.on ? 1 : 0;
        const st = await _acctGet(env, cust);
        if (on && !st.rules) return json({ ok: false, error: 'save your rules first \u2014 the server buys with YOUR settings, so it refuses to guess them' }, 400, origin);
        await env.MARKET_DB.prepare('UPDATE acct_state SET auto=?, updated=? WHERE cust=?').bind(on, new Date().toISOString(), cust).run();
        return json({ ok: true, auto: !!on }, 200, origin);
      }
      if (url.pathname === '/acct/reset' && request.method === 'POST') {
        let body = null; try { body = await request.json(); } catch (e) {}
        if (!body || body.confirm !== 'RESET') return json({ ok: false, error: "send {confirm:'RESET'} \u2014 this wipes the synced account's history" }, 400, origin);
        await _acctGet(env, cust);
        await env.MARKET_DB.prepare('DELETE FROM acct_pos WHERE cust=?').bind(cust).run();
        await env.MARKET_DB.prepare('UPDATE acct_state SET cash=?, start_cash=?, auto=0, stepped_day=NULL, updated=? WHERE cust=?')
          .bind(_ACCT.START_CASH, _ACCT.START_CASH, new Date().toISOString(), cust).run();
        return json({ ok: true, cash: _ACCT.START_CASH }, 200, origin);
      }
      return json({ error: 'unknown account route' }, 404, origin);
    }

    // ---- GET /admin/annprobe — fetch + parse the ASX feed, store NOTHING.
    // Day-one verification: Tony reads the parsed sample in a browser before
    // the nightly task is trusted. If the page's markup ever changes, this is
    // where the evidence lives.
    if (url.pathname === '/admin/annprobe') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      let body = '', http = 0;
      try { const r = await fetch(_ANN_SRC.URL, { headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0 (InsightTrading EOD research; contact via app)' } }); http = r.status; body = (await r.text()).slice(0, _ANN_SRC.MAX_BODY); }
      catch (e) { return json({ ok: false, error: 'fetch failed: ' + String(e).slice(0, 120) }, 502, origin); }
      const parsed = _annParseToday(body);
      const sensN = parsed.filter(a => a.sens).length;
      return json({ ok: parsed.length > 0, http, bytes: body.length, parsed: parsed.length, sensitive: sensN,
        sample: parsed.slice(0, 12).map(a => ({ ticker: a.ticker, sens: a.sens, title: a.title.slice(0, 120), kind: _newsClassify(a.title).kind })),
        rawHead: parsed.length ? undefined : body.slice(0, 400) }, 200, origin);
    }

    // ---- GET /admin/annrun — run the market-wide announcement pull now ----
    if (url.pathname === '/admin/annrun') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const out = await _annPollMarket(env);
      return json(out, 200, origin);
    }

    if (url.pathname === '/admin/tech52') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const ex = String(url.searchParams.get('exch') || '').toUpperCase();
      let list = (ex === 'ASX' || ex === 'NYSE') ? [ex] : ['ASX', 'NYSE'];
      if (NYSE_RETIRED) list = list.filter(e => e !== 'NYSE'); // w411
      const out = [];
      for (const e of list) { try { out.push(await buildTech52(env, e)); } catch (err) { out.push({ ok: false, exch: e, error: String(err).slice(0, 120) }); } }
      return json({ ok: out.some(x => x && x.ok), built: out }, 200, origin);
    }

    // ---- GET /admin/status — how deep is the pantry, really -----------------
    if (url.pathname === '/admin/status') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      const depth = [];
      try {
        const r = await env.MARKET_DB.prepare(
          'SELECT exch, COUNT(DISTINCT d) AS days, MIN(d) AS oldest, MAX(d) AS newest FROM bars GROUP BY exch').all();
        for (const x of ((r && r.results) || [])) {
          // w463 — the backfill's own stopping message could only ever say
          // "the store is as far back as the data goes, OR the provider
          // refused" because nothing surfaced which one actually happened.
          // bf_lasterr_* is written the moment ingestDay's upstream call
          // fails to parse as JSON — read it back here so a stalled crawl
          // shows the real EODData response instead of that guess.
          let lastErr = null;
          try { const le = await _getMeta(env, 'bf_lasterr_' + x.exch); if (le) lastErr = JSON.parse(le); } catch (e) {}
          depth.push({ exch: x.exch, days: x.days, oldest: x.oldest, newest: x.newest,
            target: _BF.TARGET[x.exch] || null,
            deep: (x.days >= _DEEP_DAYS), deepNeeded: _DEEP_DAYS,
            ready: (x.days >= _DEEP_DAYS) && (String(await _getMeta(env, 'tech52_' + x.exch) || '') === String(x.newest || '')),
            cursor: await _getMeta(env, 'bf_cursor_' + x.exch),
            lastBackfillError: lastErr });
          // reading it here is free, so keep the cached number honest too
          try { await _setMeta(env, 'days_' + x.exch, String(x.days || 0)); } catch (e) {}
        }
      } catch (e) { return json({ error: 'could not read the store' }, 500, origin); }
      return json({ ok: true, v: _WV, depth: depth }, 200, origin);
    }

    // ---- GET /admin/backfill — fill the pantry faster, on demand (w395) ----
    // Driven from /admin/panel, which supplies the password as a header.
    // Capped at ten a click on purpose. Every day fetched is a real billed call
    // on the EODData plan, so a loop that decides for itself when to stop is a
    // bill, not a feature.
    if (url.pathname === '/admin/backfill') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured' }, 503, origin);
      let days = Math.max(1, Math.min(10, (+url.searchParams.get('days') || 4)));
      const before = {};
      for (const ex of Object.keys(_BF.TARGET)) before[ex] = await _getMeta(env, 'bf_cursor_' + ex);
      const was = _BF.PER_FIRING;
      _BF.PER_FIRING = days;
      try { await _backfillTick(env); } finally { _BF.PER_FIRING = was; }
      const after = {};
      for (const ex of Object.keys(_BF.TARGET)) after[ex] = await _getMeta(env, 'bf_cursor_' + ex);
      return json({ ok: true, asked: days, before: before, after: after,
        target: _BF.TARGET, note: 'click again to keep going' }, 200, origin);
    }

    // ---- GET /admin/mailtest - send today's picks email now (w552) ----------
    if (url.pathname === '/admin/mailtest') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured (add the MARKET_DB binding)' }, 503, origin);
      let _mday = String(url.searchParams.get('date') || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(_mday)) {
        try { const lm = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind('latest_ASX').first(); _mday = String((lm && lm.v) || '').slice(0, 10); } catch (e) {}
      }
      const r = await _picksMailSend(env, _mday);
      if (r && r.ok) return json({ ok: true, day: _mday, picks: r.picks }, 200, origin);
      return json({ ok: false, day: _mday, error: (r && (r.skip || r.detail || ('status ' + r.status))) || 'send failed' }, 500, origin);
    }

    if (url.pathname === '/admin/ingest') {
      { const d = adminAuth(request, env); if (d) {
          if (d.status === 401 && await _rlOver(env, 'admin|' + _ip(request), 8, 900))
            return json({ error: 'too many attempts, try later' }, 429, origin);
          return json(d.body, d.status, origin); } }
      if (!env.MARKET_DB) return json({ error: 'history store not configured (add the MARKET_DB binding)' }, 503, origin);
      const exch = (url.searchParams.get('exch') || 'ASX').slice(0, 8);
      { const g = await _nyseGate(env, exch, origin); if (g) return g; } // w406
      const date = (url.searchParams.get('date') || sydneyNow().date).slice(0, 10);
      const out = await ingestDay(env, date, 'manual', exch);
      return json(out, out.ok ? 200 : 502, origin);
    }

    // ---- GET /eod/<eoddata-path> — market data proxy (Phase 1) ----
    if (!url.pathname.startsWith('/eod/')) return json({ error: 'not found' }, 404, origin);
    if (gate.configured && !gate.ok) return locked();
    const eodPath = url.pathname.slice('/eod/'.length);
    if (eodPath.includes('..') || eodPath.length > 120) return json({ error: 'bad path' }, 400, origin);
    if (!ALLOWED_PREFIXES.some(p => eodPath.startsWith(p))) return json({ error: 'endpoint not allowed' }, 403, origin);
    // w406: after retirement the server's own key stops proxying US symbols —
    // a market this server doesn't serve must not drain its paid quota either.
    if (/\.US(\b|$|[?&,])/i.test(eodPath) || /[?&]exchange=US\b/i.test(url.search)) {
      if (await _nyseOffFlag(env)) return json(_NYSE_GONE_MSG, 410, origin);
    }
    if (!env.EODDATA_KEY) return json({ error: 'server not configured (no EODDATA_KEY secret)' }, 500, origin);

    // w392: every non-apikey parameter went into the cache key AND the upstream
    // URL, so ?z=1, ?z=2, ?z=3 … was an unlimited supply of cache misses, each
    // one a real billed call on the EODData plan. Parameters are now sanity-
    // checked, and misses are rate-limited below.
    const _eodParams = [];
    for (const [k, v] of url.searchParams) {
      if (k.toLowerCase() === 'apikey') continue;
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,15}$/.test(k) || String(v).length > 40) continue;
      _eodParams.push([k, v]);
      if (_eodParams.length >= 4) break;
    }
    const cacheUrl = new URL(url.origin + '/eod/' + eodPath);
    for (const [k, v] of _eodParams) cacheUrl.searchParams.set(k, v);
    // w551: DAY-KEYED CACHE for the pantry list routes. The old key was path+params
    // with a 30-minute TTL - so every close-evening, a request that slipped in just
    // before the new day landed pinned its edge PoP to YESTERDAY for up to half an
    // hour, at exactly the moment users open the app (20 Aug: a device refreshed
    // repeatedly and kept receiving the 19th while D1 held the 20th). The served
    // day is now part of the key: one 1-row meta read, and the moment latest_ASX
    // advances, every request walks past every stale entry. Old entries die unused.
    let _pdDay = '';
    try {
      if (env.MARKET_DB && /^(?:(?:quote|symbol)\/list\/[A-Za-z]+$|technical\/list\/[A-Za-z]+$)/.test(eodPath)) {
        const _pdr = await env.MARKET_DB.prepare('SELECT v FROM meta WHERE k=?').bind('latest_ASX').first();
        if (_pdr && _pdr.v) { _pdDay = String(_pdr.v).slice(0, 10); cacheUrl.searchParams.set('pd', _pdDay); }
      }
    } catch (e) {}
    const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const h = new Headers(cached.headers);
      for (const [k, v] of Object.entries(corsHeaders(origin))) h.set(k, v);
      h.set('X-Insight-Cache', 'HIT');
      return new Response(cached.body, { status: cached.status, headers: h });
    }

    // w546: quote/list is served from OUR OWN PANTRY — the upstream provider is dead.
    // This one intercept heals every device at once: the live share list (symbols +
    // OHLCV for the latest stored day) AND the per-day DateStamp history path the app
    // uses for month-average bulk calls (each request = one D1 read, honestly dated).
    // Names ride along from each device's saved store; a names enrichment (EODHD
    // symbol-list with real Type fields) is the queued w547 follow-up.
    {
      const _ql = eodPath.match(/^(?:quote|symbol)\/list\/([A-Za-z]+)$/); // w549: symbol/list too — it is the FIRST url every load tries, and was burning a 4s dead-upstream round-trip per load before quote/list rescued it
      if (_ql && String(_ql[1]).toUpperCase() === 'ASX' && env.MARKET_DB) {
        try {
          let _want = '';
          try { for (const [k, v] of _eodParams) { if (String(k) === 'DateStamp') { _want = String(v).slice(0, 10); break; } } } catch (e) {}
          // w548 bench catch: _eodParams is an iterable of pairs, NOT URLSearchParams — the old
          // .get() returned undefined, so EVERY request (history included) fell into the frontier
          // branch and got the latest day mislabeled. Found by the behavioural bench pre-paste.
          let _day = null;
          if (/^\d{4}-\d{2}-\d{2}$/.test(_want)) {
            // w548: the old provider's REAL contract, finally stated. A request at the
            // FRONTIER (today / any date at-or-after our newest bar) serves the latest
            // session — that is what "current prices" means before a new close exists
            // (w547's exact-only broke every morning list: 0 shares). A request for a
            // HISTORICAL date serves that exact day or nothing — no fabricated days
            // (w546's nearest-earlier fill invented a phantom "today" in holdings).
            const _mx = await env.MARKET_DB.prepare('SELECT MAX(d) AS d FROM bars WHERE exch=?').bind('ASX').first();
            const _latest = _mx && _mx.d;
            if (_latest && _want >= _latest) { _day = _latest; }
            else {
              const r = await env.MARKET_DB.prepare('SELECT COUNT(*) AS n FROM bars WHERE exch=? AND d=?').bind('ASX', _want).first();
              _day = (r && r.n > 0) ? _want : null;
            }
          } else {
            const r = await env.MARKET_DB.prepare('SELECT MAX(d) AS d FROM bars WHERE exch=?').bind('ASX').first();
            _day = r && r.d;
          }
          if (_day) {
            const rs = await env.MARKET_DB.prepare('SELECT ticker,o,h,l,c,v FROM bars WHERE exch=? AND d=?').bind('ASX', _day).all();
            const rows = (rs && rs.results) || [];
            // w551: THE LIST NOW SPEAKS THE APP'S CONTRACT. mapRecord reads lowercase
            // code/close/previous/change (the OpenAPI shape the old provider used);
            // the capitalized Symbol/Close rows shipped since w546 mapped to NULL -
            // every "accepted" pantry list quietly became zero shares and the app
            // fell back to its saved snapshot, which is why day-change sat blank and
            // the universe count never matched. previous/change come from the prior
            // stored day (one extra query, cached with the response); capitalized
            // duplicates stay for any legacy reader.
            let _pc = {};
            try {
              const _pv = await env.MARKET_DB.prepare('SELECT MAX(d) AS d FROM bars WHERE exch=? AND d<?').bind('ASX', _day).first();
              if (_pv && _pv.d) {
                const _pr = await env.MARKET_DB.prepare('SELECT ticker,c FROM bars WHERE exch=? AND d=?').bind('ASX', _pv.d).all();
                for (const p of ((_pr && _pr.results) || [])) _pc[p.ticker] = p.c;
              }
            } catch (e) {}
            if (rows.length > 0) {
              const quotes = rows.map(x => {
                const prev = (_pc[x.ticker] != null) ? _pc[x.ticker] : null;
                const chg = (prev != null && x.c != null) ? +(x.c - prev).toFixed(6) : null;
                return { code: x.ticker, name: '', type: '', currency: 'AUD',
                         open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v,
                         previous: prev, change: chg, dateStamp: _day,
                         Symbol: x.ticker, Name: '', Open: x.o, High: x.h, Low: x.l, Close: x.c, Volume: x.v, DateTime: _day };
              });
              const body = JSON.stringify({ quotes, source: 'pantry', day: _day });
              const resp = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'X-Insight-List': 'pantry:' + _day, ...corsHeaders(origin) } });
              try { const cc = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': _want && _want < new Date().toISOString().slice(0,10) ? 'public, max-age=86400' : 'public, max-age=300' } }); await caches.default.put(cacheKey, cc); } catch (e) {}
              return resp;
            }
          }
        } catch (e) { /* fall through to the (dead) upstream so behaviour is unchanged on error */ }
      }
    }
    // w549: per-ticker HISTORY range from the pantry — quote/list/ASX/{ticker}
    // with FromDateStamp/ToDateStamp. This was the last per-load path that could
    // still fall through to the dead upstream (only when /history/series answered
    // shallow). Rows are the pantry shape {d,o,h,l,c,v}; the app's readers accept
    // it (v695: _sortedCloses reads d/c/h/l/v directly).
    {
      const _qt = eodPath.match(/^quote\/list\/([A-Za-z]+)\/([A-Za-z0-9]{1,6})$/);
      if (_qt && String(_qt[1]).toUpperCase() === 'ASX' && env.MARKET_DB) {
        try {
          let _from = '', _to = '';
          try { for (const [k, v] of _eodParams) { const kk = String(k); if (kk === 'FromDateStamp') _from = String(v).slice(0, 10); else if (kk === 'ToDateStamp') _to = String(v).slice(0, 10); } } catch (e) {}
          const _tick = String(_qt[2]).toUpperCase();
          const _lo = /^\d{4}-\d{2}-\d{2}$/.test(_from) ? _from : '1900-01-01';
          const _hi = /^\d{4}-\d{2}-\d{2}$/.test(_to) ? _to : '9999-12-31';
          const rs = await env.MARKET_DB.prepare('SELECT d,o,h,l,c,v FROM bars WHERE exch=? AND ticker=? AND d BETWEEN ? AND ? ORDER BY d').bind('ASX', _tick, _lo, _hi).all();
          const rows = (rs && rs.results) || [];
          if (rows.length > 0) {
            const body = JSON.stringify({ quotes: rows, source: 'pantry', ticker: _tick });
            const _histDone = _hi < new Date().toISOString().slice(0, 10);
            const resp = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'X-Insight-List': 'pantry-range', ...corsHeaders(origin) } });
            try { const cc = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': _histDone ? 'public, max-age=86400' : 'public, max-age=300' } }); await caches.default.put(cacheKey, cc); } catch (e) {}
            return resp;
          }
          // an empty range for a real request is an honest miss - fall through unchanged
        } catch (e) { /* fall through so behaviour is unchanged on error */ }
      }
    }
    // w549: technical/list/ASX from the pantry — pre-computed month/year average
    // volumes per ticker, which is all the app's bulk-volume feature reads
    // (symbolCode + monthAvgVolume + yearAvgVolume, app line ~16927). One
    // aggregate over ~1 year of bars, cached a day; the upstream is dead.
    {
      const _tl = eodPath.match(/^technical\/list\/([A-Za-z]+)$/);
      if (_tl && String(_tl[1]).toUpperCase() === 'ASX' && env.MARKET_DB) {
        try {
          const _mx = await env.MARKET_DB.prepare('SELECT MAX(d) AS d FROM bars WHERE exch=?').bind('ASX').first();
          const _latest = _mx && _mx.d;
          if (_latest) {
            const _y = new Date(Date.parse(_latest + 'T00:00:00Z') - 365 * 86400000).toISOString().slice(0, 10);
            const _m = new Date(Date.parse(_latest + 'T00:00:00Z') - 31 * 86400000).toISOString().slice(0, 10);
            const rs = await env.MARKET_DB.prepare(
              'SELECT ticker, CAST(ROUND(AVG(CASE WHEN d>=? THEN v END)) AS INTEGER) AS mv, CAST(ROUND(AVG(v)) AS INTEGER) AS yv FROM bars WHERE exch=? AND d>=? GROUP BY ticker'
            ).bind(_m, 'ASX', _y).all();
            const rows = (rs && rs.results) || [];
            if (rows.length > 0) {
              const technicals = rows.map(x => ({ symbolCode: x.ticker, monthAvgVolume: x.mv || 0, yearAvgVolume: x.yv || 0 }));
              const body = JSON.stringify({ technicals, source: 'pantry', asOf: _latest });
              const resp = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'X-Insight-List': 'pantry-tech:' + _latest, ...corsHeaders(origin) } });
              try { const cc = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' } }); await caches.default.put(cacheKey, cc); } catch (e) {}
              return resp;
            }
          }
        } catch (e) { /* fall through so behaviour is unchanged on error */ }
      }
    }
    // A cache hit costs nothing; a miss costs a real upstream call against a
    // paid plan. So the limit belongs here, on the misses, not on requests.
    if (await _rlOver(env, 'eodmiss|' + _ip(request), 200, 3600))
      return json({ error: 'too many upstream fetches in the last hour' }, 429, origin);
    const upstream = new URL('https://api.eoddata.com/' + eodPath);
    for (const [k, v] of _eodParams) upstream.searchParams.set(k, v);
    upstream.searchParams.set('apiKey', env.EODDATA_KEY);

    let upstreamResp;
    const _pAb = new AbortController(); const _pT = setTimeout(() => _pAb.abort(), 4000); // w545: dead provider — fail in 4s, never hang an invocation
    try { upstreamResp = await fetch(upstream.toString(), { headers: { 'Accept': 'application/json' }, signal: _pAb.signal }); clearTimeout(_pT); }
    catch (e) { clearTimeout(_pT); return json({ error: 'upstream fetch failed' }, 502, origin); }
    // w392: an upstream error body is relayed to the caller unread today. If
    // EODData ever echoes the offending request — some APIs print "invalid API
    // key: <key>" — that reaches a customer. Errors get a fixed message.
    const body = await upstreamResp.text();
    if (!upstreamResp.ok) return json({ error: 'upstream error', status: upstreamResp.status }, 502, origin);
    const looksJson = body && (body.trim()[0] === '[' || body.trim()[0] === '{');
    const out = new Response(body, { status: upstreamResp.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}`, 'X-Insight-Cache': 'MISS', ...corsHeaders(origin) } });
    if (upstreamResp.ok && looksJson) {
      const toCache = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
      ctx.waitUntil(cache.put(cacheKey, toCache));
    }
    return out;
  },
};

// Test-only named exports (ignored by the Workers runtime, which uses `default`).
export { scanToday, scanReplay, scanRuleKeys, runReports, _reportShape, _reportBars, REPORTS_OPEN, REPORTS_DEEP, buildTech52, pantryMonths, pantryExport, pantryImport, pantryToR2, _reportExt, _reportRecent, REPORTS_HELD, _DEEP_DAYS, _SCAN_SELECTORS, _scShare, _scanNewsMaps, adminAuth, _rlOver, _fingerprint, _capShares, _ingestPass, ingestDay, _parseQuoteRows, sydneyNow, gateStatus, _ingestPassNY, nyNow, _bfPrevWeekday, _bfFloorDate, _BF ,
  _lastClosedDay, _ingestCatchUp, _ingestFresh, _INGEST, _getMeta,
  _rssItems, _xClean, _newsLocalDay, _newsClassify, _newsRelevant, _newsKeywords, _annFromStore, _annParseToday, _annPollMarket, _simulateTrailingStop, _acctEnsure, _acctGet, _acctStepOne, _acctStepAll, _acctAddTradingDays, _ACCT, _csSpread, _frictionPct, _frictionPctExec, _frictionOk, gradeShares, _newsIsNoise, _newsId, _newsNorm, _newsDate, _newsSources, _newsFetchOne, _newsTick, _newsStore, _newsEnsure, _newsOn, _newsTicker, _newsExch, _newsJsonItems, _NEWS };
