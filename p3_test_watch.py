"""The watcher tested to death — same philosophy as the safety engine: every
risky behaviour is pure logic first, proven here before a live quote exists."""
import os
import tempfile
import unittest

from bridge.safety import IdempotencyStore, Mode
from bridge.watch import (asx_tick, build_watchlist, check_triggers,
                          limit_from_stop, nearest_margin, run_watch_cycle)


class Conn:
    """Minimal injected connector for cycle tests."""
    def __init__(self, quotes, fail_quotes=False, fail_place=False):
        self.quotes, self.fail_quotes, self.fail_place = quotes, fail_quotes, fail_place
        self.fired = []

    def get_quotes(self, acct, tickers):
        if self.fail_quotes:
            raise RuntimeError("quote endpoint down")
        return {t: self.quotes[t] for t in tickers if t in self.quotes}

    def place_sell(self, acct, ticker, qty, limit=None):
        if self.fail_place:
            raise RuntimeError("broker rejected")
        o = {"id": f"b-{len(self.fired)+1}", "ticker": ticker, "qty": qty, "limit": limit}
        self.fired.append(o)
        return o


def store():
    d = tempfile.mkdtemp()
    return IdempotencyStore(os.path.join(d, "watch_fired.json")), d


WL = [{"ticker": "GML", "qty": 1000, "stop": 0.272, "note": ""}]


class TickMaths(unittest.TestCase):
    def test_bands(self):
        self.assertEqual(asx_tick(0.05), 0.001)
        self.assertEqual(asx_tick(0.099), 0.001)
        self.assertEqual(asx_tick(0.10), 0.005)
        self.assertEqual(asx_tick(1.995), 0.005)
        self.assertEqual(asx_tick(2.00), 0.01)
        self.assertEqual(asx_tick(45.20), 0.01)

    def test_limit_two_ticks_under_snapped(self):
        self.assertAlmostEqual(limit_from_stop(0.272), 0.26)     # 0.5c band, off-grid stop floors
        self.assertAlmostEqual(limit_from_stop(0.085), 0.083)    # 0.1c band
        self.assertAlmostEqual(limit_from_stop(2.50), 2.48)      # 1c band

    def test_on_grid_stop_exact_two_ticks(self):
        self.assertAlmostEqual(limit_from_stop(0.270), 0.26)
        self.assertAlmostEqual(limit_from_stop(0.100), 0.09)

    def test_limit_never_zero_or_negative(self):
        self.assertGreater(limit_from_stop(0.001), 0)
        self.assertGreater(limit_from_stop(0.002), 0)


class Watchlist(unittest.TestCase):
    def test_needs_qty_and_stop(self):
        peaks = {"GML": {"stop": 0.272}, "BHP": {"stop": 36.0}, "XRO": {"peak": 9.0}}
        wl = build_watchlist(peaks, {"GML": 1000, "XRO": 5}, set())
        self.assertEqual([w["ticker"] for w in wl], ["GML"])  # BHP not held, XRO no stop

    def test_live_broker_stop_excluded(self):
        peaks = {"GML": {"stop": 0.272, "broker_order_id": "ord-9"}}
        self.assertEqual(build_watchlist(peaks, {"GML": 1000}, {"ord-9"}), [])

    def test_vanished_broker_stop_covered_as_bonus(self):
        peaks = {"GML": {"stop": 0.272, "broker_order_id": "ord-9"}}
        wl = build_watchlist(peaks, {"GML": 1000}, set())
        self.assertEqual(len(wl), 1)
        self.assertIn("vanished", wl[0]["note"])


class Triggers(unittest.TestCase):
    def test_last_at_or_below_fires(self):
        self.assertTrue(check_triggers(WL, {"GML": {"last": 0.272, "bid": 0.30}}))
        self.assertTrue(check_triggers(WL, {"GML": {"last": 0.27, "bid": None}}))

    def test_bid_alone_fires(self):
        self.assertTrue(check_triggers(WL, {"GML": {"last": 0.30, "bid": 0.27}}))

    def test_above_stop_holds(self):
        self.assertEqual(check_triggers(WL, {"GML": {"last": 0.28, "bid": 0.275}}), [])

    def test_no_quote_never_guesses(self):
        self.assertEqual(check_triggers(WL, {}), [])
        self.assertEqual(check_triggers(WL, {"GML": {"last": None, "bid": None}}), [])

    def test_zero_bid_ignored(self):
        # an empty book prints bid 0 — that is NOT a breach
        self.assertEqual(check_triggers(WL, {"GML": {"last": 0.30, "bid": 0.0}}), [])

    def test_nearest_margin(self):
        wl = WL + [{"ticker": "AAA", "qty": 10, "stop": 1.00, "note": ""}]
        nm = nearest_margin(wl, {"GML": {"last": 0.30}, "AAA": {"last": 1.01}})
        self.assertEqual(nm[0], "AAA")
        self.assertAlmostEqual(nm[1], 1.0, places=5)


