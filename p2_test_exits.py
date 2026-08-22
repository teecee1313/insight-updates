"""The exit engine's bench: the pure pass, the ratchet-protection rule,
regimes, overrides. No network, no broker."""
import unittest
from bridge.exits import run_exit_pass


class H:
    def __init__(self, ticker, qty, price):
        self.ticker, self.qty, self.price = ticker, qty, price
        self.value = (price or 0) * qty


def run(holds, peaks=None, closes=None, trail=20.0, mind=0.05, ov=None, day="2026-08-21"):
    return run_exit_pass(holds, 0.0, peaks or {}, closes or {}, trail, mind, ov or {}, day)


class TestExitPass(unittest.TestCase):
    def test_first_pass_places(self):
        peaks, plan = run([H("ABC", 1000, 1.00)], closes={"ABC": 1.00})
        r = plan[0]
        self.assertEqual(r["action"], "PLACE")
        self.assertAlmostEqual(r["stop"], 0.80)
        self.assertAlmostEqual(peaks["ABC"]["peak"], 1.00)

    def test_ratchet_moves_up_with_new_peak(self):
        peaks, _ = run([H("ABC", 1000, 1.00)], closes={"ABC": 1.00})
        peaks2, plan = run([H("ABC", 1000, 1.20)], peaks=peaks, closes={"ABC": 1.20})
        r = plan[0]
        self.assertEqual(r["action"], "REPLACE")
        self.assertAlmostEqual(r["stop"], 0.96)

    def test_ratchet_never_retreats_on_price_fall(self):
        peaks, _ = run([H("ABC", 1000, 1.20)], closes={"ABC": 1.20})
        _, plan = run([H("ABC", 1000, 1.00)], peaks=peaks, closes={"ABC": 1.00})
        r = plan[0]
        self.assertEqual(r["action"], "HOLD")
        self.assertAlmostEqual(r["stop"], 0.96)   # peak stays 1.20

    def test_settings_widening_never_lowers_existing_stop(self):
        peaks, _ = run([H("ABC", 1000, 1.00)], trail=15.0, closes={"ABC": 1.00})  # stop .85
        _, plan = run([H("ABC", 1000, 1.00)], peaks=peaks, trail=20.0, closes={"ABC": 1.00})  # would be .80
        r = plan[0]
        self.assertEqual(r["action"], "HOLD")
        self.assertAlmostEqual(r["stop"], 0.85)
        self.assertIn("never lowers", r["note"])

    def test_settings_tightening_raises_stop(self):
        peaks, _ = run([H("ABC", 1000, 1.00)], trail=20.0, closes={"ABC": 1.00})  # stop .80
        _, plan = run([H("ABC", 1000, 1.00)], peaks=peaks, trail=15.0, closes={"ABC": 1.00})
        r = plan[0]
        self.assertEqual(r["action"], "REPLACE")
        self.assertAlmostEqual(r["stop"], 0.85)

    def test_override_may_lower_and_is_loud(self):
        peaks, _ = run([H("ABC", 1000, 1.00)], closes={"ABC": 1.00})  # stop .80
        _, plan = run([H("ABC", 1000, 1.00)], peaks=peaks, closes={"ABC": 1.00},
                      ov={"ABC": {"stop": 0.70}})
        r = plan[0]
        self.assertEqual(r["action"], "LOWERED")
        self.assertAlmostEqual(r["stop"], 0.70)
        self.assertIn("OVERRIDE", r["note"])

    def test_override_trail_pct(self):
        _, plan = run([H("ABC", 1000, 1.00)], closes={"ABC": 1.00},
                      ov={"ABC": {"trail_pct": 10.0}})
        self.assertAlmostEqual(plan[0]["stop"], 0.90)

    def test_regimes_split_on_min_distance(self):
        # $1.00 at 20% -> distance .20 > .05 -> broker-held
        _, plan_a = run([H("BIG", 100, 1.00)], closes={"BIG": 1.00})
        self.assertTrue(plan_a[0]["regime"].startswith("A"))
        # $0.20 at 20% -> distance .04 <= .05 -> synthetic
        _, plan_b = run([H("PEN", 100, 0.20)], closes={"PEN": 0.20})
        self.assertTrue(plan_b[0]["regime"].startswith("B"))

    def test_missing_price_skips(self):
        _, plan = run([H("GON", 100, None)], closes={})
        self.assertEqual(plan[0]["action"], "SKIP")

    def test_pantry_close_preferred_over_position_price(self):
        _, plan = run([H("ABC", 100, 0.90)], closes={"ABC": 1.00})
        self.assertAlmostEqual(plan[0]["peak"], 1.00)

    def test_zero_qty_ignored(self):
        _, plan = run([H("ABC", 0, 1.00)])
        self.assertEqual(plan, [])


