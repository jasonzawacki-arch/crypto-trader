"""Users, roles, signed session tokens and the audit trail.

Roles:  viewer  reads state, runs backtests
        trader  also places and cancels orders, runs bots, plays the market, uses the kill switch and journal
        admin   also changes risk limits and costs, resets the account, manages users, reads the audit log

GT_TOKEN, if set, still works and counts as an admin ("token"), so single-user setups need no change.
Passwords are stored as scrypt hashes. Tokens are HMAC-signed and expire. Nothing here is a substitute for HTTPS.
"""
from __future__ import annotations

import base64
import collections
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Optional

ROLES = {"viewer": 0, "trader": 1, "admin": 2}
TOKEN_TTL = 12 * 3600
MAX_FAILS, FAIL_WINDOW = 5, 300


def hash_password(password: str, salt: Optional[bytes] = None) -> tuple[str, str]:
    salt = salt or secrets.token_bytes(16)
    h = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return salt.hex(), h.hex()


def needed_role(method: str, path: str) -> str:
    """The lowest role allowed to call this endpoint. Anything unlisted that writes needs trader."""
    if path in ("/api/login", "/api/health"):
        return ""
    if path.startswith("/api/users") or path == "/api/audit":
        return "admin"
    if method in ("GET", "HEAD"):
        return "viewer"
    if path in ("/api/backtest", "/api/sweep"):
        return "viewer"
    if path == "/api/config" or path == "/api/control/reset":
        return "admin"
    return "trader"


class Auth:
    def __init__(self, store, legacy_token: str = "", secret: Optional[str] = None):
        self.store, self.legacy = store, legacy_token
        s = secret or os.environ.get("GT_SECRET") or store.meta_get("secret")
        if not s:
            s = secrets.token_hex(32)
            store.meta_put("secret", s)
        self.secret = s.encode()
        self.fails: dict[str, collections.deque] = collections.defaultdict(collections.deque)

    @property
    def enabled(self) -> bool:
        return bool(self.legacy) or bool(self.store.users())

    # ---- users
    def add_user(self, name: str, password: str, role: str) -> None:
        name = name.strip()
        if not name or len(name) > 32 or not all(c.isalnum() or c in "._-" for c in name):
            raise ValueError("User names are 1 to 32 letters, digits, dots, dashes or underscores")
        if role not in ROLES:
            raise ValueError("Role must be viewer, trader or admin")
        if len(password) < 8:
            raise ValueError("Passwords need at least 8 characters")
        salt, h = hash_password(password)
        self.store.user_put(name, salt, h, role)

    def remove_user(self, name: str) -> None:
        u = self.store.user_get(name)
        if not u:
            raise KeyError("No such user")
        if u["role"] == "admin" and sum(1 for x in self.store.users() if x["role"] == "admin") <= 1 and not self.legacy:
            raise ValueError("That is the last admin. Add another admin first.")
        self.store.user_delete(name)

    # ---- login
    def throttled(self, key: str) -> bool:
        q, now = self.fails[key], time.time()
        while q and now - q[0] > FAIL_WINDOW:
            q.popleft()
        return len(q) >= MAX_FAILS

    def login(self, name: str, password: str, client: str = "") -> Optional[dict]:
        key = f"{client}|{name.lower()}"
        if self.throttled(key):
            raise PermissionError("Too many failed attempts. Wait a few minutes.")
        u = self.store.user_get(name)
        # Always hash, even for unknown users, so timing does not reveal which names exist.
        salt = bytes.fromhex(u["salt"]) if u else b"\0" * 16
        _, h = hash_password(password, salt)
        if u and hmac.compare_digest(h, u["hash"]):
            self.fails.pop(key, None)
            return {"name": u["name"], "role": u["role"], "token": self.issue(u["name"], u["role"]), "expiresIn": TOKEN_TTL}
        self.fails[key].append(time.time())
        return None

    # ---- tokens
    def issue(self, name: str, role: str, ttl: int = TOKEN_TTL, now: Optional[float] = None) -> str:
        payload = base64.urlsafe_b64encode(json.dumps({"n": name, "r": role, "x": int((now or time.time()) + ttl)}).encode()).decode().rstrip("=")
        sig = hmac.new(self.secret, payload.encode(), hashlib.sha256).hexdigest()
        return f"gt1.{payload}.{sig}"

    def identify(self, bearer: str, now: Optional[float] = None) -> Optional[tuple[str, str]]:
        """(name, role) for a valid credential, else None."""
        if not bearer:
            return None
        if self.legacy and hmac.compare_digest(bearer, self.legacy):
            return ("token", "admin")
        parts = bearer.split(".")
        if len(parts) != 3 or parts[0] != "gt1":
            return None
        good = hmac.new(self.secret, parts[1].encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(good, parts[2]):
            return None
        try:
            d = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        except Exception:
            return None
        if d.get("x", 0) < (now or time.time()):
            return None
        u = self.store.user_get(d.get("n", ""))  # removing a user or changing a role takes effect immediately
        return (u["name"], u["role"]) if u else None

    # ---- audit
    def audit(self, user: str, role: str, method: str, path: str, status: int, detail: str = "") -> None:
        self.store.audit_add(time.time(), user, role, method, path, status, detail[:300])


def summarize(path: str, body: dict) -> str:
    """A short, secret-free description of what a request asked for."""
    if path.startswith("/api/login"):
        return "user " + str(body.get("name", ""))[:32]
    if path == "/api/orders":
        keys = ("symbol", "side", "type", "qty", "price", "bracket")
    elif path.startswith("/api/users"):
        keys = ("name", "role")  # never the password
    elif path.startswith("/api/journal"):
        keys = ("tag",)
    else:
        keys = ("symbol", "strategy", "mode", "speed", "alloc_pct", "stop_pct", "enabled", "paper", "risk", "params")
    return json.dumps({k: body[k] for k in keys if k in body}, separators=(",", ":"))
