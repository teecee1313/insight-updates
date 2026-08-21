"""
probe_stops.py - ten-minute foundation check for the bridge's exit phase.

QUESTION IT ANSWERS: will SnapTrade accept a Stop (stop-loss) sell order at
Stake AUS? Everything about the exit engine's architecture hangs on this.

WHAT IT DOES:            reads accounts, reads positions, then calls SnapTrade's
                         ORDER IMPACT (validation) endpoint with a Stop sell.
WHAT IT NEVER DOES:      place, modify, or cancel any order. The impact endpoint
                         validates and quotes a trade - it does not execute.
                         This script contains no call to any placing endpoint.

RUN (from the bridge folder, same place holdings works):
    python probe_stops.py
    python probe_stops.py <account-id>     <- probe a different account (use one
                                              that HOLDS shares for the clearest
                                              answer, e.g. Lourdes's AU account)

Paste the whole output back to Claude.
"""
import os, sys, json

# ---- read .env the same way the bridge does (no extra dependencies) --------
def read_env(path=".env"):
    out = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return out

ENV = read_env()
def need(k):
    # this bridge's .env prefixes SnapTrade keys - accept both spellings
    v = ENV.get("SNAPTRADE_" + k) or ENV.get(k) or os.environ.get("SNAPTRADE_" + k) or os.environ.get(k)
    if not v:
        print(f"MISSING {k} (or SNAPTRADE_{k}) in .env - run this from the bridge folder.")
        sys.exit(1)
    return v

CLIENT_ID   = need("CLIENT_ID")
CONSUMER_KEY= need("CONSUMER_KEY")
USER_ID     = need("USER_ID")
USER_SECRET = need("USER_SECRET")
ACCOUNT_ID  = (sys.argv[1] if len(sys.argv) > 1 else ENV.get("SNAPTRADE_ACCOUNT_ID") or "").strip()
if not ACCOUNT_ID:
    print("No account id: set SNAPTRADE_ACCOUNT_ID in .env or pass one as an argument.")
    sys.exit(1)

from snaptrade_client import SnapTrade  # pinned v11.0.213 per Phase 0
st = SnapTrade(client_id=CLIENT_ID, consumer_key=CONSUMER_KEY)

def body(resp):
    for attr in ("body", "parsed", "data"):
        b = getattr(resp, attr, None)
        if b is not None:
            return b
    return resp

print(f"Probing account {ACCOUNT_ID}")

# ---- 1. positions: find something the account holds ------------------------
pos = body(st.account_information.get_user_account_positions(
    account_id=ACCOUNT_ID, user_id=USER_ID, user_secret=USER_SECRET))
pos = list(pos or [])
print(f"Positions found: {len(pos)}")

sym_id, ticker, units, last_px = None, None, 0, None
for p in pos:
    s = p.get("symbol") or {}
    inner = s.get("symbol") if isinstance(s.get("symbol"), dict) else s
    if isinstance(inner, dict) and inner.get("id"):
        sym_id  = inner.get("id")
        ticker  = inner.get("raw_symbol") or inner.get("symbol") or "?"
        units   = float(p.get("units") or p.get("fractional_units") or 0)
        last_px = p.get("price")
        break

if not sym_id:
    print("")
    print("This account holds nothing, so a SELL cannot be validated against it.")
    print("Re-run against an account that holds shares, e.g.:")
    print("    python probe_stops.py 6e4fd408-da12-4bce-9652-3d30f59e419f")
    sys.exit(0)

print(f"Using holding: {ticker}  units={units}  last_price={last_px}")

# ---- 2. impact-check a Stop sell (validation only - nothing places) --------
try:
    stop_px = round(float(last_px) * 0.80, 2) if last_px else 0.10
except (TypeError, ValueError):
    stop_px = 0.10
if stop_px <= 0:
    stop_px = 0.01

print(f"Validating: SELL 1 {ticker} as a STOP order, stop={stop_px} (impact check only)")
try:
    resp = st.trading.get_order_impact(
        user_id=USER_ID, user_secret=USER_SECRET,
        account_id=ACCOUNT_ID,
        action="SELL",
        order_type="Stop",
        time_in_force="Day",
        units=1.0,  # SDK v11 requires Decimal, not int
        universal_symbol_id=sym_id,
        stop=stop_px,
    )
    b = body(resp)
    print("")
    print("RESULT: ACCEPTED - SnapTrade validated a Stop sell at this brokerage.")
    print("(Nothing was placed; impact quotes expire on their own.)")
    try:
        print(json.dumps(b, indent=2, default=str)[:1200])
    except Exception:
        print(str(b)[:1200])
except Exception as e:
    print("")
    print("RESULT: REJECTED at validation - the error below says why:")
    print(str(e)[:1500])
    print("")
    print("How to read it: 'order type'/'not supported' wording means Stake/SnapTrade")
    print("will not take resting Stop orders (exit engine goes fully synthetic);")
    print("'insufficient'/'units' wording means the TYPE passed and only the")
    print("account's contents blocked it - re-run against an account with shares.")
