import random
import unittest

from gtrader.engine import Engine
from gtrader.paper import PaperExchange
from gtrader.risk import RiskManager
from gtrader.session import RULES, Session
from gtrader.types import OrderRequest, Tick

BTC = RULES[0]


def mk(**cfg):
    ex = PaperExchange(cfg, [BTC])
    return ex, RiskManager({}, ex.cfg.starting_cash)


def tick(ex, price, t=0, vol=100.0):
    ex.on_tick(Tick("BTC-USD", t, price, vol))


class Paper(unittest.TestCase):
    def test_buy_sell_accounting(self):
        ex, _ = mk()
        tick(ex, 100)
        b = ex.place(OrderRequest("BTC-USD", "buy", "market", 10))
        self.assertEqual(b.status, "filled")
        self.assertLess(ex.cash, 10000 - 1000)  # paid spread + fee
        tick(ex, 110)
        s = ex.place(OrderRequest("BTC-USD", "sell", "market", 10))
        self.assertEqual(s.status, "filled")
        self.assertEqual(ex.positions, {})
        self.assertAlmostEqual(ex.equity(), ex.cash)
        self.assertAlmostEqual(ex.equity() - 10000, ex.realized, places=8)
        self.assertGreater(ex.fees_paid, 0)

    def test_rejects(self):
        ex, _ = mk()
        self.assertEqual(ex.place(OrderRequest("BTC-USD", "buy", "market", 1)).reason, "No market data yet")
        tick(ex, 100)
        self.assertEqual(ex.place(OrderRequest("BTC-USD", "buy", "market", 0)).status, "rejected")
        self.assertEqual(ex.place(OrderRequest("BTC-USD", "buy", "market", float("nan"))).status, "rejected")
        self.assertEqual(ex.place(OrderRequest("BTC-USD", "sell", "market", 1)).reason, "Not enough BTC to sell")
        self.assertEqual(ex.place(OrderRequest("BTC-USD", "buy", "market", 1000)).reason, "Not enough cash")
        self.assertEqual(ex.place(OrderRequest("XRP-USD", "buy", "market", 1)).reason, "Unknown symbol")
        self.assertEqual(ex.place(OrderRequest("BTC-USD", "buy", "limit", 1)).reason, "Enter a price")
        self.assertEqual(ex.place(OrderRequest("BTC-USD", "buy", "weird", 1)).status, "rejected")

    def test_limit_needs_trade_through(self):
        ex, _ = mk()
        tick(ex, 100)
        o = ex.place(OrderRequest("BTC-USD", "buy", "limit", 1, 95))
        self.assertEqual(o.status, "open")
        tick(ex, 95)  # touching is not enough
        self.assertEqual(o.status, "open")
        tick(ex, 94.9)
        self.assertEqual(o.status, "filled")
        self.assertEqual(o.fill_price, 95)
        self.assertTrue(ex.fills[-1].maker)

    def test_reservations(self):
        ex, _ = mk()
        tick(ex, 100)
        a = ex.place(OrderRequest("BTC-USD", "buy", "limit", 90, 99))
        self.assertEqual(a.status, "open")
        self.assertLess(ex.available_cash(), 1100)
        self.assertEqual(ex.place(OrderRequest("BTC-USD", "buy", "limit", 90, 99)).reason, "Not enough cash")
        ex.cancel(a.id)
        self.assertAlmostEqual(ex.available_cash(), 10000)

    def test_stop_sell(self):
        ex, _ = mk()
        tick(ex, 100)
        ex.place(OrderRequest("BTC-USD", "buy", "market", 10))
        st = ex.place(OrderRequest("BTC-USD", "sell", "stop", 10, 95))
        self.assertEqual(st.status, "open")
        tick(ex, 94)
        self.assertEqual(st.status, "filled")
        self.assertLess(ex.fills[-1].realized, 0)

    def test_price_impact_grows_with_size(self):
        ex, _ = mk()
        tick(ex, 100, vol=1000)
        small, big = ex.quote("BTC-USD", "buy", 1), ex.quote("BTC-USD", "buy", 40)
        self.assertLess(small, big)

    def test_invariant_under_random_orders(self):
        for seed in range(60):
            rnd = random.Random(seed)
            ex, _ = mk()
            px = 100.0
            for i in range(120):
                px *= 1 + rnd.gauss(0, 0.01)
                tick(ex, px, i * 1000, rnd.uniform(1, 50))
                r = rnd.random()
                side = rnd.choice(["buy", "sell"])
                typ = rnd.choice(["market", "limit", "stop"])
                price = px * rnd.uniform(0.9, 1.1) if typ != "market" else None
                ex.place(OrderRequest("BTC-USD", side, typ, rnd.uniform(0.1, 30), price))
                if r < 0.1 and ex.open_orders():
                    ex.cancel(rnd.choice(ex.open_orders()).id)
                self.assertGreaterEqual(ex.cash, -1e-6)
                self.assertGreaterEqual(ex.available_cash(), -1e-6)
            self.assertAlmostEqual(ex.equity() - 10000, ex.realized + ex.unrealized(), places=6)


