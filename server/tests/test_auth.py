import os
import time
import unittest

from gtrader.auth import Auth, needed_role
from gtrader.store import Store
from tests.test_api import Server


class Roles(unittest.TestCase):
    def test_permission_table(self):
        self.assertEqual(needed_role("GET", "/api/state"), "viewer")
        self.assertEqual(needed_role("POST", "/api/backtest"), "viewer")
        self.assertEqual(needed_role("POST", "/api/orders"), "trader")
        self.assertEqual(needed_role("POST", "/api/risk/kill"), "trader")
        self.assertEqual(needed_role("PUT", "/api/config"), "admin")
        self.assertEqual(needed_role("POST", "/api/control/reset"), "admin")
        self.assertEqual(needed_role("GET", "/api/audit"), "admin")
        self.assertEqual(needed_role("POST", "/api/login"), "")

    def test_tokens(self):
        a = Auth(Store(":memory:"))
        a.add_user("amy", "correct horse", "trader")
        tok = a.issue("amy", "trader")
        self.assertEqual(a.identify(tok), ("amy", "trader"))
        head, payload, sig = tok.split(".")
        self.assertIsNone(a.identify(f"{head}.{payload}.{'0' * 64}"))  # forged signature
        self.assertIsNone(a.identify(a.issue("amy", "trader", ttl=-5)))  # expired
        self.assertIsNone(a.identify(a.issue("ghost", "admin")))  # signed but no such user
        other = Auth(Store(":memory:"))
        self.assertIsNone(other.identify(tok))  # signed with a different secret
        with self.assertRaises(ValueError):
            a.add_user("bob", "short", "trader")
        with self.assertRaises(ValueError):
            a.add_user("bad name!", "long enough pw", "trader")
        with self.assertRaises(ValueError):
            a.add_user("bob", "long enough pw", "root")


class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["GT_ADMIN_USER"], os.environ["GT_ADMIN_PASSWORD"] = "root", "admin-password-1"
        cls.s = Server()
        del os.environ["GT_ADMIN_USER"], os.environ["GT_ADMIN_PASSWORD"]

    @classmethod
    def tearDownClass(cls):
        cls.s.stop()

    def call(self, tok, method, path, body=None):
        self.s.token = tok or ""
        return self.s.call(method, path, body, auth=bool(tok))

    def test_everything(self):
        c = self.call
        self.assertEqual(c(None, "GET", "/api/health")[1]["login"], True)
        self.assertEqual(c(None, "GET", "/api/state")[0], 401)
        self.assertEqual(c(None, "POST", "/api/login", {"name": "root", "password": "nope"})[0], 401)
        code, j = c(None, "POST", "/api/login", {"name": "root", "password": "admin-password-1"})
        self.assertEqual(code, 200)
        admin = j["token"]
        self.assertEqual(c(admin, "GET", "/api/me")[1], {"name": "root", "role": "admin"})
        self.assertEqual(c(admin, "POST", "/api/users", {"name": "tina", "password": "trader-pass-1", "role": "trader"})[0], 201)
        self.assertEqual(c(admin, "POST", "/api/users", {"name": "vic", "password": "viewer-pass-1", "role": "viewer"})[0], 201)
        tina = c(None, "POST", "/api/login", {"name": "tina", "password": "trader-pass-1"})[1]["token"]
        vic = c(None, "POST", "/api/login", {"name": "vic", "password": "viewer-pass-1"})[1]["token"]
        buy = {"symbol": "BTC-USD", "side": "buy", "type": "market", "qty": 0.01}
        # viewer: reads and backtests only
        self.assertEqual(c(vic, "GET", "/api/state")[0], 200)
        self.assertEqual(c(vic, "POST", "/api/backtest", {"symbol": "BTC-USD", "strategy": "sma-cross", "split": False})[0], 200)
        code, e = c(vic, "POST", "/api/orders", buy)
        self.assertEqual(code, 403)
        self.assertIn("viewer", e["error"])
        # trader: trades, cannot change limits, reset, read the audit log or manage users
        self.assertEqual(c(tina, "POST", "/api/orders", buy)[0], 201)
        self.assertEqual(c(tina, "POST", "/api/risk/kill")[0], 200)
        self.assertEqual(c(tina, "PUT", "/api/config", {"risk": {"max_order_pct": 90}})[0], 403)
        self.assertEqual(c(tina, "POST", "/api/control/reset", {})[0], 403)
        self.assertEqual(c(tina, "GET", "/api/audit")[0], 403)
        self.assertEqual(c(tina, "GET", "/api/users")[0], 403)
        # admin sees who did what, with no passwords anywhere
        code, a = c(admin, "GET", "/api/audit?limit=200")
        text = str(a)
        self.assertNotIn("trader-pass-1", text)
        self.assertNotIn("admin-password-1", text)
        rows = a["audit"]
        self.assertTrue(any(r["user"] == "tina" and r["path"] == "/api/orders" and r["status"] == 201 and "BTC-USD" in r["detail"] for r in rows))
        self.assertTrue(any(r["user"] == "vic" and r["status"] == 403 for r in rows))
        self.assertTrue(any(r["user"] == "tina" and r["path"] == "/api/config" and r["status"] == 403 for r in rows))
        self.assertTrue(any(r["path"] == "/api/login" and r["status"] == 401 for r in rows))
        # removing a user cuts off their token at once; the last admin cannot be removed
        self.assertEqual(c(admin, "DELETE", "/api/users/vic")[0], 200)
        self.assertEqual(c(vic, "GET", "/api/state")[0], 401)
        self.assertEqual(c(admin, "DELETE", "/api/users/root")[0], 409)
        self.assertEqual(c(admin, "DELETE", "/api/users/nobody")[0], 404)
        # changing a role applies without a new login
        c(admin, "POST", "/api/users", {"name": "tina", "password": "trader-pass-1", "role": "viewer"})
        self.assertEqual(c(tina, "POST", "/api/orders", buy)[0], 403)
        # brute force is throttled
        for _ in range(6):
            code = c(None, "POST", "/api/login", {"name": "tina", "password": "wrong"})[0]
        self.assertEqual(code, 429)
        self.assertEqual(c(None, "POST", "/api/login", {"name": "tina", "password": "trader-pass-1"})[0], 429)


class Open(unittest.TestCase):
    def test_no_users_no_token_is_open_and_legacy_token_is_admin(self):
        s = Server()
        try:
            self.assertEqual(s.call("GET", "/api/me")[1], {"name": "local", "role": "admin"})
            self.assertEqual(s.call("POST", "/api/orders", {"symbol": "BTC-USD", "side": "buy", "type": "market", "qty": 0.01})[0], 201)
        finally:
            s.stop()
        s = Server(token="legacy-secret")
        try:
            self.assertEqual(s.call("GET", "/api/state", auth=False)[0], 401)
            self.assertEqual(s.call("GET", "/api/me")[1], {"name": "token", "role": "admin"})
        finally:
            s.stop()


if __name__ == "__main__":
    unittest.main()
