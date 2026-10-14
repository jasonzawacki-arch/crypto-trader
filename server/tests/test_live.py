import time
import unittest

from gtrader.session import Session
from gtrader.types import OrderRequest


class FakeClient:
    """Stands in for GeminiReadOnly: static prices, hourly candles, switchable failure."""

    def __init__(self):
        self.fail = False
        self.px = {"BTC-USD": 60000.0, "ETH-USD": 3000.0, "SOL-USD": 150.0}

    def ticker(self, sym):
        if self.fail:
            raise RuntimeError("network down")
        p = self.px[sym]
        return {"bid": p * 0.9995, "ask": p * 1.0005, "last": p, "vol24": 2400.0}

    def candles(self, sym):
        now = int(time.time() * 1000) // 3600000 * 3600000
        p = self.px[sym]
        return [[now - (300 - i) * 3600000, p, p * 1.01, p * 0.99, p, 10.0] for i in range(300)]


class Clock:
    def __init__(self):
        self.t = time.time()

    def __call__(self):
        return self.t


def live_session(client=None):
    c = client or FakeClient()
    s = Session(feed_client=c, stale_after_s=30)
    clk = Clock()
    s.reset("live")
    s.feed.clock = clk
    s.feed.started = clk.t
    for k in s.feed.last_ok:
        s.feed.last_ok[k] = clk.t
    return s, c, clk


class Live(unittest.TestCase):
    def test_disabled_by_default(self):
        s = Session()
        with self.assertRaises(ValueError):
            s.reset("live")

    def test_live_prices_drive_the_paper_account(self):
        s, c, clk = live_session()
        self.assertEqual(s.mode, "live")
        self.assertAlmostEqual(s.ex.mark("BTC-USD"), 60000.0)
        c.px["BTC-USD"] = 61000.0
        s._live_poll()
        self.assertAlmostEqual(s.ex.mark("BTC-USD"), 61000.0)
        o = s.eng.place_manual(OrderRequest("BTC-USD", "buy", "market", 0.01))
        self.assertTrue(o[0])
        self.assertEqual(s.state()["feed"]["symbols"]["BTC-USD"]["last"], 61000.0)
        self.assertEqual(s.state()["exchange"]["live"], False)  # paper money only
        with self.assertRaises(ValueError):
            s.step_bar()

    def test_stale_data_pauses_buys_but_not_sells(self):
        s, c, clk = live_session()
        self.assertTrue(s.eng.place_manual(OrderRequest("BTC-USD", "buy", "market", 0.01))[0])
        clk.t += 31
        ok, why = s.eng.place_manual(OrderRequest("BTC-USD", "buy", "market", 0.01))
        self.assertFalse(ok)
        self.assertIn("stale", why)
        self.assertIn("stale", s.state()["feed"]["stale"])
        self.assertTrue(any(l["kind"] == "risk" and "stale" in l["text"] for l in s.eng.log))
        self.assertTrue(s.eng.place_manual(OrderRequest("BTC-USD", "sell", "market", 0.005))[0])  # exits always work
        s._live_poll()  # quotes resume
        self.assertIsNone(s.state()["feed"]["stale"])
        self.assertTrue(s.eng.place_manual(OrderRequest("BTC-USD", "buy", "market", 0.01))[0])
        self.assertTrue(any("flowing again" in l["text"] for l in s.eng.log))

    def test_feed_failures_are_counted_and_go_stale(self):
        s, c, clk = live_session()
        c.fail = True
        s._live_poll()
        self.assertGreaterEqual(s.feed.errors, 3)
        self.assertIn("network down", s.feed.last_error)
        clk.t += 40
        self.assertIsNotNone(s.feed.stale_reason())

    def test_calibration_compares_paper_fills_with_the_quote(self):
        s, c, clk = live_session()
        for _ in range(3):
            s.eng.place_manual(OrderRequest("BTC-USD", "buy", "market", 0.005))
        cal = s.calibration()
        self.assertEqual(cal["takerFills"], 3)
        self.assertAlmostEqual(cal["liveHalfSpreadBps"], 5.0, places=3)  # 0.05% each side
        self.assertGreater(cal["paperCostBps"], 0)
        self.assertTrue(any("Only 3" in n for n in cal["notes"]))
        self.assertIn("BTC-USD", cal["spreads"])

    def test_live_state_persists_but_needs_a_feed_to_resume(self):
        import tempfile
        from gtrader.store import Store
        path = tempfile.mktemp(suffix=".db")
        s = Session(store=Store(path), feed_client=FakeClient())
        s.reset("live")
        s.eng.place_manual(OrderRequest("BTC-USD", "buy", "market", 0.01))
        s.save(True)
        again = Session(store=Store(path), feed_client=FakeClient())
        self.assertEqual(again.mode, "live")
        self.assertEqual(len(again.ex.fills), 1)
        offline = Session(store=Store(path))  # no feed configured: falls back to a fresh replay
        self.assertEqual(offline.mode, "replay")

    def test_background_loop_polls_and_pauses(self):
        import asyncio

        async def go():
            s, c, clk = live_session()
            s.poll_s = 0.05
            c.px["ETH-USD"] = 3100.0
            s.play()
            await asyncio.sleep(0.4)
            mark = s.ex.mark("ETH-USD")
            s.pause()
            return mark, s.playing

        mark, playing = asyncio.run(go())
        self.assertAlmostEqual(mark, 3100.0)
        self.assertFalse(playing)


if __name__ == "__main__":
    unittest.main()
