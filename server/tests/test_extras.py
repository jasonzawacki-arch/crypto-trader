import base64, hashlib, hmac, json, os, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from gtrader.alerts import Notifier
from gtrader.gemini import GeminiReadOnly, ReadOnlyViolation, reconcile
from gtrader.session import Session
from gtrader.types import OrderRequest


class FakeGemini:
    def __init__(self):
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers))
        path = url.split("api.gemini.com")[1]
        if path.startswith("/v2/candles/"):
            return 200, [[3000, 1, 2, 0.5, 1.5, 10], [1000, 1, 1, 1, 1, 1], [2000, 2, 2, 2, 2, 2]]
        if path.startswith("/v1/pubticker/"):
            return 200, {"bid": "99.5", "ask": "100.5", "last": "100"}
        if path == "/v1/balances":
            return 200, [{"currency": "USD", "amount": "500.25"}, {"currency": "BTC", "amount": "0.5"}]
        if path == "/v1/orders":
            return 200, [{"order_id": 77, "symbol": "btcusd", "side": "buy", "price": "100", "remaining_amount": "0.1"}]
        return 404, None


class Gemini(unittest.TestCase):
    def mk(self):
        t = FakeGemini()
        return GeminiReadOnly("key", "secret", t, nonce=lambda: 5), t

    def test_market_and_account_reads(self):
        g, _ = self.mk()
        self.assertEqual([r[0] for r in g.candles("BTC-USD")], [1000, 2000, 3000])  # sorted oldest first
        self.assertEqual(g.ticker("BTC-USD")["ask"], 100.5)
        self.assertEqual(g.balances(), {"USD": 500.25, "BTC": 0.5})
        self.assertEqual(g.open_orders()[0]["id"], "77")

    def test_requests_are_signed_correctly(self):
        g, t = self.mk()
        g.balances()
        _, _, h = t.calls[-1]
        payload = json.loads(base64.b64decode(h["X-GEMINI-PAYLOAD"]))
        self.assertEqual(payload["request"], "/v1/balances")
        want = hmac.new(b"secret", h["X-GEMINI-PAYLOAD"].encode(), hashlib.sha384).hexdigest()
        self.assertEqual(h["X-GEMINI-SIGNATURE"], want)
        self.assertEqual(h["X-GEMINI-APIKEY"], "key")

    def test_nonce_always_increases(self):
        g, t = self.mk()
        g.balances(); g.balances(); g.open_orders()
        ns = [json.loads(base64.b64decode(c[2]["X-GEMINI-PAYLOAD"]))["nonce"] for c in t.calls]
        self.assertEqual(ns, sorted(set(ns)))

    def test_cannot_trade(self):
        g, _ = self.mk()
        for path in ("/v1/order/new", "/v1/order/cancel", "/v1/withdraw/btc", "/v1/order/cancel/all"):
            with self.assertRaises(ReadOnlyViolation):
                g._private(path)
        with self.assertRaises(ReadOnlyViolation):
            g._public("/v1/order/new")
        self.assertFalse(hasattr(g, "place_order") or hasattr(g, "cancel_order"))

    def test_needs_keys_for_account(self):
        with self.assertRaises(RuntimeError):
            GeminiReadOnly("", "", FakeGemini()).balances()

    def test_reconcile(self):
        self.assertEqual(reconcile({"USD": 100, "BTC": 1}, {"USD": 100, "BTC": 1}), [])
        d = reconcile({"USD": 100, "BTC": 1}, {"USD": 90, "ETH": 2})
        self.assertEqual({x["asset"] for x in d}, {"USD", "BTC", "ETH"})
        self.assertEqual(reconcile({"BTC": 1e-12}, {}), [])


