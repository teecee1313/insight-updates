"""
The SYNTHETIC WATCHER — Regime B's exit layer (spec: 21 Aug 2026 handover).

Stake cannot rest a stop ≤ $0.05 below market, which covers most of the
$0.20–$0.99 band. So for those positions the bridge itself watches the price
during ASX hours and fires the sell when the ratcheted stop trades.

The rules, exactly as specced:

  * Runs 10:00–16:00 Sydney (asx_is_open — same gate as buys, holidays and
    early-close days included). Evaluates IMMEDIATELY on start: a stop
    breached overnight or while the watcher was off fires at the first poll.
    Exits itself once the market closes.
  * ONE batched quotes call per cycle for every watched ticker (SnapTrade's
    per-account limit is ~10/min; a 60-second cycle uses 1 = 6× headroom).
  * Trigger: last OR bid ≤ the ratcheted stop from the nightly pass's peaks
    file. Fire = SELL of the FULL position.
  * Default order: MARKET (the decade backtest fills at/near the stop; on
    illiquid pennies a limit can simply never fill while the price runs away —
    certainty of exit is the point of a stop). EXIT_FIRE_STYLE=limit switches
    to an aggressive limit at stop − 2 ASX ticks: price protection over
    certainty, tradeoff stated, not hidden.
  * Safety identical to buys: BRIDGE_MODE (DRY_RUN prints WOULD SELL, APPROVE
    prompts y/N, AUTO fires), the KILL file (checked EVERY cycle), the
    market-hours gate, and a per-position-per-day idempotency mark persisted
    to disk — a fired stop can never double-fire, including across restarts.
  * PEAKS STAY SINGLE-WRITER: the nightly pass owns ratcheting; the watcher
    only READS stops. No intraday ratcheting (close-basis decision stands
    until the w540 trail-basis study says otherwise).
  * Heartbeat every cycle so a dead session is visible. Honest residual risk:
    if the watcher isn't running, synthetic positions have NO intraday
    protection that day — the nightly pass still catches the breach on the
    close and exits like the server engine (next open).

Watchlist rule: every holding (qty > 0) with a stored stop in the peaks file
and NO live managed broker stop (a live broker_order_id means Regime A — the
broker's job, not ours; a recorded id that has VANISHED from the open orders
gets watched as a bonus safety net until the nightly pass re-places it).
Holdings + open orders refresh every WATCH_REFRESH_CYCLES cycles so intraday
fills/changes are picked up without extra per-cycle calls.

Env (all optional):
  WATCH_POLL_SECONDS     default 60
  WATCH_REFRESH_CYCLES   default 10   (re-read holdings/orders every N cycles)
  EXIT_FIRE_STYLE        default market   (market | limit)
"""
from __future__ import annotations
import os
import time as _time
from datetime import date, datetime

from .exits import load_peaks
from .safety import IdempotencyStore, Mode, asx_is_open, kill_engaged


