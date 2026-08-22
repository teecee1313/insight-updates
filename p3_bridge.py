"""
The bridge CLI. Phase 0 is read-only + dry-run planning. It cannot place a real
order: `place_order` is only ever reached in APPROVE/AUTO mode, and Phase 0 ships
in DRY_RUN.

Commands:
  register     one-time: create your SnapTrade user (prints the userSecret to save)
  connect      print the secure Connection Portal URL to link your Stake account
  accounts     list your connected accounts (find your account id)
  holdings     read your real holdings + cash          [READ-ONLY]
  plan         pull the day's orders (server queue → orders.json fallback), run
               them through the safety engine, print exactly what it WOULD place
               and what it blocked  [DRY-RUN — places nothing]
  run          the Phase-2 engine, shipped INERT: in DRY_RUN mode (the default)
               it IS `plan`. Only after you deliberately set BRIDGE_MODE=APPROVE
               does it ask, per order, before placing anything real.

Run offline with no keys:   python -m bridge.bridge holdings --connector mock
"""
from __future__ import annotations
import argparse
import sys

from .config import Config
from .connectors import get_connector
from .orders import load_orders, get_orders, ack_queue
from .safety import (Mode, DayState, IdempotencyStore, evaluate, asx_is_open, kill_engaged)


def _conn(cfg, override=None):
    return get_connector(override or cfg.connector, cfg)


def cmd_register(cfg, args):
    if args.connector == "mock":
        print("mock connector — nothing to register."); return 0
    c = _conn(cfg, args.connector)
    uid = args.user_id or cfg.user_id or "insight-bridge-user"
    res = c.register_user(uid)
    print("Registered SnapTrade user. SAVE THESE (put into your .env):")
    print(f"  SNAPTRADE_USER_ID={res.get('userId', uid)}")
    print(f"  SNAPTRADE_USER_SECRET={res.get('userSecret','<secret>')}")
    return 0


def cmd_connect(cfg, args):
    c = _conn(cfg, args.connector)
    print("Open this link, log into Stake on SnapTrade's screen, and approve:\n")
    print("  " + c.connect_url())
    return 0


def cmd_accounts(cfg, args):
    c = _conn(cfg, args.connector)
    accts = c.list_accounts()
    if not accts:
        print("No connected accounts. Run `connect` first."); return 0
    print("Connected accounts:")
    for a in accts:
        print(f"  id={a.id}  {a.name}  {a.institution} {a.number}".rstrip())
    print("\nPut the right id into your .env as SNAPTRADE_ACCOUNT_ID.")
    return 0


def cmd_holdings(cfg, args):
    c = _conn(cfg, args.connector)
    acct = args.account or cfg.account_id
    if not acct:
        accts = c.list_accounts()
        acct = accts[0].id if accts else None
    if not acct:
        print("No account id. Run `accounts` first."); return 1
    holds = c.get_holdings(acct)
    cash = c.get_cash(acct)
    print(f"Account {acct} — READ ONLY\n")
    print(f"  {'TICKER':<8}{'QTY':>12}{'PRICE':>12}{'VALUE':>14}")
    tot = 0.0
    for h in holds:
        v = h.value or 0.0
        tot += v
        px = f"{h.price:.4f}" if h.price is not None else "-"
        print(f"  {h.ticker:<8}{h.qty:>12,.0f}{px:>12}{v:>14,.2f}")
    print(f"  {'CASH':<8}{'':>12}{'':>12}{cash:>14,.2f}")
    print(f"  {'TOTAL':<8}{'':>12}{'':>12}{tot+cash:>14,.2f}")
    return 0


def cmd_exits_cli(cfg, args):
    """The exit engine's nightly ratchet pass (dry-run: plans, places nothing)."""
    from .exits import cmd_exits
    return cmd_exits(cfg, args, _conn(cfg, args.connector))


def cmd_exits_run_cli(cfg, args):
    """Phase 2: converge broker stop orders with the ratchet, honouring BRIDGE_MODE."""
    from .exits import cmd_exits_run
    return cmd_exits_run(cfg, args, _conn(cfg, args.connector))


def cmd_watch_cli(cfg, args):
    from .watch import cmd_watch
    return cmd_watch(cfg, args, _conn(cfg, args.connector))


def cmd_plan(cfg, args):
    """Dry-run planning: run today's orders through the FULL safety engine and show
    the decisions. Places nothing (forces DRY_RUN regardless of configured mode)."""
    c = _conn(cfg, args.connector)
    acct = args.account or cfg.account_id or "mock-acct-1"
    orders, source = get_orders(cfg)
    print(f"Orders source: {source}")
    if not orders:
        print("Nothing to plan today — an honest empty day (no queued picks, no local orders)."); return 0

    idem = IdempotencyStore(f"{cfg.state_dir}/placed.json")
    killed = kill_engaged(cfg.kill_file)
    open_now = asx_is_open()
    # snapshot current exposure from real holdings (read-only)
    try:
        exposure = sum((h.value or 0.0) for h in c.get_holdings(acct))
    except Exception:
        exposure = 0.0
    state = DayState(placed_today=0, spent_today=0.0, current_exposure=exposure)

    print("PLAN — preview of the safety decisions. Dry-run: places NOTHING.")
    print(f"       ASX open right now: {open_now} (the live market gate applies only when actually placing)")
    print(f"       kill switch: {killed}\n")
    would, blocked = 0, 0
    for o in orders:
        # A preview evaluates the caps/whitelist/idempotency as if the market were open,
        # so you can review the plan any time of day. Nothing places in DRY_RUN regardless.
        d = evaluate(o, mode=Mode.DRY_RUN, caps=cfg.caps, state=state,
                     market_open=True, killed=killed, already_placed=idem.seen(o.id))
        tag = "WOULD PLACE" if d.allowed else "BLOCKED   "
        px = f"@ {o.limit:.4f}" if o.order_type == "LIMIT" else "@ market"
        print(f"  [{tag}] {o.action:<4} {o.qty:>6,} {o.ticker:<6} {px:<12} — {d.reason}")
        if d.allowed:
            would += 1
            if o.action == "BUY":
                state.spent_today += o.est_cost
                state.current_exposure += o.est_cost
            state.placed_today += 1
        else:
            blocked += 1
    print(f"\n  {would} would place · {blocked} blocked · 0 actually sent (dry-run).")
    return 0


