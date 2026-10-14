from __future__ import annotations

import asyncio
import json
import os
import random
from dataclasses import asdict
import time
from pathlib import Path
from typing import Optional

from .engine import Engine
from .feeds import ReplaySource, SyntheticSource, ticks_for
from .live import LiveFeed
from .paper import PaperExchange
from .risk import RiskManager
from .types import Candle, SymbolRules, Tick

H = 3600000
TICKS_PER_BAR = 10
START = 400
SPEEDS = [1, 4, 15, 60]

RULES = [
    SymbolRules("BTC-USD", "BTC", "USD", 0.00001, 0.00000001, 0.01),
    SymbolRules("ETH-USD", "ETH", "USD", 0.001, 0.000001, 0.01),
    SymbolRules("SOL-USD", "SOL", "USD", 0.001, 0.000001, 0.001),
]


def load_candles(path: Optional[Path] = None) -> dict[str, list[Candle]]:
    p = path or Path(os.environ.get("GT_DATA", Path(__file__).parent.parent / "data" / "candles.json"))
    raw = json.loads(p.read_text())["candles"]
    return {s: [Candle(*r[:6]) for r in rows] for s, rows in raw.items()}


class Session:
    """One paper account plus a market feed. The server owns it; clients send commands and read state."""

    def __init__(self, data: Optional[dict[str, list[Candle]]] = None, store=None, notifier=None, feed_client=None,
                 poll_s: float = 5.0, stale_after_s: float = 30.0):
        self.data = data or load_candles()
        self.feed_client = feed_client  # a GeminiReadOnly (or fake) that provides public quotes; None disables live mode
        self.feed: Optional[LiveFeed] = None
        self.poll_s, self.stale_after_s = poll_s, stale_after_s
        self._was_stale = False
        self.journal: dict = {}
        self.store = store
        self.notifier = notifier
        self.run = int(time.time())
        self._last_save = 0.0
        self.mode = "replay"
        self.seed = 1
        self.speed = 4
        self.playing = False
        self.ended = False
        self.symbol = "BTC-USD"
        self._q: list[Tick] = []
        self._acc = 0.0
        self._task: Optional[asyncio.Task] = None
        self.start_marks: dict = {}
        self.version = 0  # bumps on every change so streams can skip idle frames
        if not (store and self._load()):
            self.reset("replay", 1)

    # ---- setup
    @property
    def ex(self) -> PaperExchange:
        return self.eng.ex

    def symbols(self) -> list[str]:
        return [r.symbol for r in RULES]

    def rules(self, sym: Optional[str] = None) -> SymbolRules:
        sym = sym or self.symbol
        return next(r for r in RULES if r.symbol == sym)

    def _build(self, mode: str, seed: int, paper: Optional[dict], risk: Optional[dict]) -> None:
        self.mode, self.seed = mode, seed
        ex = PaperExchange(paper or {}, RULES)
        rm = RiskManager(risk or {}, ex.cfg.starting_cash)
        self.eng = Engine(ex, rm, H)
        self._hook_journal()
        self._hook_alerts()
        syms = self.symbols()
        self.feed = None
        rm.stale_fn = None
        if mode == "live":
            if not self.feed_client:
                raise ValueError("Live prices are not enabled on this server. Start it with GT_LIVE=1.")
            self.src = None
            self.feed = LiveFeed(self.feed_client, syms, self.poll_s, self.stale_after_s)
            rm.stale_fn = self.feed.stale_reason
            self._was_stale = False
            hist = self._live_history()
            inner = ex.on_fill
            ex.on_fill = lambda f: (inner(f), self.feed.record_fill(f))[0]
        elif mode == "replay":
            self.src = ReplaySource(self.data, START)
            hist = self.src.history()
        else:
            last = {s: self.data[s][-1].c for s in syms}
            vols = {s: sorted(c.v for c in self.data[s])[len(self.data[s]) // 2] for s in syms}
            t0 = self.data[syms[0]][-1].t + H
            self.src = SyntheticSource(seed, last, vols, t0, H, 0)
            hist = {s: self.data[s][-START:] for s in syms}
        for s in syms:
            self.eng.seed(s, hist[s])
        self._q, self._acc, self.ended = [], 0.0, False

    def _hook_alerts(self) -> None:
        if not self.notifier or not self.notifier.enabled:
            return
        eng = self.eng
        inner = eng.note

        def note(t, kind, text):
            inner(t, kind, text)
            if kind != "info":
                self.notifier.notify(kind, text)
            if self.store and kind in ("risk", "warn"):
                self.store.event(kind, {"t": t, "text": text})

        eng.note = note

    def _hook_journal(self) -> None:
        if not self.store:
            return
        inner = self.eng.ex.on_fill

        def journal(f):
            inner(f)
            self.store.journal_fill(self.run, asdict(f))

        self.eng.ex.on_fill = journal

    def reset(self, mode: Optional[str] = None, seed: Optional[int] = None, paper: Optional[dict] = None,
              risk: Optional[dict] = None) -> None:
        """Fresh account. Cost and risk settings carry over unless new ones are given."""
        mode = mode or self.mode
        if mode not in ("replay", "synthetic", "live"):
            raise ValueError("mode must be replay, synthetic or live")
        old = getattr(self, "eng", None)
        self.pause()
        paper = paper if paper is not None else (asdict(old.ex.cfg) if old else None)
        risk = risk if risk is not None else (asdict(old.risk.limits) if old else None)
        self._build(mode, seed if seed is not None else random.randint(1, 999999), paper, risk)
        self.eng.risk.reset(self.eng.ex.cfg.starting_cash)
        self.run = int(time.time() * 1000)
        self.journal = {}
        label = "replay of real Gemini hourly candles" if mode == "replay" else f"synthetic market, seed {self.seed}"
        self.eng.note(0, "info", f"New {label}.")
        if mode == "live":
            self._live_poll()
        else:
            self._fill_queue()
            self._process(len(self.symbols()))
        self.start_marks = dict(self.ex.marks)
        self.version += 1
        self.save(True)

    # ---- persistence
    def save(self, force: bool = False) -> None:
        if not self.store:
            return
        now = time.time()
        if not force and now - self._last_save < 3:
            return
        self._last_save = now
        resume = 0 if self.mode == "live" else self.src.index - (1 if self._q else 0)
        self.store.save({"v": 1, "mode": self.mode, "seed": self.seed, "speed": self.speed, "symbol": self.symbol,
                         "resume": resume, "run": self.run, "journal": self.journal, "start_marks": self.start_marks, "eng": self.eng.snapshot()})

    def _load(self) -> bool:
        s = self.store.load()
        if not s or s.get("v") != 1:
            return False
        try:
            eng = s["eng"]
            if s["mode"] == "live" and not self.feed_client:
                return False  # saved from a live run but this server has no live feed; start fresh
            self._build(s["mode"], s["seed"], eng["ex"]["cfg"], eng["risk"]["limits"])
            syms = self.symbols()
            if s["mode"] == "live":
                self.eng.restore(eng)
                self.speed, self.symbol, self.run = s["speed"], s["symbol"], s.get("run", self.run)
                self.eng.note(self.ex.now, "info", "Session restored from disk. Live prices resume when you press Play.")
                self.start_marks = s.get("start_marks") or {}
                self.journal = dict(s.get("journal") or {})
                return True
            bars = {x: [] for x in syms}
            while self.src.index < s["resume"]:
                b = self.src.next()
                if b is None:
                    break
                for x in syms:
                    bars[x].append(b[x])
            hist = self.src.history() if self.mode == "replay" else {x: self.data[x][-START:] for x in syms}
            for x in syms:
                self.eng.seed(x, list(hist[x]) + bars[x])
            self.eng.restore(eng)
            self.speed, self.symbol, self.run = s["speed"], s["symbol"], s.get("run", self.run)
            self.eng.note(self.ex.now, "info", "Session restored from disk. Playback is paused.")
            self._fill_queue()
            self._process(len(self.symbols()))
            self.start_marks = s.get("start_marks") or dict(self.ex.marks)
            self.journal = dict(s.get("journal") or {})
            return True
        except Exception:
            return False

    # ---- playback
    def _fill_queue(self) -> bool:
        bars = self.src.next()
        if bars is None:
            self.ended = True
            return False
        lists = [ticks_for(s, bars[s], TICKS_PER_BAR, H) for s in self.symbols()]
        self._q = [lst[i] for i in range(TICKS_PER_BAR) for lst in lists]
        return True

    def _process(self, n: int) -> None:
        for _ in range(n):
            if not self._q:
                if not self._fill_queue():
                    self.playing = False
                    self.eng.note(self.ex.now, "info", "End of the data. Reset to run again.")
                    break
            self.eng.tick(self._q.pop(0))
        self.version += 1

    def step_bar(self) -> None:
        if self.mode == "live":
            raise ValueError("Live prices cannot be stepped. They move in real time.")
        self.pause()
        self._process(len(self._q) or TICKS_PER_BAR)

    def set_speed(self, s: int) -> None:
        if s not in SPEEDS:
            raise ValueError(f"speed must be one of {SPEEDS}")
        self.speed = s
        self.version += 1

    def play(self) -> None:
        if self.playing or self.ended:
            return
        self.playing = True
        self.version += 1
        try:
            self._task = asyncio.get_running_loop().create_task(self._run())
        except RuntimeError:
            self._task = None  # no loop (tests drive frames by hand)

    def pause(self) -> None:
        was = self.playing
        self.save(True) if hasattr(self, 'eng') else None
        self.playing = False
        if self._task:
            self._task.cancel()
            self._task = None
        if was:
            self.version += 1

    # ---- live prices
    def _live_history(self) -> dict[str, list[Candle]]:
        """Recent real hourly candles to warm up indicators. Falls back to the bundled data if the request fails."""
        out = {}
        now_bucket = int(time.time() * 1000) // H * H
        for s in self.symbols():
            try:
                rows = [r for r in self.feed_client.candles(s) if r[0] < now_bucket]
                cs = [Candle(int(r[0]), r[1], r[2], r[3], r[4], r[5]) for r in rows][-START:]
                if len(cs) < 50:
                    raise ValueError("too few candles")
                out[s] = cs
            except Exception as e:
                self.feed.last_error = f"history {s}: {e}"
                out[s] = self.data[s][-START:]
        return out

    def _watch(self) -> None:
        """Announces when live data goes stale or recovers. Buys are blocked while stale (see RiskManager.stale_fn)."""
        r = self.feed.stale_reason() if self.feed else None
        if bool(r) != self._was_stale:
            self._was_stale = bool(r)
            self.eng.note(self.ex.now, "risk" if r else "info",
                          f"{r}. New buys are paused until quotes resume." if r else "Market data is flowing again. Buying is allowed.")
            self.version += 1

    def _live_poll(self) -> None:
        for tk in self.feed.poll_once():
            self.eng.tick(tk)
        self._watch()
        self.version += 1

    async def _run_live(self) -> None:
        while self.playing:
            ticks = await asyncio.to_thread(self.feed.poll_once)
            for tk in ticks:
                self.eng.tick(tk)
            self._watch()
            self.version += 1
            self.save()
            await asyncio.sleep(self.poll_s)

    async def _run(self) -> None:
        if self.mode == "live":
            return await self._run_live()
        while self.playing:
            self.frame()
            await asyncio.sleep(0.05)

    def frame(self) -> None:
        self._acc += self.speed * TICKS_PER_BAR * 0.05
        n = int(self._acc)
        self._acc -= n
        if n > 0:
            self._process(n)
        self.save()

    # ---- serialisation for the API
    def state(self, tail: int = 60) -> dict:
        ex, eng, rk = self.ex, self.eng, self.eng.risk
        eq = ex.equity()
        return {
            "version": self.version, "mode": self.mode, "seed": self.seed, "playing": self.playing, "ended": self.ended,
            "speed": self.speed, "speeds": SPEEDS, "symbol": self.symbol, "symbols": self.symbols(), "time": ex.now,
            "exchange": {"name": ex.name, "live": ex.live},
            "account": {
                "equity": eq, "cash": ex.cash, "availableCash": ex.available_cash(), "startingCash": ex.cfg.starting_cash,
                "unrealized": ex.unrealized(), "realized": ex.realized, "feesPaid": ex.fees_paid,
                "dayPnlPct": rk.day_pnl_pct(eq), "drawdownPct": rk.drawdown_pct(eq),
            },
            "marks": ex.marks,
            "positions": [asdict(p) for p in ex.positions.values()],
            "orders": [asdict(o) for o in ex.open_orders()],
            "fills": [asdict(f) for f in ex.fills[-tail:]],
            "bots": [{"cfg": asdict(b.cfg), "st": asdict(b.st)} for b in eng.bots],
            "risk": {"limits": asdict(rk.limits), "killed": rk.s.killed, "blocked": rk.blocked()},
            "config": {"paper": asdict(ex.cfg)},
            "log": eng.log[-tail:],
            "equityLog": eng.equity_log[-600:],
            "snapshot": ex.snapshot(200),
            "riskState": asdict(rk.s),
            "startMarks": self.start_marks,
            "journal": self.journal,
            "feed": self._feed_state(),
        }

    def _feed_state(self) -> Optional[dict]:
        if not self.feed:
            return None
        self._watch()
        return self.feed.status()

    def calibration(self) -> dict:
        if not self.feed:
            raise ValueError("Calibration needs live prices. Start a live session first.")
        return self.feed.calibration(self.ex.cfg.spread_bps)

    def set_journal(self, fill_id: str, tag: str, note: str) -> None:
        """Attach a short tag and note to a fill. Empty tag and note remove the entry."""
        if not any(f.id == fill_id for f in self.ex.fills):
            raise KeyError("Unknown fill")
        tag, note = str(tag or "").strip()[:24], str(note or "").strip()[:500]
        if tag or note:
            self.journal[fill_id] = {"tag": tag, "note": note}
        else:
            self.journal.pop(fill_id, None)
        self.version += 1
        self.save()

    def candles(self, symbol: str, limit: int = 300) -> list[dict]:
        s = list(self.eng.series[symbol])
        cur = self.eng.cur.get(symbol)
        if cur:
            s.append(cur)
        return [asdict(c) for c in s[-limit:]]
