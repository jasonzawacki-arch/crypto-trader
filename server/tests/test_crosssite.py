"""Other websites must not be able to drive the API through the user's browser: cross-site writes, DNS rebinding
(a foreign host name pointing at 127.0.0.1) and passwords in addresses are refused."""
import json
import os
import unittest
import urllib.error
import urllib.request
from unittest import mock

from gtrader.api import host_name
from tests.test_api import Server

ORDER = {"symbol": "BTC-USD", "side": "buy", "type": "market", "qty": 0.01}


def send(s, method, path, body=None, headers=None):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(s.base + path, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


class OpenServer(unittest.TestCase):
    """No password: only localhost, only JSON, only from the app's own page."""

    @classmethod
    def setUpClass(cls):
        cls.s = Server()

    @classmethod
    def tearDownClass(cls):
        cls.s.stop()

    def test_own_page_still_works(self):
        code, _ = send(self.s, "POST", "/api/orders", ORDER, {"Content-Type": "application/json", "Origin": self.s.base})
        self.assertEqual(code, 201)

    def test_cross_site_order_refused(self):
        before = len(self.s.session.ex.fills)
        code, b = send(self.s, "POST", "/api/orders", ORDER, {"Content-Type": "text/plain", "Origin": "https://evil.example"})
        self.assertEqual(code, 403, b)
        code, b = send(self.s, "POST", "/api/orders", ORDER, {"Content-Type": "application/json", "Origin": "https://evil.example"})
        self.assertEqual(code, 403, b)
        self.assertEqual(len(self.s.session.ex.fills), before)

    def test_writes_must_be_json(self):
        code, b = send(self.s, "POST", "/api/orders", ORDER, {"Content-Type": "text/plain"})
        self.assertEqual(code, 415, b)

    def test_foreign_host_refused_when_open(self):
        code, b = send(self.s, "GET", "/api/state", None, {"Host": "attacker.example"})
        self.assertEqual(code, 403, b)
        self.assertIn("localhost", b["error"])
        self.assertEqual(send(self.s, "GET", "/api/state", None, {"Host": "localhost:1234"})[0], 200)

    def test_listed_host_allowed(self):
        with mock.patch.dict(os.environ, {"GT_HOSTS": "mybox.tail1234.ts.net"}):
            s = Server()
        try:
            self.assertEqual(send(s, "GET", "/api/state", None, {"Host": "mybox.tail1234.ts.net"})[0], 200)
        finally:
            s.stop()


class PasswordServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.s = Server(token="pw-123456")

    @classmethod
    def tearDownClass(cls):
        cls.s.stop()

    def test_any_host_name_with_password(self):
        # behind Tailscale or a cloud host the name differs; the password protects it
        code, _ = send(self.s, "GET", "/api/state", None, {"Host": "trader.example.com", "Authorization": "Bearer pw-123456"})
        self.assertEqual(code, 200)

    def test_password_in_address_only_for_stream(self):
        self.assertEqual(send(self.s, "GET", "/api/state?token=pw-123456")[0], 401)

    def test_listed_site_may_write(self):
        with mock.patch.dict(os.environ, {"GT_CORS": "https://app.example"}):
            s = Server(token="pw-123456")
        try:
            h = {"Content-Type": "application/json", "Origin": "https://app.example", "Authorization": "Bearer pw-123456"}
            self.assertEqual(send(s, "POST", "/api/orders", ORDER, h)[0], 201)
        finally:
            s.stop()


class HostName(unittest.TestCase):
    def test_parsing(self):
        self.assertEqual(host_name("localhost:8000"), "localhost")
        self.assertEqual(host_name("[::1]:8000"), "[::1]")
        self.assertEqual(host_name("Example.COM"), "example.com")


if __name__ == "__main__":
    unittest.main()