class Cycle(unittest.TestCase):
    def test_dry_run_places_nothing_and_marks(self):
        st, _ = store()
        c = Conn({"GML": {"last": 0.27, "bid": None}})
        acted, quotes = run_watch_cycle(c, "A1", WL, mode=Mode.DRY_RUN, killed=False,
                                        store=st, today="2026-08-24", say=lambda *a: None)
        self.assertEqual([a["did"] for a in acted], ["would"])
        self.assertEqual(c.fired, [])
        self.assertTrue(st.seen("watchfire:A1:GML:2026-08-24"))
        self.assertIn("GML", quotes)

    def test_auto_fires_market_full_position(self):
        st, _ = store()
        c = Conn({"GML": {"last": 0.27, "bid": None}})
        acted, _ = run_watch_cycle(c, "A1", WL, mode=Mode.AUTO, killed=False,
                                   store=st, today="2026-08-24", say=lambda *a: None)
        self.assertEqual([a["did"] for a in acted], ["fired"])
        self.assertEqual(c.fired[0]["qty"], 1000)
        self.assertIsNone(c.fired[0]["limit"])  # MARKET default

    def test_limit_style_fires_two_ticks_under(self):
        st, _ = store()
        c = Conn({"GML": {"last": 0.27, "bid": None}})
        run_watch_cycle(c, "A1", WL, mode=Mode.AUTO, killed=False, store=st,
                        today="2026-08-24", fire_style="limit", say=lambda *a: None)
        self.assertAlmostEqual(c.fired[0]["limit"], 0.26)

    def test_never_double_fires_even_across_restart(self):
        st, d = store()
        c = Conn({"GML": {"last": 0.27, "bid": None}})
        run_watch_cycle(c, "A1", WL, mode=Mode.AUTO, killed=False, store=st,
                        today="2026-08-24", say=lambda *a: None)
        st2 = IdempotencyStore(st.path)          # a fresh process, same disk
        acted, _ = run_watch_cycle(c, "A1", WL, mode=Mode.AUTO, killed=False,
                                   store=st2, today="2026-08-24", say=lambda *a: None)
        self.assertEqual(acted, [])
        self.assertEqual(len(c.fired), 1)

    def test_next_day_may_fire_again(self):
        st, _ = store()
        c = Conn({"GML": {"last": 0.27, "bid": None}})
        run_watch_cycle(c, "A1", WL, mode=Mode.AUTO, killed=False, store=st,
                        today="2026-08-24", say=lambda *a: None)
        acted, _ = run_watch_cycle(c, "A1", WL, mode=Mode.AUTO, killed=False,
                                   store=st, today="2026-08-25", say=lambda *a: None)
        self.assertEqual([a["did"] for a in acted], ["fired"])

    def test_kill_wins_and_does_not_mark(self):
        st, _ = store()
        c = Conn({"GML": {"last": 0.27, "bid": None}})
        acted, _ = run_watch_cycle(c, "A1", WL, mode=Mode.AUTO, killed=True,
                                   store=st, today="2026-08-24", say=lambda *a: None)
        self.assertEqual([a["did"] for a in acted], ["kill"])
        self.assertEqual(c.fired, [])
        # kill lifted next cycle → the breach may STILL fire (was never marked)
        acted, _ = run_watch_cycle(c, "A1", WL, mode=Mode.AUTO, killed=False,
                                   store=st, today="2026-08-24", say=lambda *a: None)
        self.assertEqual([a["did"] for a in acted], ["fired"])

    def test_approve_no_skips_yes_fires(self):
        st, _ = store()
        c = Conn({"GML": {"last": 0.27, "bid": None}})
        acted, _ = run_watch_cycle(c, "A1", WL, mode=Mode.APPROVE, killed=False,
                                   store=st, today="2026-08-24",
                                   ask=lambda p: "n", say=lambda *a: None)
        self.assertEqual([a["did"] for a in acted], ["skipped"])
        acted, _ = run_watch_cycle(c, "A1", WL, mode=Mode.APPROVE, killed=False,
                                   store=st, today="2026-08-24",
                                   ask=lambda p: "y", say=lambda *a: None)
        self.assertEqual([a["did"] for a in acted], ["fired"])

    def test_quote_outage_holds_fire(self):
        st, _ = store()
        c = Conn({}, fail_quotes=True)
        acted, quotes = run_watch_cycle(c, "A1", WL, mode=Mode.AUTO, killed=False,
                                        store=st, today="2026-08-24", say=lambda *a: None)
        self.assertEqual(acted, [])
        self.assertIsNone(quotes)   # loop counts this toward the outage warning

    def test_broker_failure_does_not_mark(self):
        st, _ = store()
        c = Conn({"GML": {"last": 0.27, "bid": None}}, fail_place=True)
        acted, _ = run_watch_cycle(c, "A1", WL, mode=Mode.AUTO, killed=False,
                                   store=st, today="2026-08-24", say=lambda *a: None)
        self.assertEqual([a["did"] for a in acted], ["failed"])
        self.assertFalse(st.seen("watchfire:A1:GML:2026-08-24"))  # retried next cycle


if __name__ == "__main__":
    unittest.main()
