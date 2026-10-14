"""The Python core must reproduce the TypeScript core's results (tests/golden.json from `node tests/golden.mjs`)."""
import json
import unittest
from pathlib import Path

from gtrader.backtest import BacktestOptions, run_backtest, run_sweep
from gtrader.feeds import SyntheticSource
from gtrader.session import RULES, load_candles
from gtrader.stats import compute_stats
from gtrader.strategies import default_params, strategy_by_id

G = json.loads((Path(__file__).parent / "golden.json").read_text())
DATA = load_candles()


class Parity(unittest.TestCase):
    def test_backtests_match_typescript(self):
        for case in G["backtests"]:
            sym = case["symbol"]
            with self.subTest(f"{sym} {case['strategy']} stop{case['stop']}"):
                r = run_backtest(BacktestOptions(sym, next(x for x in RULES if x.symbol == sym), DATA[sym], 3600000,
                                                 case["strategy"], default_params(strategy_by_id(case["strategy"])), 20, case["stop"]))
                self.assertEqual(len(r["fills"]), case["fills"])
                for k, v in case["metrics"].items():
                    if v is None:
                        self.assertIsNone(r["metrics"][k], k)
                    else:
                        self.assertAlmostEqual(r["metrics"][k], v, delta=1e-9 * max(1, abs(v)), msg=k)
                self.assertAlmostEqual(r["equity"][-1]["e"], case["lastEquity"], delta=1e-6)

    def test_sweeps_match_typescript(self):
        for case in G["sweeps"]:
            sym = case["symbol"]
            with self.subTest(f"{sym} {case['strategy']}"):
                o = BacktestOptions(sym, next(x for x in RULES if x.symbol == sym), DATA[sym], 3600000,
                                    case["strategy"], default_params(strategy_by_id(case["strategy"])), 20, 5)
                got, want = run_sweep(o), case["result"]
                self.assertEqual(len(got["rows"]), len(want["rows"]))
                for a, b in zip(got["rows"], want["rows"]):
                    self.assertEqual(a["kind"], b["kind"])
                    for k in ("returnPct", "buyHoldPct", "maxDrawdownPct", "trades"):
                        self.assertAlmostEqual(a[k], b[k], delta=1e-9 * max(1, abs(b[k])), msg=b["label"] + k)
                for k, v in want["summary"].items():
                    if k == "verdict":
                        self.assertEqual(got["summary"][k], v)
                    else:
                        self.assertAlmostEqual(got["summary"][k], v, delta=1e-9 * max(1, abs(v)), msg=k)

    def test_stats_match_typescript(self):
        for case in G["stats"]:
            sym = case["symbol"]
            with self.subTest(f"{sym} {case['strategy']} stop{case['stop']}"):
                r = run_backtest(BacktestOptions(sym, next(x for x in RULES if x.symbol == sym), DATA[sym], 3600000,
                                                 case["strategy"], default_params(strategy_by_id(case["strategy"])), 20, case["stop"]))
                got = compute_stats(r["fills"], r["equity"], 10000, r["equity"][-1]["e"])
                self.assertEqual(got.keys(), case["stats"].keys())
                for k, want in case["stats"].items():
                    if k in ("bySource", "bySymbol"):
                        self.assertEqual([g["key"] for g in got[k]], [g["key"] for g in want], k)
                        for a, b in zip(got[k], want):
                            for kk in ("trades", "realized", "fees", "winRatePct"):
                                self.assertEqual(a[kk] is None, b[kk] is None)
                                if b[kk] is not None:
                                    self.assertAlmostEqual(a[kk], b[kk], delta=1e-9 * max(1, abs(b[kk])))
                    elif want is None:
                        self.assertIsNone(got[k], k)
                    else:
                        self.assertAlmostEqual(got[k], want, delta=1e-9 * max(1, abs(want)), msg=k)

    def test_synthetic_market_matches_typescript(self):
        src = SyntheticSource(42, {"BTC-USD": 70000, "ETH-USD": 3000}, {"BTC-USD": 5, "ETH-USD": 80}, 1800000000000, 3600000, 0)
        for i, want in enumerate(G["synthetic"]):
            b = src.next()
            for key, sym in (("btc", "BTC-USD"), ("eth", "ETH-USD")):
                c, w = b[sym], want[key]
                for a, k in ((c.t, "t"), (c.o, "o"), (c.h, "h"), (c.l, "l"), (c.c, "c"), (c.v, "v")):
                    self.assertAlmostEqual(a, w[k], delta=1e-9 * max(1, abs(w[k])), msg=f"bar {i} {sym} {k}")


