"""Alerts for fills, risk halts and the kill switch. Optional: set GT_ALERT_URL to turn on.

GT_ALERT_FORMAT=ntfy  POSTs plain text (works with ntfy.sh topics or self-hosted ntfy)
GT_ALERT_FORMAT=json  POSTs {"text": ..., "content": ...} (Slack and Discord incoming webhooks)
GT_ALERT_KINDS=risk,fill,warn  which log kinds to send (default risk,fill).
"""
from __future__ import annotations

import json
import os
import threading
import urllib.request
from typing import Callable, Optional


def _post(url: str, body: bytes, headers: dict) -> None:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=8) as r:  # closes the connection after each alert
        r.read()


class Notifier:
    def __init__(self, url: str = "", fmt: str = "ntfy", kinds: str = "risk,fill", sender: Optional[Callable] = None,
                 background: bool = True, max_per_minute: int = 20):
        self.url, self.fmt = url, fmt
        self.kinds = {k.strip() for k in kinds.split(",") if k.strip()}
        self.sender = sender or _post
        self.background = background
        self.sent: list[str] = []
        self.errors: list[str] = []
        self._recent: list[float] = []
        self.max_per_minute = max_per_minute

    @classmethod
    def from_env(cls) -> "Notifier":
        return cls(os.environ.get("GT_ALERT_URL", ""), os.environ.get("GT_ALERT_FORMAT", "ntfy"),
                   os.environ.get("GT_ALERT_KINDS", "risk,fill"))

    @property
    def enabled(self) -> bool:
        return bool(self.url)

    def notify(self, kind: str, text: str, now: float = 0.0) -> bool:
        if not self.enabled or kind not in self.kinds:
            return False
        import time
        t = now or time.time()
        self._recent = [x for x in self._recent if t - x < 60]
        if len(self._recent) >= self.max_per_minute:  # a runaway bot must not flood your phone
            return False
        self._recent.append(t)
        title = {"risk": "Crypto Trader: risk", "fill": "Crypto Trader: fill", "warn": "Crypto Trader: warning"}.get(kind, "Crypto Trader")
        if self.fmt == "json":
            body, headers = json.dumps({"text": f"{title}: {text}", "content": f"{title}: {text}"}).encode(), {"Content-Type": "application/json"}
        else:
            body, headers = text.encode(), {"Title": title, "Content-Type": "text/plain"}
        self.sent.append(text)

        def go():
            try:
                self.sender(self.url, body, headers)
            except Exception as e:  # alerts must never break trading
                self.errors.append(str(e))

        if self.background:
            threading.Thread(target=go, daemon=True).start()
        else:
            go()
        return True