class Risk(unittest.TestCase):
    def test_limits_and_sells_always_allowed(self):
        rk = RiskManager({}, 10000)
        ok, why = rk.check(OrderRequest("BTC-USD", "buy", "market", 30), 100, 10000, 0)
        self.assertFalse(ok)
        self.assertIn("limit is 25%", why)
        ok, why = rk.check(OrderRequest("BTC-USD", "buy", "market", 20), 100, 10000, 3000)
        self.assertFalse(ok)
        self.assertIn("Position would be", why)
        self.assertFalse(rk.check(OrderRequest("BTC-USD", "buy", "market", 0.01), 100, 10000, 0)[0])
        rk.kill()
        self.assertTrue(rk.check(OrderRequest("BTC-USD", "sell", "market", 999), 100, 10000, 0)[0])
        self.assertIn("Kill switch", rk.check(OrderRequest("BTC-USD", "buy", "market", 1), 100, 10000, 0)[1])

    def test_daily_loss_halt_lifts_next_day(self):
        rk = RiskManager({}, 10000)
        rk.update(0, 10000)
        rk.update(1000, 9600)
        self.assertIn("Daily loss", rk.blocked())
        rk.update(86400000 + 1, 9600)
        self.assertIsNone(rk.blocked())


class EngineAndSession(unittest.TestCase):
    def test_kill_switch_keeps_stops(self):
        ex, rk = mk()
        eng = Engine(ex, rk, 3600000)
        tick(ex, 100)
        eng.add_bot("buy-hold", "BTC-USD", enabled=True)
        ex.place(OrderRequest("BTC-USD", "buy", "limit", 1, 50))
        eng.kill(0)
        self.assertTrue(rk.s.killed)
        self.assertFalse(eng.bots[0].cfg.enabled)
        self.assertEqual(ex.open_orders(), [])

    def test_session_is_deterministic_and_resets(self):
        a, b = Session(), Session()
        for s in (a, b):
            s.set_speed(60)
            s.eng.add_bot("sma-cross", "BTC-USD", params={"fast": 5, "slow": 20}, enabled=True)
            for _ in range(400):
                s.frame()
        self.assertEqual(a.ex.fills.__len__(), b.ex.fills.__len__())
        self.assertAlmostEqual(a.ex.equity(), b.ex.equity(), places=9)
        a.reset()
        self.assertEqual(a.ex.fills, [])
        self.assertAlmostEqual(a.ex.equity(), 10000)

    def test_synthetic_mode_same_seed_same_market(self):
        a, b = Session(), Session()
        a.reset("synthetic", 7)
        b.reset("synthetic", 7)
        for s in (a, b):
            for _ in range(50):
                s.step_bar()
        self.assertEqual(a.ex.marks, b.ex.marks)


if __name__ == "__main__":
    unittest.main()


