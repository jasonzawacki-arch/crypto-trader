"""Live market prices for paper trading. Real Gemini quotes, simulated money: nothing here can place a real order.

LiveFeed polls the public ticker. It tracks how old each quote is so the server can pause new buys when the data goes
stale, and it keeps spread samples and paper-fill comparisons so you can see how the simulated costs stack up against
the real market. Written against Gemini's public REST docs and unit-tested with a fake client; it has not been run
against the live service from the build sandbox.
"""
from __future__ import annotations

import time
from collections import deque
from typing import Callable, Optional

from .types import Tick


def _bps(x: float) -> float:
    return x * 1e4


class LiveFeed:
    def __init__(self, client, symbols: list[str], poll_s: float = 5.0, stale_after_s: float = 30.0,
                 clock: Callable[[], float] = time.time):
        self.client, self.symbols = client, list(symbols)
        self.poll_s, self.stale_after_s, self.clock = poll_s, stale_after_s, clock
        self.quotes: dict[str, dict] = {}
        self.last_ok: dict[str, float] = {}
        self.last_error: Optional[str] = None
        self.errors = 0
        self.started = clock()
        self.spreads: dict[str, deque] = {s: deque(maxlen=2000) for s in symbols}
        self.fills: deque = deque(maxlen=300)  # paper fills compared with the live quote at that moment

    # ---- polling
    def poll_once(self) -> list[Tick]:
        """Fetches every symbol. A failure on one symbol is recorded and does not stop the others."""
        out: list[Tick] = []
        for s in self.symbols:
            try:
                q = self.client.ticker(s)
                px = q["last"] if q["last"] > 0 else (q["bid"] + q["ask"]) / 2
                if px <= 0 or q["ask"] < q["bid"]:
                    raise ValueError("implausible quote")
            except Exception as e:  # network, bad JSON, unexpected shape
                self.errors += 1
                self.last_error = f"{s}: {e}"
                continue
            now = self.clock()
            self.quotes[s] = {**q, "at": now}
            self.last_ok[s] = now
            mid = (q["bid"] + q["ask"]) / 2
            if mid > 0:
                self.spreads[s].append(_bps((q["ask"] - q["bid"]) / mid))
            hourly = q.get("vol24", 0.0) / 24  # an average hour; the ticker has no per-bar volume
            out.append(Tick(s, int(now * 1000), px, hourly))
        return out

    # ---- freshness
    def age(self, symbol: str) -> Optional[float]:
        t = self.last_ok.get(symbol)
        return None if t is None else self.clock() - t

    def stale_symbols(self) -> list[str]:
        out = []
        for s in self.symbols:
            a = self.age(s)
            if a is None:
                if self.clock() - self.started > self.stale_after_s:
                    out.append(s)
            elif a > self.stale_after_s:
                out.append(s)
        return out

    def stale_reason(self) -> Optional[str]:
        st = self.stale_symbols()
        if not st:
            return None
        ages = [self.age(s) for s in st]
        worst = max((a for a in ages if a is not None), default=None)
        how = f"no update for {worst:.0f}s" if worst is not None else "no quotes received yet"
        return f"Market data is stale ({', '.join(x.split('-')[0] for x in st)}: {how})"

    # ---- paper vs live
    def record_fill(self, fill) -> None:
        q = self.quotes.get(fill.symbol)
        if not q:
            return
        mid = (q["bid"] + q["ask"]) / 2
        if mid <= 0:
            return
        cost = (fill.price - mid) / mid if fill.side == "buy" else (mid - fill.price) / mid
        self.fills.append({"t": fill.t, "symbol": fill.symbol, "side": fill.side, "maker": fill.maker, "paperPrice": fill.price,
                           "bid": q["bid"], "ask": q["ask"], "mid": mid, "costBps": _bps(cost),
                           "liveHalfSpreadBps": _bps((q["ask"] - q["bid"]) / 2 / mid)})

    def calibration(self, model_spread_bps: float) -> dict:
        """Compares what paper fills paid against what the real quote would have charged for crossing the spread."""
        takers = [f for f in self.fills if not f["maker"]]
        def avg(xs):
            return sum(xs) / len(xs) if xs else None
        spreads = {}
        for s, d in self.spreads.items():
            if d:
                srt = sorted(d)
                spreads[s] = {"samples": len(d), "meanBps": sum(d) / len(d), "medianBps": srt[len(srt) // 2],
                              "p90Bps": srt[min(len(srt) - 1, int(len(srt) * 0.9))]}
        paid = avg([f["costBps"] for f in takers])
        live_half = avg([f["liveHalfSpreadBps"] for f in takers])
        notes = []
        if len(takers) < 10:
            notes.append(f"Only {len(takers)} market-style fills so far. Treat these averages as a rough guide.")
        if paid is not None and live_half is not None:
            if paid + 0.5 < live_half:
                notes.append(f"Paper fills paid {paid:.1f} bps from mid on average but the live quote charged {live_half:.1f} bps for crossing the spread. Paper is too optimistic, so raise the spread setting.")
            else:
                notes.append(f"Paper fills paid {paid:.1f} bps from mid, at least the {live_half:.1f} bps the live quote charges for crossing the spread.")
        notes.append("This compares costs against quotes only. Real fills can also move the price and miss orders entirely, which only real trading reveals.")
        return {"takerFills": len(takers), "paperCostBps": paid, "liveHalfSpreadBps": live_half,
                "modelSpreadBps": model_spread_bps, "spreads": spreads, "notes": notes, "recent": list(self.fills)[-20:]}

    def status(self) -> dict:
        return {"symbols": {s: {"ageS": self.age(s), "bid": (self.quotes.get(s) or {}).get("bid"), "ask": (self.quotes.get(s) or {}).get("ask"),
                                "last": (self.quotes.get(s) or {}).get("last")} for s in self.symbols},
                "stale": self.stale_reason(), "pollS": self.poll_s, "staleAfterS": self.stale_after_s,
                "errors": self.errors, "lastError": self.last_error}
