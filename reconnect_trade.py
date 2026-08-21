"""Upgrade the EXISTING Stake connection to trade permission via SnapTrade's
reconnect flow (a fresh connect errors when a connection already exists).
Run from the bridge folder:  python reconnect_trade.py
Prints a portal link targeting your existing connection. Read-only script -
it only lists connections and generates a link."""
import os, sys

def read_env(path=".env"):
    out = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k.strip()] = v.split(" #", 1)[0].strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return out

ENV = read_env()
def need(k):
    v = ENV.get("SNAPTRADE_" + k) or ENV.get(k) or os.environ.get("SNAPTRADE_" + k) or os.environ.get(k)
    if not v:
        print(f"MISSING {k} in .env - run from the bridge folder."); sys.exit(1)
    return v

from snaptrade_client import SnapTrade
st = SnapTrade(client_id=need("CLIENT_ID"), consumer_key=need("CONSUMER_KEY"))
uid, usec = need("USER_ID"), need("USER_SECRET")

def body(resp):
    for a in ("body", "parsed", "data"):
        b = getattr(resp, a, None)
        if b is not None:
            return b
    return resp

auths = list(body(st.connections.list_brokerage_authorizations(user_id=uid, user_secret=usec)) or [])
if not auths:
    print("No existing connections found - a plain `connect` should work; if it errors, screenshot to Claude.")
    sys.exit(0)

print("Existing connections:")
target = None
for a in auths:
    bname = ((a.get("brokerage") or {}).get("name")) or "?"
    aid = a.get("id")
    dis = a.get("disabled")
    print(f"  id={aid}  {bname}  disabled={dis}")
    if target is None and "stake" in str(bname).lower():
        target = aid
if target is None:
    target = auths[0].get("id")
print(f"\nReconnecting authorization: {target} (requesting TRADE)")
resp = st.authentication.login_snap_trade_user(
    user_id=uid, user_secret=usec,
    connection_type="trade",
    reconnect=str(target),
)
b = body(resp)
url = b.get("redirectURI") or b.get("redirect_uri") or str(b)
print("\nOpen this link NOW (it expires in minutes), log into Stake, approve trading:\n")
print("  " + url)
