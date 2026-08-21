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