if __name__ == "__main__":
    unittest.main()


from bridge.exits import plan_stop_orders


def rowsA(action, stop, t="ABC", regime="A broker-held"):
    return [dict(ticker=t, close=1.0, peak=1.0, stop=stop, prev_stop=None,
                 trail_pct=20.0, regime=regime, action=action, note="")]


class TestStopOrderPlanner(unittest.TestCase):
    def test_place_new(self):
        steps, notes = plan_stop_orders(rowsA("PLACE", 0.80), {}, [], {"ABC": 1000})
        self.assertEqual(steps, [{"op": "place", "ticker": "ABC", "qty": 1000, "stop": 0.80}])

    def test_replace_cancels_then_places(self):
        peaks = {"ABC": {"broker_order_id": "b1"}}
        open_orders = [{"id": "b1", "ticker": "ABC", "action": "SELL", "order_type": "Stop", "stop": 0.7, "qty": 1000}]
        steps, _ = plan_stop_orders(rowsA("REPLACE", 0.80), peaks, open_orders, {"ABC": 1000})
        self.assertEqual([s["op"] for s in steps], ["cancel", "place"])
        self.assertEqual(steps[0]["order_id"], "b1")
        self.assertAlmostEqual(steps[1]["stop"], 0.80)

    def test_hold_with_live_order_no_steps(self):
        peaks = {"ABC": {"broker_order_id": "b1"}}
        open_orders = [{"id": "b1", "ticker": "ABC", "action": "SELL", "order_type": "Stop", "stop": 0.8, "qty": 1000}]
        steps, _ = plan_stop_orders(rowsA("HOLD", 0.80), peaks, open_orders, {"ABC": 1000})
        self.assertEqual(steps, [])

    def test_vanished_managed_order_replaces(self):
        peaks = {"ABC": {"broker_order_id": "gone"}}
        steps, notes = plan_stop_orders(rowsA("HOLD", 0.80), peaks, [], {"ABC": 1000})
        self.assertEqual([s["op"] for s in steps], ["place"])
        self.assertTrue(any("no longer at the broker" in n for n in notes))

    def test_unmanaged_stop_never_touched(self):
        open_orders = [{"id": "tony1", "ticker": "ABC", "action": "SELL", "order_type": "Stop", "stop": 0.5, "qty": 500}]
        steps, notes = plan_stop_orders(rowsA("PLACE", 0.80), {}, open_orders, {"ABC": 1000})
        self.assertEqual(steps, [])
        self.assertTrue(any("unmanaged" in n for n in notes))

    def test_regime_b_skipped_with_note(self):
        steps, notes = plan_stop_orders(rowsA("PLACE", 0.04, regime="B synthetic"), {}, [], {"ABC": 1000})
        self.assertEqual(steps, [])
        self.assertTrue(any("watcher" in n for n in notes))


class TestExecutorEndToEnd(unittest.TestCase):
    """DRY_RUN touches nothing; AUTO converges the mock order book."""
    def _cfg(self, tmp, mode):
        from bridge.safety import Mode
        class C: pass
        c = C(); c.account_id = "mock-acct-1"; c.state_dir = tmp
        c.kill_file = tmp + "/KILL"; c.queue_url = ""; c.mode = Mode[mode]
        return c

    def _args(self):
        class A: pass
        a = A(); a.account = None; a.connector = "mock"; return a

    def test_dry_run_places_nothing(self):
        import tempfile
        from bridge.connectors.mock import MockConnector
        MockConnector._orders = {}
        from bridge.exits import cmd_exits_run
        with tempfile.TemporaryDirectory() as tmp:
            rc = cmd_exits_run(self._cfg(tmp, "DRY_RUN"), self._args(), MockConnector())
        self.assertEqual(rc, 0)
        self.assertEqual(MockConnector._orders, {})

    def test_auto_places_then_converges(self):
        import tempfile
        from bridge.connectors.mock import MockConnector
        from bridge.exits import cmd_exits_run
        MockConnector._orders = {}
        conn = MockConnector()
        with tempfile.TemporaryDirectory() as tmp:
            cfg = self._cfg(tmp, "AUTO")
            rc = cmd_exits_run(cfg, self._args(), conn)
            self.assertEqual(rc, 0)
            placed = conn.get_open_orders("mock-acct-1")
            # only BHP is regime A in the mock book (GML is 5c -> synthetic)
            self.assertEqual(len(placed), 1)
            self.assertEqual(placed[0]["ticker"], "BHP")
            self.assertAlmostEqual(placed[0]["stop"], 36.16)
            # second run: nothing to do
            rc2 = cmd_exits_run(cfg, self._args(), conn)
            self.assertEqual(rc2, 0)
            self.assertEqual(len(conn.get_open_orders("mock-acct-1")), 1)
