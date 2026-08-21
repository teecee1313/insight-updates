"""Wires the `exits` command into the bridge CLI. Run from the bridge folder
AFTER curling exits.py into bridge\\ and test_exits.py into tests\\ :
    python patch_exits.py
Edits bridge/bridge.py in place (backup first). Idempotent."""
import shutil, sys
P = "bridge/bridge.py"
try:
    src = open(P, encoding="utf-8").read()
except FileNotFoundError:
    print("Run this from the bridge folder."); sys.exit(1)
if "cmd_exits_cli" in src:
    print("Already wired - nothing to do."); sys.exit(0)
edits = [
 ('def cmd_plan(cfg, args):',
  'def cmd_exits_cli(cfg, args):\n'
  '    """The exit engine\'s nightly ratchet pass (dry-run: plans, places nothing)."""\n'
  '    from .exits import cmd_exits\n'
  '    return cmd_exits(cfg, args, _conn(cfg, args.connector))\n\n\n'
  'def cmd_plan(cfg, args):'),
 ('for name in ("register", "connect", "accounts", "holdings", "plan", "run"):',
  'for name in ("register", "connect", "accounts", "holdings", "plan", "run", "exits"):'),
 ('fn = {"register": cmd_register, "connect": cmd_connect, "accounts": cmd_accounts,\n'
  '          "holdings": cmd_holdings, "plan": cmd_plan, "run": cmd_run}[args.cmd]',
  'fn = {"register": cmd_register, "connect": cmd_connect, "accounts": cmd_accounts,\n'
  '          "holdings": cmd_holdings, "plan": cmd_plan, "run": cmd_run, "exits": cmd_exits_cli}[args.cmd]'),
]
for old, new in edits:
    if src.count(old) != 1:
        print("Anchor not found - your bridge.py differs from expected.")
        print("Do NOT edit by hand; screenshot this to Claude:")
        print(repr(old[:80])); sys.exit(1)
for old, new in edits:
    src = src.replace(old, new, 1)
shutil.copyfile(P, P + ".bak-preexits")
open(P, "w", encoding="utf-8").write(src)
print("WIRED. Backup: bridge.py.bak-preexits")
print("Test with:  python -m bridge.bridge exits --connector mock --account mock-acct-1")
