import json
import threading
import time
import unittest
import urllib.error
import urllib.request

import uvicorn

from gtrader.api import make_app
from gtrader.session import Session


class Server:
    def __init__(self, token=""):
        self.session = Session()
        self.app = make_app(self.session, token)
        cfg = uvicorn.Config(self.app, host="127.0.0.1", port=0, log_level="error")
        self.server = uvicorn.Server(cfg)
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        for _ in range(100):
            if self.server.started:
                break
            time.sleep(0.05)
        self.base = "http://127.0.0.1:%d" % self.server.servers[0].sockets[0].getsockname()[1]
        self.token = token

    def call(self, method, path, body=None, auth=True):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"})
        if self.token and auth:
            req.add_header("Authorization", "Bearer " + self.token)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def stop(self):
        self.server.should_exit = True
        self.thread.join(5)


class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.s = Server()

    @classmethod
    def tearDownClass(cls):
        cls.s.stop()

    def test_flow(self):
        c = self.s.call
        self.assertEqual(c("GET", "/api/health")[1]["live"], False)
        st = c("GET", "/api/state")[1]
        self.assertEqual(st["account"]["equity"], 10000)
        code, o = c("POST", "/api/orders", {"symbol": "BTC-USD", "side": "buy", "type": "market", "qty": 0.01})
        self.assertEqual(code, 201)
        self.assertEqual(o["order"]["status"], "filled")
        st = c("GET", "/api/state")[1]
        self.assertEqual(len(st["positions"]), 1)
        self.assertLess(st["account"]["cash"], 10000)
        # risk refusal comes back as 422 with a reason
        code, e = c("POST", "/api/orders", {"symbol": "BTC-USD", "side": "buy", "type": "market", "qty": 5})
        self.assertEqual(code, 422)
        self.assertIn("limit is 25%", e["error"])
        # limit order rests and can be cancelled
        code, o = c("POST", "/api/orders", {"symbol": "BTC-USD", "side": "buy", "type": "limit", "qty": 0.01, "price": 1000})
        oid = o["order"]["id"]
        self.assertEqual(o["order"]["status"], "open")
        self.assertEqual(c("DELETE", "/api/orders/" + oid)[0], 200)
        self.assertEqual(c("DELETE", "/api/orders/" + oid)[0], 404)
        # bots
        code, b = c("POST", "/api/bots", {"strategy": "sma-cross", "params": {"fast": 5, "slow": 20}})
        self.assertEqual(code, 201)
        self.assertEqual(c("PATCH", "/api/bots/" + b["id"], {"enabled": True})[0], 200)
        self.assertEqual(c("PATCH", "/api/bots/" + b["id"], {"alloc_pct": 99})[0], 400)
        self.assertEqual(c("POST", "/api/bots", {"strategy": "nope"})[0], 400)
        # kill switch blocks buys and bot restarts
        c("POST", "/api/risk/kill")
        self.assertEqual(c("POST", "/api/orders", {"symbol": "BTC-USD", "side": "buy", "type": "market", "qty": 0.01})[0], 422)
        self.assertEqual(c("PATCH", "/api/bots/" + b["id"], {"enabled": True})[0], 409)
        self.assertEqual(c("POST", "/api/orders", {"symbol": "BTC-USD", "side": "sell", "type": "market", "qty": 0.01})[0], 201)
        c("POST", "/api/risk/resume")
        self.assertFalse(c("GET", "/api/state")[1]["risk"]["killed"])
        self.assertEqual(c("DELETE", "/api/bots/" + b["id"])[0], 200)

    def test_playback_and_reset(self):
        c = self.s.call
        c("POST", "/api/control/speed", {"speed": 60})
        self.assertEqual(c("POST", "/api/control/speed", {"speed": 7})[0], 400)
        t0 = c("GET", "/api/state")[1]["time"]
        c("POST", "/api/control/play")
        time.sleep(0.6)
        c("POST", "/api/control/pause")
        self.assertGreater(c("GET", "/api/state")[1]["time"], t0)
        code, st = c("POST", "/api/control/reset", {"mode": "synthetic", "seed": 3})
        self.assertEqual((st["mode"], st["seed"], st["account"]["equity"]), ("synthetic", 3, 10000))
        self.assertEqual(c("POST", "/api/control/reset", {"mode": "bogus"})[0], 400)
        c("POST", "/api/control/reset", {"mode": "replay", "seed": 1})
        cs = c("GET", "/api/candles?symbol=ETH-USD&limit=50")[1]
        self.assertEqual(len(cs["candles"]), 50)

    def test_config_and_backtest(self):
        c = self.s.call
        self.assertEqual(c("PUT", "/api/config", {"paper": {"bogus": 1}})[0], 400)
        self.assertEqual(c("PUT", "/api/config", {"risk": {"max_order_pct": -1}})[0], 400)
        code, cfg = c("PUT", "/api/config", {"paper": {"taker_bps": 10}, "risk": {"max_order_pct": 30}})
        self.assertEqual((cfg["paper"]["taker_bps"], cfg["risk"]["max_order_pct"]), (10, 30))
        c("PUT", "/api/config", {"paper": {"taker_bps": 40}, "risk": {"max_order_pct": 25}})
        code, r = c("POST", "/api/backtest", {"strategy": "buy-hold", "symbol": "SOL-USD", "stop_pct": 0})
        self.assertEqual(code, 200)
        self.assertEqual(r["metrics"]["trades"], 0)
        self.assertIn("train", r["split"])
        self.assertEqual(c("POST", "/api/backtest", {"strategy": "x"})[0], 400)


class Auth(unittest.TestCase):
    def test_token_required(self):
        s = Server("sekret")
        try:
            self.assertEqual(s.call("GET", "/api/health", auth=False)[0], 200)
            self.assertEqual(s.call("GET", "/api/state", auth=False)[0], 401)
            self.assertEqual(s.call("POST", "/api/risk/kill", auth=False)[0], 401)
            self.assertEqual(s.call("GET", "/api/state")[0], 200)
        finally:
            s.stop()


if __name__ == "__main__":
    unittest.main()


class ApiExtras(unittest.TestCase):
    def test_bracket_stats_and_fills(self):
        s = Server()
        try:
            c = s.call
            code, o = c("POST", "/api/orders", {"symbol": "BTC-USD", "side": "buy", "type": "market", "qty": 0.01, "bracket": {"stop_pct": 5, "tp_pct": 10}})
            self.assertEqual(code, 201)
            orders = c("GET", "/api/state")[1]["orders"]
            self.assertEqual(sorted(x["type"] for x in orders), ["limit", "stop"])
            self.assertEqual(orders[0]["group"], orders[1]["group"])
            self.assertEqual(c("POST", "/api/orders", {"symbol": "BTC-USD", "side": "sell", "type": "market", "qty": 0.01, "bracket": {"stop_pct": 5}})[0], 400)
            self.assertEqual(c("POST", "/api/orders", {"symbol": "BTC-USD", "side": "buy", "type": "market", "qty": 0.01, "bracket": {"stop_pct": 99}})[0], 400)
            st = c("GET", "/api/stats")[1]
            self.assertEqual(st["trades"], 0)
            self.assertEqual(st["bySymbol"][0]["key"], "BTC-USD")
            self.assertEqual(len(c("GET", "/api/fills")[1]["fills"]), 1)
        finally:
            s.stop()
