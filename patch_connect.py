"""One-shot patcher: make the bridge's connect command request TRADE permission.
Run from the bridge folder:  python patch_connect.py
Edits bridge/connectors/snaptrade_conn.py in place (backs it up first).
"""
import shutil, sys
P = "bridge/connectors/snaptrade_conn.py"
try:
    src = open(P, encoding="utf-8").read()
except FileNotFoundError:
    print("Run this from the bridge folder (the one containing the 'bridge' subfolder).")
    sys.exit(1)
if 'connection_type="trade"' in src:
    print("Already patched - connect already requests trade permission. Nothing to do.")
    sys.exit(0)
anchor = """        resp = self.client().authentication.login_snap_trade_user(
            user_id=self.cfg.user_id, user_secret=self.cfg.user_secret,
        )"""
if src.count(anchor) != 1:
    print("Could not find the connect block where expected - do not edit by hand;")
    print("screenshot this message to Claude instead.")
    sys.exit(1)
new = """        resp = self.client().authentication.login_snap_trade_user(
            user_id=self.cfg.user_id, user_secret=self.cfg.user_secret,
            connection_type="trade",  # 21 Aug 2026: Phase 0 shipped read-only by design;
                                       # the exit phase needs trading. DRY_RUN/APPROVE
                                       # gates in the bridge remain the shield.
        )"""
shutil.copyfile(P, P + ".bak-preconnect")
open(P, "w", encoding="utf-8").write(src.replace(anchor, new, 1))
print("PATCHED. Backup saved as snaptrade_conn.py.bak-preconnect")
print("Now run:  python -m bridge.bridge connect")