class Alerts(unittest.TestCase):
    def test_filters_formats_and_rate_limit(self):
        got = []
        n = Notifier("http://x", "ntfy", "risk,fill", lambda u, b, h: got.append((b, h)), background=False, max_per_minute=3)
        self.assertFalse(n.notify("info", "ignored", 1))
        self.assertTrue(n.notify("risk", "Kill switch on", 1))
        self.assertEqual(got[0][0], b"Kill switch on")
        self.assertIn("risk", got[0][1]["Title"])
        n.notify("fill", "a", 2); n.notify("fill", "b", 3)
        self.assertFalse(n.notify("fill", "flood", 4))
        self.assertTrue(n.notify("fill", "later", 100))
        j = Notifier("http://x", "json", sender=lambda u, b, h: got.append(json.loads(b)), background=False)
        j.notify("fill", "hello", 1)
        self.assertIn("hello", got[-1]["text"])

    def test_failure_never_raises(self):
        def boom(*a):
            raise OSError("down")
        n = Notifier("http://x", sender=boom, background=False)
        self.assertTrue(n.notify("risk", "x", 1))
        self.assertEqual(n.errors, ["down"])

    def test_session_alerts_on_fills_and_kill(self):
        seen = []
        n = Notifier("http://x", "ntfy", "risk,fill", lambda u, b, h: seen.append(b.decode()), background=False)
        s = Session(notifier=n)
        s.eng.place_manual(OrderRequest("BTC-USD", "buy", "market", 0.01))
        s.eng.kill(s.ex.now)
        self.assertTrue(any("BUY" in x for x in seen))
        self.assertTrue(any("Kill switch" in x for x in seen))

    def test_real_http_post(self):
        box = []

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                box.append((self.headers.get("Title"), self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(200); self.end_headers(); self.wfile.write(b"ok")

            def log_message(self, *a): pass

        srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        Notifier(f"http://127.0.0.1:{srv.server_port}/t", background=False).notify("risk", "hello", 1)
        srv.shutdown()
        self.assertEqual(box[0][1], b"hello")


if __name__ == "__main__":
    unittest.main()


class History(unittest.TestCase):
    def test_csv_import_merge_align_validate(self):
        from gtrader import history as h
        d = tempfile.mkdtemp()
        p = os.path.join(d, "a.csv")
        with open(p, "w") as f:
            f.write("Date,Open,High,Low,Close,Volume BTC\n2024-01-01 02:00:00,3,4,2,3.5,9\n2024-01-01 00:00:00,1,2,0.5,1.5,5\n2024-01-01 01:00:00,2,3,1,2.5,7\n")
        rows = h.from_csv(p)
        self.assertEqual([r[0] for r in rows], [1704067200000, 1704070800000, 1704074400000])  # sorted, ms
        self.assertEqual(h.validate(rows)["gaps"], [])
        new = [[1704074400000, 3, 5, 2, 4, 1], [1704078000000, 4, 5, 3, 4, 1]]
        m = h.merge(rows, new)
        self.assertEqual(len(m), 4)
        self.assertEqual(m[2][5], 1)  # newer wins
        al = h.align({"A": m, "B": rows})
        self.assertEqual(len(al["A"]), 3)
        bad = h.validate([[0, 1, 0.5, 2, 1.5, 1]])  # high below low
        self.assertEqual(len(bad["badCandles"]), 1)
        out = os.path.join(d, "c.json")
        self.assertEqual(h.main(["import", "BTC-USD", p, "--out", out]), 0)
        self.assertEqual(len(h.read(out)["BTC-USD"]), 3)
        self.assertEqual(h.main(["check", out]), 0)

    def test_bundled_data_is_clean(self):
        from gtrader import history as h
        from gtrader.session import load_candles
        for sym, rows in h.read(str(__import__("pathlib").Path(__file__).parent.parent / "data" / "candles.json")).items():
            v = h.validate(rows)
            self.assertEqual((v["gaps"], v["badCandles"]), ([], []), sym)


class StrategiesAndSweep(unittest.TestCase):
    def test_dca_accumulates_and_ignores_stop(self):
        from gtrader.backtest import BacktestOptions, run_backtest
        from gtrader.session import RULES, load_candles
        from gtrader.strategies import default_params, strategy_by_id
        data = load_candles()["BTC-USD"]
        def run(sid, stop):
            return run_backtest(BacktestOptions("BTC-USD", RULES[0], data, 3600000, sid, default_params(strategy_by_id(sid)), 5, stop))
        d = run("dca", 5)
        self.assertGreater(sum(1 for f in d["fills"] if f.side == "buy"), 3)
        self.assertEqual(sum(1 for f in d["fills"] if f.side == "sell"), 0)
        self.assertGreater(run("bollinger", 5)["metrics"]["trades"], 0)

    def test_sweep_endpoint(self):
        from tests.test_api import Server
        srv = Server()
        try:
            code, j = srv.call("POST", "/api/sweep", {"symbol": "BTC-USD", "strategy": "sma-cross"})
            self.assertEqual(code, 200)
            self.assertIn("summary", j)
            self.assertEqual(srv.call("POST", "/api/sweep", {"symbol": "X", "strategy": "sma-cross"})[0], 400)
        finally:
            srv.stop()


class Journal(unittest.TestCase):
    def test_journal_api_and_persistence(self):
        from gtrader.store import Store
        from tests.test_api import Server
        path = tempfile.mktemp(suffix=".db")
        srv = Server()
        try:
            c = srv.call
            _, o = c("POST", "/api/orders", {"symbol": "BTC-USD", "side": "buy", "type": "market", "qty": 0.01})
            fid = c("GET", "/api/fills")[1]["fills"][0]["id"]
            code, j = c("PUT", "/api/journal/" + fid, {"tag": "Plan", "note": "x" * 900})
            self.assertEqual(code, 200)
            self.assertEqual(len(j["journal"][fid]["note"]), 500)
            self.assertEqual(c("GET", "/api/state")[1]["journal"][fid]["tag"], "Plan")
            self.assertEqual(c("PUT", "/api/journal/NOPE", {"tag": "a"})[0], 404)
            c("PUT", "/api/journal/" + fid, {"tag": "", "note": ""})
            self.assertEqual(c("GET", "/api/state")[1]["journal"], {})
        finally:
            srv.stop()
        # survives a restart through the SQLite snapshot
        s1 = Session(store=Store(path))
        s1.ex.place(OrderRequest("BTC-USD", "buy", "market", 0.01))
        s1.set_journal(s1.ex.fills[0].id, "FOMO", "late")
        s1.save(True)
        s2 = Session(store=Store(path))
        self.assertEqual(s2.journal[s2.ex.fills[0].id]["tag"], "FOMO")
