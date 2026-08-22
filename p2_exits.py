"""
The exit engine, v1 — the NIGHTLY RATCHET PASS. Dry-run only: this module
contains no order-placing code at all. It reads real positions, updates each
position's peak from the day's close, computes the trailing stop, applies the
ratchet-protection rule, classifies each position into its regime, and PRINTS
the plan a later phase would execute.

Spec: claude_bridge-exit-phase-spec-2026-08-21.md. The rules it implements:

  * stop = peak x (1 - trail%), ratcheting on CLOSES (the shipped engine's
    basis, until the w540 trail-basis study says otherwise).
  * THE RATCHET NEVER RETREATS from a settings change: a recomputed level below
    the stored stop keeps the stored stop. The ONLY thing that may lower a stop
    is a deliberate per-ticker override in exits_overrides.json, and every such
    lowering is called out loudly in the plan and logged in the peaks file.
  * Regime A (broker-held): trail distance > Stake's minimum stop distance
    (>$0.05 below market) -> a real Stop sell could rest at the broker.
  * Regime B (synthetic): distance <= the minimum -> no resting stop is
    possible; a daytime watcher (later phase) must fire the exit itself.

Closes come from the app's own server pantry (one public request), keyed off
BRIDGE_QUEUE_URL's origin. If the pantry is unreachable the pass degrades to
the position prices SnapTrade reports, and says so — nothing in here may crash
a run (the orders.py failure philosophy).

State: {state_dir}/peaks.json
  { "TICK": {"peak": 0.34, "stop": 0.272, "trail_pct": 20.0,
             "basis": "close", "updated": "2026-08-21", "history": [...] } }

Optional per-ticker overrides: exits_overrides.json in the bridge folder
  { "TICK": {"trail_pct": 15.0} , "OTHER": {"stop": 0.30} }
  - trail_pct: use this trail for the ticker instead of EXIT_TRAIL_PCT
  - stop: pin the stop to exactly this level (may LOWER it - deliberate only)

Env (all optional):
  EXIT_TRAIL_PCT          default 20    (percent below peak)
  EXIT_MIN_STOP_DISTANCE  default 0.05  (Stake's minimum stop distance, dollars)
"""
from __future__ import annotations
import json
import os
import urllib.error
import urllib.request
from datetime import date


