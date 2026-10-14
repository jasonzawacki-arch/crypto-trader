"""SQLite persistence: the latest session snapshot plus an append-only fills journal."""
from __future__ import annotations

import json
import sqlite3
import threading
from typing import Optional


class Store:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.lock = threading.Lock()
        with self.lock, self.db:
            self.db.execute("CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, saved_at REAL NOT NULL DEFAULT (strftime('%s','now')))")
            self.db.execute("CREATE TABLE IF NOT EXISTS fills (id TEXT NOT NULL, run INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (run, id))")
            self.db.execute("CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL, created REAL NOT NULL DEFAULT (strftime('%s','now')))")
            self.db.execute("CREATE TABLE IF NOT EXISTS audit (n INTEGER PRIMARY KEY AUTOINCREMENT, t REAL NOT NULL, user TEXT NOT NULL, role TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, detail TEXT NOT NULL)")
            self.db.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
            self.db.execute("CREATE TABLE IF NOT EXISTS events (n INTEGER PRIMARY KEY AUTOINCREMENT, t REAL NOT NULL DEFAULT (strftime('%s','now')), kind TEXT NOT NULL, body TEXT NOT NULL)")

    def close(self) -> None:
        with self.lock:
            self.db.close()

    def __del__(self) -> None:
        # A Store dropped without close() (tests, a replaced session) still releases its database file.
        try:
            self.db.close()
        except Exception:
            pass

    def save(self, snap: dict) -> None:
        with self.lock, self.db:
            self.db.execute("INSERT INTO snapshot (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, saved_at = strftime('%s','now')", (json.dumps(snap),))

    def load(self) -> Optional[dict]:
        with self.lock:
            row = self.db.execute("SELECT body FROM snapshot WHERE id = 1").fetchone()
        return json.loads(row[0]) if row else None

    def journal_fill(self, run: int, fill: dict) -> None:
        with self.lock, self.db:
            self.db.execute("INSERT OR IGNORE INTO fills (id, run, body) VALUES (?, ?, ?)", (fill["id"], run, json.dumps(fill)))

    def event(self, kind: str, body: dict) -> None:
        with self.lock, self.db:
            self.db.execute("INSERT INTO events (kind, body) VALUES (?, ?)", (kind, json.dumps(body)))

    def fills(self) -> list[dict]:
        with self.lock:
            return [json.loads(r[0]) for r in self.db.execute("SELECT body FROM fills ORDER BY run, rowid")]

    # ---- users, audit trail, signing secret
    def user_get(self, name: str) -> Optional[dict]:
        with self.lock:
            r = self.db.execute("SELECT name, salt, hash, role FROM users WHERE name = ?", (name,)).fetchone()
        return dict(zip(("name", "salt", "hash", "role"), r)) if r else None

    def user_put(self, name: str, salt: str, hash_: str, role: str) -> None:
        with self.lock, self.db:
            self.db.execute("INSERT INTO users (name, salt, hash, role) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET salt = excluded.salt, hash = excluded.hash, role = excluded.role", (name, salt, hash_, role))

    def user_delete(self, name: str) -> bool:
        with self.lock, self.db:
            return self.db.execute("DELETE FROM users WHERE name = ?", (name,)).rowcount > 0

    def users(self) -> list[dict]:
        with self.lock:
            return [{"name": n, "role": r} for n, r in self.db.execute("SELECT name, role FROM users ORDER BY name")]

    def audit_add(self, t: float, user: str, role: str, method: str, path: str, status: int, detail: str) -> None:
        with self.lock, self.db:
            self.db.execute("INSERT INTO audit (t, user, role, method, path, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)", (t, user, role, method, path, status, detail))

    def audit(self, limit: int = 100) -> list[dict]:
        with self.lock:
            rows = self.db.execute("SELECT n, t, user, role, method, path, status, detail FROM audit ORDER BY n DESC LIMIT ?", (limit,)).fetchall()
        return [dict(zip(("n", "t", "user", "role", "method", "path", "status", "detail"), r)) for r in rows]

    def meta_get(self, k: str) -> Optional[str]:
        with self.lock:
            r = self.db.execute("SELECT v FROM meta WHERE k = ?", (k,)).fetchone()
        return r[0] if r else None

    def meta_put(self, k: str, v: str) -> None:
        with self.lock, self.db:
            self.db.execute("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", (k, v))