# ---------------------------------------------------------------------------
def _env_f(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


def asx_tick(price: float) -> float:
    """ASX minimum tick: <$0.10 → 0.1c; $0.10–<$2.00 → 0.5c; ≥$2.00 → 1c
    (the app's v393 table)."""
    if price < 0.10:
        return 0.001
    if price < 2.00:
        return 0.005
    return 0.01


def limit_from_stop(stop: float) -> float:
    """Aggressive limit: stop − 2 ticks, FLOORED to the tick grid (an off-grid
    stop like 0.272 goes to 0.260, never up to 0.265) so the broker cannot
    reject an off-tick price and the limit is never less aggressive than
    intended."""
    import math
    t = asx_tick(stop)
    raw = stop - 2 * t
    return round(max(math.floor(raw / t + 1e-9) * t, t), 6)


# ---------------------------------------------------------------------------
def build_watchlist(peaks: dict, holdings_qty: dict, live_order_ids: set) -> list[dict]:
    """Pure. Which positions does the watcher own today?
    qty > 0 AND a stored stop AND no LIVE managed broker stop."""
    out = []
    for t, st in sorted((peaks or {}).items()):
        qty = int(holdings_qty.get(t) or 0)
        stop = (st or {}).get("stop")
        if qty <= 0 or stop is None:
            continue
        oid = str((st or {}).get("broker_order_id") or "")
        if oid and oid in live_order_ids:
            continue  # Regime A, broker-held and alive — not ours
        out.append({"ticker": t, "qty": qty, "stop": float(stop),
                    "note": ("broker stop vanished — covering until tonight's pass"
                             if oid else "")})
    return out


def check_triggers(watchlist: list[dict], quotes: dict) -> list[dict]:
    """Pure. Fire when last OR bid ≤ stop. No quote → skip (never guess)."""
    fired = []
    for w in watchlist:
        q = quotes.get(w["ticker"]) or {}
        last, bid = q.get("last"), q.get("bid")
        if last is None and bid is None:
            continue
        hit = (last is not None and last <= w["stop"]) or \
              (bid is not None and bid > 0 and bid <= w["stop"])
        if hit:
            fired.append(dict(w, last=last, bid=bid))
    return fired


def nearest_margin(watchlist: list[dict], quotes: dict):
    """Pure. (ticker, pct_above_stop) of the closest-to-firing position, for
    the heartbeat. None when nothing is quotable."""
    best = None
    for w in watchlist:
        q = quotes.get(w["ticker"]) or {}
        p = q.get("last") if q.get("last") is not None else q.get("bid")
        if p is None or p <= 0 or w["stop"] <= 0:
            continue
        m = (p - w["stop"]) / w["stop"] * 100.0
        if best is None or m < best[1]:
            best = (w["ticker"], m)
    return best


# ---------------------------------------------------------------------------
def run_watch_cycle(connector, acct: str, watchlist: list[dict], *, mode: Mode,
                    killed: bool, store: IdempotencyStore, today: str,
                    fire_style: str = "market",
                    ask=input, say=print):
    """One cycle: batch-quote, trigger-check, fire per BRIDGE_MODE. Pure
    orchestration over injected pieces — fully unit-testable. Returns
    (actions_this_cycle, quotes) — the ONE batched call's quotes come back so
    the heartbeat never needs a second request."""
    actions = []
    if not watchlist:
        return actions, {}
    try:
        quotes = connector.get_quotes(acct, [w["ticker"] for w in watchlist])
    except Exception as e:
        say(f"  quotes failed ({str(e)[:120]}) — holding fire, retrying next cycle")
        return actions, None

    for f in check_triggers(watchlist, quotes):
        t = f["ticker"]
        key = f"watchfire:{acct}:{t}:{today}"
        if store.seen(key):
            continue  # already fired today — a stop never double-fires
        px = f["last"] if f["last"] is not None else f["bid"]
        style = (fire_style or "market").lower()
        lim = limit_from_stop(f["stop"]) if style == "limit" else None
        line = (f"SELL {f['qty']:,} {t} — stop {f['stop']:g} breached "
                f"(last {f['last'] if f['last'] is not None else '-'}"
                f" / bid {f['bid'] if f['bid'] is not None else '-'})"
                + (f" @ limit {lim:g}" if lim is not None else " @ MARKET"))
        if killed:
            say(f"  [KILL    ] {line} — kill file engaged, NOT firing")
            actions.append({"ticker": t, "did": "kill"}); continue
        if mode == Mode.DRY_RUN:
            say(f"  [WOULD   ] {line}")
            store.mark(key)   # even a dry-run 'fire' is once per day — keeps logs sane
            actions.append({"ticker": t, "did": "would"}); continue
        go = mode == Mode.AUTO
        if mode == Mode.APPROVE:
            ans = ask(f"  [APPROVE?] {line} — fire this at the broker? y/N: ").strip().lower()
            go = ans in ("y", "yes")
        if not go:
            say(f"  [SKIPPED ] {line}")
            actions.append({"ticker": t, "did": "skipped"}); continue
        try:
            res = connector.place_sell(acct, t, f["qty"], lim)
            store.mark(key)
            say(f"  [FIRED   ] {line} — broker id {str((res or {}).get('id') or '?')}")
            actions.append({"ticker": t, "did": "fired", "price": px})
        except Exception as e:
            say(f"  [FAILED  ] {line} — broker error: {str(e)[:200]}")
            actions.append({"ticker": t, "did": "failed"})
    return actions, quotes


# ---------------------------------------------------------------------------
def _read_state(connector, acct, peaks_path):
    holdings = connector.get_holdings(acct)
    holdings_qty = {str(h.ticker).upper(): int(h.qty or 0) for h in holdings}
    try:
        live_ids = {str(o.get("id")) for o in connector.get_open_orders(acct)}
    except Exception:
        live_ids = set()
    return build_watchlist(load_peaks(peaks_path), holdings_qty, live_ids)


def cmd_watch(cfg, args, connector) -> int:
    """The daytime loop. Start it at 09:55 (Task Scheduler or by hand); it
    waits for the open, watches until the close, then exits itself."""
    acct = getattr(args, "account", None) or cfg.account_id
    if not acct:
        print("No account id. Set SNAPTRADE_ACCOUNT_ID or pass --account.")
        return 1
    poll = max(10, int(_env_f("WATCH_POLL_SECONDS", 60)))
    refresh_every = max(1, int(_env_f("WATCH_REFRESH_CYCLES", 10)))
    fire_style = (os.environ.get("EXIT_FIRE_STYLE", "market") or "market").lower()
    peaks_path = os.path.join(cfg.state_dir, f"peaks_{acct}.json")
    store = IdempotencyStore(os.path.join(cfg.state_dir, "watch_fired.json"))
    today = date.today().isoformat()

    print(f"WATCH — synthetic trailing-stop watcher · mode {cfg.mode.name} · account {acct}")
    print(f"  poll {poll}s · refresh holdings every {refresh_every} cycles · fire style {fire_style.upper()}"
          + (f" (limit = stop − 2 ticks)" if fire_style == "limit" else " (certainty of exit)"))
    print(f"  peaks (read-only): {peaks_path} — the nightly pass owns ratcheting")
    if cfg.mode == Mode.DRY_RUN:
        print("  DRY_RUN: breaches print WOULD SELL — nothing is ever sent.")

    if not asx_is_open():
        print("  ASX is closed — waiting for the open (Ctrl-C to stop)...")
        while not asx_is_open():
            if kill_engaged(cfg.kill_file):
                print("  KILL file engaged while waiting — exiting."); return 0
            _time.sleep(30)
        print("  Market open.")

    watchlist = _read_state(connector, acct, peaks_path)
    if not watchlist:
        print("  Nothing in Regime B today (no held position needs the watcher). Exiting.")
        return 0
    for w in watchlist:
        print(f"  watching {w['ticker']:<6} qty {w['qty']:,} · stop {w['stop']:g}"
              + (f"  ({w['note']})" if w['note'] else ""))

    cycle, quote_fails = 0, 0
    try:
        while asx_is_open():
            killed = kill_engaged(cfg.kill_file)
            acted, quotes = run_watch_cycle(connector, acct, watchlist, mode=cfg.mode,
                                            killed=killed, store=store, today=today,
                                            fire_style=fire_style)
            # heartbeat — a dead session must be VISIBLE (reuses the cycle's quotes)
            quote_fails = quote_fails + 1 if quotes is None else 0
            nm = nearest_margin(watchlist, quotes) if quotes else None
            hhmm = datetime.now().strftime("%H:%M:%S")
            bits = [f"{hhmm} watching {len(watchlist)}"]
            if killed:
                bits.append("KILL engaged — watching only")
            if nm:
                bits.append(f"nearest {nm[0]} {nm[1]:+.1f}% vs stop")
            if quote_fails >= 3:
                bits.append(f"!! {quote_fails} quote failures in a row")
            print("  · ".join(bits))

            fired = {a["ticker"] for a in acted if a.get("did") == "fired"}
            if fired:
                watchlist = [w for w in watchlist if w["ticker"] not in fired]
                if not watchlist:
                    print("  Every watched stop has fired — nothing left to guard. Exiting.")
                    return 0
            cycle += 1
            if cycle % refresh_every == 0:
                watchlist = _read_state(connector, acct, peaks_path)
                if not watchlist:
                    print("  Refresh: no synthetic positions remain. Exiting.")
                    return 0
            _time.sleep(poll)
    except KeyboardInterrupt:
        print("\n  Stopped by hand. REMEMBER: until restarted, synthetic positions "
              "have no intraday protection — tonight's pass still catches breaches on the close.")
        return 0
    print("  Market closed — watcher done for the day. Tonight's pass ratchets the stops.")
    return 0
