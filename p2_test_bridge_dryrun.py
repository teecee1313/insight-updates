"""End-to-end-ish test using the offline mock connector: prove Phase 0 reads and
that `plan` places nothing. No network, no keys."""
import io
import os
import sys
import json
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge.connectors import get_connector
from bridge import bridge as cli


class TestMockRead(unittest.TestCase):
    def test_mock_holdings_and_cash(self):
        c = get_connector("mock", None)
        holds = c.get_holdings("mock-acct-1")
        self.assertTrue(any(h.ticker == "GML" for h in holds))
        self.assertGreater(c.get_cash("mock-acct-1"), 0)

    def test_accounts_command_runs(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = cli.main(["--connector", "mock", "accounts"])
        self.assertEqual(rc, 0)
        self.assertIn("Stake", buf.getvalue())


class TestPlanPlacesNothing(unittest.TestCase):
    def test_plan_dry_run(self):
        # build a temp orders file with one within-cap and one over-cap order
        with tempfile.TemporaryDirectory() as td:
            orders = [
                {"id": "a1", "action": "BUY", "ticker": "GML", "qty": 1000, "order_type": "LIMIT", "limit": 0.05},
                {"id": "a2", "action": "BUY", "ticker": "BHP", "qty": 1000, "order_type": "LIMIT", "limit": 45.0},
            ]
            of = os.path.join(td, "orders.json")
            with open(of, "w") as fh:
                json.dump(orders, fh)
            os.environ["BRIDGE_ORDERS_FILE"] = of
            os.environ["BRIDGE_STATE_DIR"] = td
            os.environ["CAP_MAX_PER_ORDER"] = "500"   # GML $50 ok, BHP $45,000 blocked
            # 22 Aug: isolate from any live .env - on a machine with a real
            # BRIDGE_QUEUE_URL this test reached the actual server queue and
            # planned the (honestly empty) real day instead of these orders.
            os.environ["BRIDGE_QUEUE_URL"] = ""
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = cli.main(["--connector", "mock", "--account", "mock-acct-1", "plan"])
            out = buf.getvalue()
            self.assertEqual(rc, 0)
            self.assertIn("0 actually sent", out)          # never places
            self.assertIn("WOULD PLACE", out)               # the small one is allowed
            self.assertIn("BLOCKED", out)                   # the big one is blocked
            # cleanup env
            for k in ("BRIDGE_ORDERS_FILE", "BRIDGE_STATE_DIR", "CAP_MAX_PER_ORDER", "BRIDGE_QUEUE_URL"):
                os.environ.pop(k, None)


if __name__ == "__main__":
    unittest.main()