if __name__ == "__main__":
    unittest.main()


def _scenario(seed: int) -> dict:
    """Mirror of scenario() in tests/golden.mjs. Keep the two in step."""
    from gtrader.engine import Engine
    from gtrader.feeds import ticks_for
    from gtrader.paper import PaperExchange
    from gtrader.risk import RiskManager
    from gtrader.types import OrderRequest
    from gtrader.util import js_round, mulberry32
    syms = ["BTC-USD", "ETH-USD"]
    rules = [next(x for x in RULES if x.symbol == s) for s in syms]
    ex = PaperExchange({}, rules)
    risk = RiskManager({}, ex.cfg.starting_cash)
    eng = Engine(ex, risk, 3600000, 100000)
    eng.add_bot("sma-cross", "BTC-USD", alloc_pct=20, stop_pct=5, enabled=True)
    eng.add_bot("bollinger", "ETH-USD", alloc_pct=15, stop_pct=4, enabled=True)
    rng = mulberry32(seed)
    rd = lambda x, k: js_round(x * k) / k
    results = []
    for i in range(700):
        tk = [ticks_for(s, DATA[s][i], 4, 3600000) for s in syms]
        for k in range(4):
            for j in range(len(syms)):
                eng.tick(tk[j][k])
        if i % 7 != 6:
            continue
        sym = syms[int(rng() * 2)]
        mark = ex.mark(sym)
        r = rng()
        res = None
        big = 1 if sym == "BTC-USD" else 20
        if r < 0.25:
            req = OrderRequest(sym, "buy", "market", rd((0.01 + rng() * 0.04) * big, 1000))
            if rng() < 0.5:
                req.bracket = {"stop_pct": 3, "tp_pct": 6 if rng() < 0.5 else 0}
            res = eng.place_manual(req)
        elif r < 0.4:
            q = rd((0.01 + rng() * 0.03) * big, 1000)
            res = eng.place_manual(OrderRequest(sym, "buy", "limit", q, rd(mark * (1 - rng() * 0.03), 100)))
        elif r < 0.5:
            q = rd(ex.available_qty(sym) * 0.5, 1000)
            if q > 0:
                res = eng.place_manual(OrderRequest(sym, "sell", "stop", q, rd(mark * 0.97, 100)))
        elif r < 0.6:
            q = rd(ex.available_qty(sym), 1000)
            if q > 0:
                res = eng.place_manual(OrderRequest(sym, "sell", "market", q))
        elif r < 0.66:
            op = ex.open_orders()
            if op:
                ex.cancel(op[int(rng() * len(op))].id)
        elif r < 0.68:
            eng.kill(ex.now)
        elif r < 0.7:
            risk.reset(ex.equity())
        results.append("skip" if res is None else ("ok" if res[0] else res[1]))
    return {"results": results, "ex": ex, "risk": risk}


class ScenarioParity(unittest.TestCase):
    def test_random_trading_scenarios_match_typescript(self):
        for want in G["scenarios"]:
            with self.subTest(seed=want["seed"]):
                got = _scenario(want["seed"])
                ex = got["ex"]
                self.assertEqual(got["results"], want["results"])
                self.assertEqual(len(ex.fills), len(want["fills"]))
                for a, b in zip(ex.fills, want["fills"]):
                    self.assertEqual((a.id, a.symbol, a.side, a.t, a.source, a.maker), (b["id"], b["symbol"], b["side"], b["t"], b["source"], b["maker"]))
                    for k in ("qty", "price", "fee", "realized"):
                        self.assertAlmostEqual(getattr(a, k), b[k], delta=1e-9 * max(1, abs(b[k])), msg=f"{b['id']} {k}")
                self.assertEqual([(o.id, o.status, o.type, o.group) for o in ex.orders], [(o["id"], o["status"], o["type"], o["group"]) for o in want["orders"]])
                for k, w in (("cash", want["cash"]), ("fees_paid", want["feesPaid"])):
                    self.assertAlmostEqual(getattr(ex, k), w, delta=1e-8 * max(1, abs(w)))
                self.assertAlmostEqual(ex.equity(), want["equity"], delta=1e-8 * want["equity"])
                self.assertEqual(sorted(ex.positions), [p["symbol"] for p in want["positions"]])
                self.assertEqual(got["risk"].s.killed, want["killed"])
