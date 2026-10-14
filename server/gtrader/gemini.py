"""Read-only Gemini client. It can look at the market and the account; it cannot place or cancel orders.

Read-only is enforced twice: the key you create at Gemini should have no trading permission, and this client refuses
any endpoint outside READ_ONLY_PATHS. Written from Gemini's REST documentation and unit-tested with a fake transport;
it has not been run against the live service from the build sandbox, so try it on your own machine first.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import urllib.request
from typing import Callable, Optional

BASE = "https://api.gemini.com"
PUBLIC_GET = ("/v2/candles/", "/v1/pubticker/", "/v1/symbols/details/", "/v1/symbols")
PRIVATE_POST = ("/v1/balances", "/v1/orders", "/v1/mytrades")  # all read-only account queries
READ_ONLY_PATHS = PUBLIC_GET + PRIVATE_POST


class ReadOnlyViolation(Exception):
    pass


Transport = Callable[[str, str, dict, Optional[bytes]], tuple]  # (method, url, headers, body) -> (status, json)


def _urllib_transport(method: str, url: str, headers: dict, body: Optional[bytes]):
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
        try:
            return e.code, json.loads(e.read() or b"null")
        except Exception:
            return e.code, None


def gemini_symbol(sym: str) -> str:
    """BTC-USD -> btcusd"""
    return sym.replace("-", "").lower()


class GeminiReadOnly:
    def __init__(self, key: str = "", secret: str = "", transport: Optional[Transport] = None, base: str = BASE,
                 nonce: Optional[Callable[[], int]] = None):
        self.key, self.secret, self.base = key, secret, base.rstrip("/")
        self.transport = transport or _urllib_transport
        self._nonce = nonce or (lambda: int(time.time() * 1000))
        self._last = 0

    @classmethod
    def from_env(cls) -> "GeminiReadOnly":
        return cls(os.environ.get("GT_GEMINI_KEY", ""), os.environ.get("GT_GEMINI_SECRET", ""))

    @property
    def configured(self) -> bool:
        return bool(self.key and self.secret)

    @staticmethod
    def _check(path: str, allowed: tuple) -> None:
        if not path.startswith(allowed):
            raise ReadOnlyViolation(f"{path} is not on the read-only list")

    def _public(self, path: str):
        self._check(path, PUBLIC_GET)
        status, data = self.transport("GET", self.base + path, {}, None)
        if status != 200:
            raise RuntimeError(f"Gemini {path} returned {status}: {data}")
        return data

    def _private(self, path: str, extra: Optional[dict] = None):
        self._check(path, PRIVATE_POST)
        if not self.configured:
            raise RuntimeError("Gemini keys are not set (GT_GEMINI_KEY, GT_GEMINI_SECRET)")
        n = max(self._nonce(), self._last + 1)  # nonces must strictly increase
        self._last = n
        payload = {"request": path, "nonce": n, **(extra or {})}
        b64 = base64.b64encode(json.dumps(payload).encode())
        sig = hmac.new(self.secret.encode(), b64, hashlib.sha384).hexdigest()
        headers = {"Content-Type": "text/plain", "Content-Length": "0", "X-GEMINI-APIKEY": self.key,
                   "X-GEMINI-PAYLOAD": b64.decode(), "X-GEMINI-SIGNATURE": sig, "Cache-Control": "no-cache"}
        status, data = self.transport("POST", self.base + path, headers, b"")
        if status != 200:
            reason = data.get("reason") if isinstance(data, dict) else None
            raise RuntimeError(f"Gemini {path} returned {status}{': ' + reason if reason else ''}")
        return data

    # ---- market data
    def candles(self, symbol: str, tf: str = "1hr") -> list[list[float]]:
        """Oldest first. Gemini returns newest first, as [t, o, h, l, c, v]."""
        rows = self._public(f"/v2/candles/{gemini_symbol(symbol)}/{tf}")
        return sorted(([float(x) for x in r] for r in rows), key=lambda r: r[0])

    def ticker(self, symbol: str) -> dict:
        d = self._public(f"/v1/pubticker/{gemini_symbol(symbol)}")
        base = symbol.split("-")[0].upper()
        vol = (d.get("volume") or {}).get(base)
        return {"bid": float(d["bid"]), "ask": float(d["ask"]), "last": float(d["last"]), "vol24": float(vol) if vol else 0.0}

    # ---- account (read-only)
    def balances(self) -> dict[str, float]:
        """{'USD': 1234.5, 'BTC': 0.1}, available plus held."""
        return {r["currency"].upper(): float(r["amount"]) for r in self._private("/v1/balances")}

    def open_orders(self) -> list[dict]:
        return [{"id": str(o["order_id"]), "symbol": o["symbol"], "side": o["side"], "price": float(o["price"]),
                 "qty": float(o["remaining_amount"])} for o in self._private("/v1/orders")]

    def snapshot(self) -> dict:
        return {"balances": self.balances(), "open_orders": self.open_orders(), "at": time.time()}


def reconcile(expected: dict[str, float], actual: dict[str, float], tol: float = 1e-6, dust: float = 1e-8) -> list[dict]:
    """Compares what the app believes it holds against the exchange. The exchange is the source of truth.
    Returns one entry per asset that differs by more than tol (relative to the larger side)."""
    out = []
    for asset in sorted(set(expected) | set(actual)):
        e, a = expected.get(asset, 0.0), actual.get(asset, 0.0)
        if abs(e) < dust and abs(a) < dust:
            continue
        if abs(e - a) > tol * max(1.0, abs(e), abs(a)):
            out.append({"asset": asset, "expected": e, "actual": a, "diff": a - e})
    return out