class Oco(unittest.TestCase):
    def setup(self):
        ex, rk = mk()
        eng = Engine(ex, rk, 3600000)
        tick(ex, 100)
        return ex, eng

    def test_bracket_places_pair_sharing_one_reservation(self):
        ex, eng = self.setup()
        ok, o = eng.place_manual(OrderRequest("BTC-USD", "buy", "market", 10, bracket={"stop_pct": 5, "tp_pct": 10}))
        self.assertTrue(ok)
        legs = ex.open_orders()
        self.assertEqual(sorted(x.type for x in legs), ["limit", "stop"])
        self.assertEqual(legs[0].group, legs[1].group)
        self.assertAlmostEqual(ex.available_qty("BTC-USD"), 0)  # reserved once, not twice
        self.assertEqual(ex.place(OrderRequest("BTC-USD", "sell", "market", 1)).reason, "Not enough BTC to sell")

    def test_stop_fill_cancels_take_profit_and_vice_versa(self):
        ex, eng = self.setup()
        eng.place_manual(OrderRequest("BTC-USD", "buy", "market", 10, bracket={"stop_pct": 5, "tp_pct": 10}))
        tick(ex, 90)
        self.assertEqual(ex.open_orders(), [])
        self.assertEqual([f.side for f in ex.fills], ["buy", "sell"])
        self.assertLess(ex.fills[-1].realized, 0)
        self.assertEqual({o.status for o in ex.orders if o.type == "limit"}, {"cancelled"})
        ex2, eng2 = self.setup()
        eng2.place_manual(OrderRequest("BTC-USD", "buy", "market", 10, bracket={"stop_pct": 5, "tp_pct": 10}))
        tick(ex2, 120)
        self.assertEqual(ex2.open_orders(), [])
        self.assertGreater(ex2.fills[-1].realized, 0)
        self.assertEqual(len(ex2.fills), 2)  # only one exit filled

    def test_single_leg_and_resting_buy(self):
        ex, eng = self.setup()
        eng.place_manual(OrderRequest("BTC-USD", "buy", "market", 5, bracket={"stop_pct": 3, "tp_pct": 0}))
        self.assertEqual([x.type for x in ex.open_orders()], ["stop"])
        ex3, eng3 = self.setup()
        ok, o = eng3.place_manual(OrderRequest("BTC-USD", "buy", "limit", 5, 95, bracket={"stop_pct": 3, "tp_pct": 6}))
        self.assertEqual(o.status, "open")
        self.assertEqual(len(ex3.open_orders()), 1)  # exits wait for the buy to fill
        tick(ex3, 94)
        self.assertEqual(sorted(x.type for x in ex3.open_orders()), ["limit", "stop"])


class AllMarkets(unittest.TestCase):
    def test_every_market_is_tradable_before_playing(self):
        s = Session()
        for sym in s.symbols():
            self.assertIsNotNone(s.ex.mark(sym), sym)
            ok, o = s.eng.place_manual(OrderRequest(sym, "buy", "market", 0.01 if sym == "BTC-USD" else 0.5))
            self.assertTrue(ok, (sym, o))


class Persistence(unittest.TestCase):
    def test_round_trip(self):
        import os, tempfile
        from gtrader.store import Store
        d = tempfile.mkdtemp()
        path = os.path.join(d, "t.db")
        a = Session(store=Store(path))
        a.set_speed(60)
        a.eng.add_bot("sma-cross", "BTC-USD", params={"fast": 5, "slow": 20}, enabled=True)
        for _ in range(300):
            a.frame()
        ok, o = a.eng.place_manual(OrderRequest("BTC-USD", "buy", "limit", 0.01, 1000))
        a.pause()
        want = (a.ex.cash, a.ex.realized, len(a.ex.fills), a.ex.now, len(a.eng.bots), [x.id for x in a.ex.open_orders()])
        b = Session(store=Store(path))
        got = (b.ex.cash, b.ex.realized, len(b.ex.fills), b.ex.now, len(b.eng.bots), [x.id for x in b.ex.open_orders()])
        self.assertEqual(want, got)
        self.assertAlmostEqual(a.ex.equity(), b.ex.equity(), places=6)
        self.assertEqual(len(Store(path).fills()), len(a.ex.fills))
        # restored sessions keep trading
        for _ in range(100):
            b.frame()
        self.assertGreater(b.ex.now, a.ex.now)