def cmd_run(cfg, args):
    """The Phase-2 engine, shipped early but INERT: with BRIDGE_MODE=DRY_RUN
    (the default) this is exactly `plan` — a preview that places nothing.
    Only when Tony deliberately flips .env to APPROVE does it start asking,
    order by order, whether to actually place; AUTO places within caps without
    asking. Every placement is idempotency-marked and acked back to the queue."""
    mode = cfg.mode
    if mode == Mode.DRY_RUN:
        print("RUN (mode: DRY_RUN) — identical to `plan`; nothing can be placed until")
        print("you deliberately set BRIDGE_MODE=APPROVE in .env at go-live.\n")
        return cmd_plan(cfg, args)

    c = _conn(cfg, args.connector)
    acct = args.account or cfg.account_id
    if not acct:
        print("No account id set (SNAPTRADE_ACCOUNT_ID). Refusing to run in a placing mode."); return 1
    orders, source = get_orders(cfg)
    print(f"Orders source: {source}")
    if not orders:
        print("Nothing to do today."); return 0

    idem = IdempotencyStore(f"{cfg.state_dir}/placed.json")
    killed = kill_engaged(cfg.kill_file)
    open_now = asx_is_open()
    try:
        exposure = sum((h.value or 0.0) for h in c.get_holdings(acct))
    except Exception:
        exposure = 0.0
    state = DayState(placed_today=0, spent_today=0.0, current_exposure=exposure)

    print(f"RUN — mode {mode.name} · account {acct} · ASX open: {open_now} · kill: {killed}")
    print("Every order below still passes the full safety engine first.\n")
    placed_ids = []
    for o in orders:
        d = evaluate(o, mode=mode, caps=cfg.caps, state=state,
                     market_open=open_now, killed=killed, already_placed=idem.seen(o.id))
        px = f"@ {o.limit:.4f}" if o.order_type == "LIMIT" else "@ market"
        line = f"{o.action:<4} {o.qty:>6,} {o.ticker:<6} {px:<12} (~${o.est_cost:,.2f})"
        if not d.allowed:
            print(f"  [BLOCKED ] {line} — {d.reason}")
            continue
        go = d.place
        if d.needs_approval:
            ans = input(f"  [APPROVE?] {line} — place this REAL order? y/N: ").strip().lower()
            go = ans in ("y", "yes")
            if not go:
                print("             skipped by you."); continue
        if not go:
            print(f"  [HELD    ] {line} — {d.reason}")
            continue
        try:
            res = c.place_order(acct, o)
            idem.mark(o.id)
            placed_ids.append(o.id)
            if o.action == "BUY":
                state.spent_today += o.est_cost
                state.current_exposure += o.est_cost
            state.placed_today += 1
            print(f"  [PLACED  ] {line} — broker ref {str(res)[:60]}")
        except Exception as e:
            print(f"  [FAILED  ] {line} — broker error: {e}")
    if placed_ids:
        n, why = ack_queue(cfg, placed_ids)
        print(f"\n  {len(placed_ids)} placed · queue ack: {n} ({why})")
    else:
        print("\n  0 placed.")
    return 0


def build_parser():
    # shared flags via a parent parser so they work BEFORE or AFTER the subcommand
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--connector", choices=["snaptrade", "mock"], default=argparse.SUPPRESS, help="override connector")
    common.add_argument("--account", default=argparse.SUPPRESS, help="account id override")
    common.add_argument("--user-id", default=argparse.SUPPRESS, help="(register) SnapTrade user id")
    p = argparse.ArgumentParser(prog="insight-bridge", parents=[common],
                                description="Insight Trading → broker bridge (Phase 0: read-only + dry-run)")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("register", "connect", "accounts", "holdings", "plan", "run", "exits", "exits-run", "watch"):
        sub.add_parser(name, parents=[common])
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    for attr in ("connector", "account", "user_id"):   # SUPPRESS means absent when unset
        if not hasattr(args, attr):
            setattr(args, attr, None)
    cfg = Config.load()
    fn = {"register": cmd_register, "connect": cmd_connect, "accounts": cmd_accounts,
          "holdings": cmd_holdings, "plan": cmd_plan, "run": cmd_run, "exits": cmd_exits_cli,
          "exits-run": cmd_exits_run_cli, "watch": cmd_watch_cli}[args.cmd]
    return fn(cfg, args)


if __name__ == "__main__":
    sys.exit(main())