# ---------------------------------------------------------------------------
def _env_f(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


def load_peaks(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_peaks(path: str, peaks: dict) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(peaks, fh, indent=1, sort_keys=True)
    os.replace(tmp, path)


def load_overrides(path: str = "exits_overrides.json") -> dict:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            d = json.load(fh)
        return {str(k).upper(): v for k, v in d.items()} if isinstance(d, dict) else {}
    except Exception as e:
        print(f"  (exits_overrides.json unreadable - ignored: {e})")
        return {}


# ---------------------------------------------------------------------------
def fetch_closes(queue_url: str, timeout: int = 20) -> tuple[dict, str]:
    """Today's closes for every ASX ticker, from the app's own pantry.
    Returns ({TICKER: close}, source_note). Never raises.

    v2 (22 Aug): the worker's /eod routes sit behind the app's access lock, so
    v1's plain request came back locked and every pass fell back to SnapTrade
    prices. The bridge now sends X-Insight-Access from INSIGHT_ACCESS_KEY in
    .env (the same access password the app uses). Without it, the graceful
    fallback remains - the note just tells you what to set."""
    if not queue_url:
        return {}, "no BRIDGE_QUEUE_URL - using SnapTrade position prices"
    url = queue_url.rstrip("/") + "/eod/quote/list/ASX"
    headers = {"Accept": "application/json"}
    akey = os.environ.get("INSIGHT_ACCESS_KEY", "").strip()
    if akey:
        headers["X-Insight-Access"] = akey
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
        rows = data.get("quotes") or []
        out = {}
        for q in rows:
            t = str(q.get("code") or q.get("Symbol") or "").upper()
            c = q.get("close", q.get("Close"))
            if t and c is not None:
                try:
                    out[t] = float(c)
                except (TypeError, ValueError):
                    pass
        day = str(data.get("day") or "")
        if out:
            return out, f"pantry closes for {day or 'latest session'} ({len(out)} tickers)"
        return {}, "pantry answered without rows - using SnapTrade position prices"
    except urllib.error.HTTPError as e:
        if e.code in (401, 403) and not akey:
            return {}, ("pantry is access-locked - add INSIGHT_ACCESS_KEY=<your app access password> "
                        "to .env to pull real closes; using SnapTrade position prices tonight")
        return {}, f"pantry unreachable (HTTP {e.code}) - using SnapTrade position prices"
    except (urllib.error.URLError, OSError, ValueError) as e:
        return {}, f"pantry unreachable ({e.__class__.__name__}) - using SnapTrade position prices"


# ---------------------------------------------------------------------------
def run_exit_pass(holdings, cash: float, peaks: dict, closes: dict,
                  trail_pct_default: float, min_stop_distance: float,
                  overrides: dict, today: str) -> tuple[dict, list]:
    """The pure nightly pass. Returns (new_peaks, plan_rows). No I/O, no
    network, no orders - fully unit-testable.

    plan rows: dict(ticker, close, peak, stop, prev_stop, trail_pct, regime,
                    action, note)
      action: 'PLACE'   - no broker stop assumed yet; a stop WOULD be placed
              'REPLACE' - ratchet moved up; cancel + re-place higher
              'HOLD'    - stop unchanged
              'LOWERED' - a deliberate override lowered the stop (loud)
              'SKIP'    - no usable price
    """
    plan = []
    new_peaks = dict(peaks)
    for h in holdings:
        t = str(h.ticker).upper()
        if not t or (h.qty or 0) <= 0:
            continue
        close = closes.get(t)
        if close is None:
            close = h.price
        if close is None or close <= 0:
            plan.append(dict(ticker=t, close=None, peak=None, stop=None,
                             prev_stop=None, trail_pct=None, regime="-",
                             action="SKIP", note="no usable price tonight"))
            continue
        close = float(close)

        ov = overrides.get(t) or {}
        trail_pct = float(ov.get("trail_pct", trail_pct_default))

        st = dict(new_peaks.get(t) or {})
        prev_peak = float(st.get("peak") or 0.0)
        prev_stop = st.get("stop")
        prev_stop = float(prev_stop) if prev_stop is not None else None

        peak = max(prev_peak, close)
        computed = round(peak * (1.0 - trail_pct / 100.0), 6)

        pinned = ov.get("stop")
        if pinned is not None:
            stop = round(float(pinned), 6)
            if prev_stop is not None and stop < prev_stop:
                action, note = "LOWERED", (
                    f"OVERRIDE lowered the stop {prev_stop:g} -> {stop:g} - deliberate per-ticker override; logged")
            elif prev_stop is None or stop > prev_stop:
                action, note = ("PLACE" if prev_stop is None else "REPLACE"), f"stop pinned by override at {stop:g}"
            else:
                action, note = "HOLD", f"stop pinned by override at {stop:g}"
        else:
            # THE RATCHET-PROTECTION RULE: never retreat on a settings change.
            if prev_stop is not None and computed < prev_stop:
                stop = prev_stop
                action, note = "HOLD", (
                    f"ratchet kept at {prev_stop:g} (recomputed {computed:g} is lower - "
                    "a settings change never lowers a stop)")
            elif prev_stop is None:
                stop, action, note = computed, "PLACE", "first pass for this position"
            elif computed > prev_stop:
                stop, action, note = computed, "REPLACE", f"ratchet up {prev_stop:g} -> {computed:g}"
            else:
                stop, action, note = prev_stop, "HOLD", "no change tonight"

        distance = close - stop
        regime = "A broker-held" if distance > min_stop_distance else "B synthetic"

        st.update(peak=round(peak, 6), stop=stop, trail_pct=trail_pct,
                  basis="close", updated=today)
        hist = list(st.get("history") or [])
        if not hist or hist[-1].get("d") != today:
            hist.append({"d": today, "close": close, "peak": round(peak, 6), "stop": stop})
        st["history"] = hist[-30:]
        new_peaks[t] = st

        plan.append(dict(ticker=t, close=close, peak=round(peak, 6), stop=stop,
                         prev_stop=prev_stop, trail_pct=trail_pct, regime=regime,
                         action=action, note=note))
    return new_peaks, plan


# ---------------------------------------------------------------------------
def plan_stop_orders(plan_rows, peaks, open_orders, holdings_qty):
    """PHASE 2's brain, pure and testable: turn the ratchet plan + the broker's
    open orders into concrete steps. Never touches an order the bridge did not
    place (managed = the broker id recorded in the peaks file). Converges: a
    managed order that vanished at the broker (filled/cancelled there) is
    simply re-planned next pass.

    Returns (steps, notes). steps: dicts of
      {op: 'cancel', ticker, order_id}
      {op: 'place',  ticker, qty, stop}
    """
    steps, notes = [], []
    open_by_id = {str(o.get("id")): o for o in open_orders}
    stop_sells_by_ticker = {}
    for o in open_orders:
        if str(o.get("action")).upper() == "SELL" and "stop" in str(o.get("order_type", "")).lower():
            stop_sells_by_ticker.setdefault(str(o.get("ticker")).upper(), []).append(o)

    for r in plan_rows:
        t = r["ticker"]
        if not str(r.get("regime", "")).startswith("A"):
            if r.get("action") != "SKIP":
                notes.append(f"{t}: regime B (synthetic) - the watcher's job, no broker stop possible")
            continue
        qty = int(holdings_qty.get(t) or 0)
        if qty <= 0 or r.get("stop") is None:
            continue
        managed_id = str((peaks.get(t) or {}).get("broker_order_id") or "")
        managed_live = managed_id and managed_id in open_by_id
        foreign = [o for o in stop_sells_by_ticker.get(t, []) if str(o.get("id")) != managed_id]
        if foreign:
            notes.append(f"{t}: an unmanaged stop sell already rests at the broker "
                         f"(id {foreign[0].get('id')}) - NOT touching it; manage it manually or cancel it at Stake")
            continue
        act = r.get("action")
        if act in ("PLACE", "REPLACE", "LOWERED") or (act == "HOLD" and not managed_live):
            if managed_live:
                steps.append({"op": "cancel", "ticker": t, "order_id": managed_id})
            elif managed_id and act == "HOLD":
                notes.append(f"{t}: managed stop {managed_id} no longer at the broker - re-placing at the held level")
            steps.append({"op": "place", "ticker": t, "qty": qty, "stop": float(r["stop"])})
    return steps, notes


def cmd_exits_run(cfg, args, connector) -> int:
    """Phase 2: the ratchet pass PLUS broker-order convergence, honouring
    BRIDGE_MODE exactly like `run` does for buys. DRY_RUN prints WOULD lines
    and touches nothing; APPROVE asks per step; AUTO acts. Kill file wins."""
    from .safety import Mode, kill_engaged
    acct = getattr(args, "account", None) or cfg.account_id
    if not acct:
        print("No account id. Set SNAPTRADE_ACCOUNT_ID or pass --account.")
        return 1
    mode = cfg.mode
    killed = kill_engaged(cfg.kill_file)

    trail_pct = _env_f("EXIT_TRAIL_PCT", 20.0)
    min_dist = _env_f("EXIT_MIN_STOP_DISTANCE", 0.05)
    today = date.today().isoformat()
    try:
        holdings = connector.get_holdings(acct)
    except Exception as e:
        print(f"Could not read holdings: {e}"); return 1
    closes, src_note = fetch_closes(cfg.queue_url)
    overrides = load_overrides()
    peaks_path = os.path.join(cfg.state_dir, f"peaks_{acct}.json")
    peaks = load_peaks(peaks_path)
    new_peaks, plan = run_exit_pass(holdings, 0.0, peaks, closes, trail_pct, min_dist, overrides, today)
    try:
        open_orders = connector.get_open_orders(acct)
    except Exception as e:
        print(f"Could not read open orders: {e}"); return 1
    holdings_qty = {str(h.ticker).upper(): int(h.qty or 0) for h in holdings}
    steps, notes = plan_stop_orders(plan, new_peaks, open_orders, holdings_qty)

    print(f"EXITS-RUN - mode {mode.name} \u00b7 account {acct} \u00b7 kill: {killed}")
    print(f"  closes: {src_note}")
    for n in notes:
        print(f"  note: {n}")
    if killed:
        print("  KILL file engaged - nothing will be placed or cancelled."); save_peaks(peaks_path, new_peaks); return 0
    if not steps:
        print("  Broker stops already converged with the ratchet - nothing to do.")
        save_peaks(peaks_path, new_peaks); return 0

    for st in steps:
        if st["op"] == "cancel":
            line = f"CANCEL stop on {st['ticker']} (order {st['order_id']})"
        else:
            line = f"PLACE  Stop SELL {st['qty']:,} {st['ticker']} @ stop {st['stop']:g}"
        if mode == Mode.DRY_RUN:
            print(f"  [WOULD   ] {line}"); continue
        go = mode == Mode.AUTO
        if mode == Mode.APPROVE:
            ans = input(f"  [APPROVE?] {line} - do this at the broker? y/N: ").strip().lower()
            go = ans in ("y", "yes")
        if not go:
            print(f"  [SKIPPED ] {line}"); continue
        try:
            if st["op"] == "cancel":
                connector.cancel_order(acct, st["order_id"])
                tp = new_peaks.get(st["ticker"]) or {}
                tp.pop("broker_order_id", None); new_peaks[st["ticker"]] = tp
                print(f"  [DONE    ] {line}")
            else:
                res = connector.place_stop_sell(acct, st["ticker"], st["qty"], st["stop"])
                oid = str((res or {}).get("id") or "")
                tp = new_peaks.get(st["ticker"]) or {}
                tp["broker_order_id"] = oid; new_peaks[st["ticker"]] = tp
                print(f"  [DONE    ] {line} - broker id {oid or '?'}")
        except Exception as e:
            print(f"  [FAILED  ] {line} - broker error: {str(e)[:200]}")
    if mode == Mode.DRY_RUN:
        print("  0 touched (DRY_RUN). Flip BRIDGE_MODE deliberately at go-live.")
    save_peaks(peaks_path, new_peaks)
    return 0


# ---------------------------------------------------------------------------
def cmd_exits(cfg, args, connector) -> int:
    """The CLI face of the nightly pass. Prints the plan; places nothing."""
    acct = getattr(args, "account", None) or cfg.account_id
    if not acct:
        print("No account id. Set SNAPTRADE_ACCOUNT_ID or pass --account.")
        return 1

    trail_pct = _env_f("EXIT_TRAIL_PCT", 20.0)
    min_dist = _env_f("EXIT_MIN_STOP_DISTANCE", 0.05)
    today = date.today().isoformat()

    try:
        holdings = connector.get_holdings(acct)
    except Exception as e:
        print(f"Could not read holdings: {e}")
        return 1
    try:
        cash = connector.get_cash(acct)
    except Exception:
        cash = 0.0

    closes, src_note = fetch_closes(cfg.queue_url)
    overrides = load_overrides()
    # v1.1: peaks are PER ACCOUNT. v1 shared one peaks.json across accounts, so
    # the mock demo's BHP peak seeded the real account's BHP state on first run
    # (caught on the engine's first live pass, 21 Aug). One file per account id.
    peaks_path = os.path.join(cfg.state_dir, f"peaks_{acct}.json")
    peaks = load_peaks(peaks_path)

    new_peaks, plan = run_exit_pass(
        holdings, cash, peaks, closes, trail_pct, min_dist, overrides, today)

    print("EXITS - nightly ratchet pass. DRY-RUN: prints the plan, places NOTHING.")
    print(f"  account: {acct}")
    print(f"  closes:  {src_note}")
    print(f"  trail:   {trail_pct:g}% on closes | Stake min stop distance ${min_dist:g}")
    if overrides:
        print(f"  overrides: {', '.join(sorted(overrides))}  (exits_overrides.json)")
    print()
    if not plan:
        print("  No open positions - nothing to protect. A quiet night is a fine report.")
        save_peaks(peaks_path, new_peaks)
        return 0

    print(f"  {'TICKER':<8}{'CLOSE':>10}{'PEAK':>10}{'STOP':>10}{'TRAIL':>7}  {'REGIME':<14}{'ACTION':<9} NOTE")
    for r in plan:
        c = f"{r['close']:.4f}" if r["close"] is not None else "-"
        pk = f"{r['peak']:.4f}" if r["peak"] is not None else "-"
        sp = f"{r['stop']:.4f}" if r["stop"] is not None else "-"
        tr = f"{r['trail_pct']:g}%" if r["trail_pct"] is not None else "-"
        print(f"  {r['ticker']:<8}{c:>10}{pk:>10}{sp:>10}{tr:>7}  {r['regime']:<14}{r['action']:<9} {r['note']}")

    a = sum(1 for r in plan if r["regime"].startswith("A"))
    b = sum(1 for r in plan if r["regime"].startswith("B"))
    lowered = [r["ticker"] for r in plan if r["action"] == "LOWERED"]
    print(f"\n  {len(plan)} positions - {a} broker-held capable, {b} synthetic-only "
          f"(distance <= ${min_dist:g}).")
    if lowered:
        print(f"  !! STOPS LOWERED BY OVERRIDE: {', '.join(lowered)} - on the record in peaks.json.")
    print("  0 orders touched (this phase only plans). Peaks saved.")

    save_peaks(peaks_path, new_peaks)
    return 0
