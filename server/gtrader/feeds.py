from __future__ import annotations

import math
from typing import Optional

from .types import Candle, Tick
from .util import gauss, mulberry32


def candle_path(c: Candle, n: int) -> list[float]:
    """Price path inside a candle. Bullish bars dip to the low first, bearish bars spike to the high first."""
    v = [c.o, c.l, c.h, c.c] if c.c >= c.o else [c.o, c.h, c.l, c.c]
    out = []
    for i in range(n):
        u = 0 if n == 1 else (i / (n - 1)) * 3
        k = min(2, math.floor(u + 1e-9))
        out.append(v[k] + (v[k + 1] - v[k]) * (u - k))
    out[0] = c.o
    out[n - 1] = c.c
    return out


def ticks_for(symbol: str, c: Candle, n: int, candle_ms: int) -> list[Tick]:
    return [Tick(symbol, c.t + math.floor((i / n) * candle_ms), p, c.v) for i, p in enumerate(candle_path(c, n))]


class ReplaySource:
    def __init__(self, data: dict[str, list[Candle]], start: int):
        self.data, self.start = data, start
        self.symbols = list(data)
        self.index = start

    def history(self) -> dict[str, list[Candle]]:
        return {s: self.data[s][: self.start] for s in self.symbols}

    def next(self) -> Optional[dict[str, Candle]]:
        out = {}
        for s in self.symbols:
            if self.index >= len(self.data[s]):
                return None
            out[s] = self.data[s][self.index]
        self.index += 1
        return out

    def remaining(self) -> int:
        return len(self.data[self.symbols[0]]) - self.index


REGIMES = [(0.0004, 0.006), (-0.0005, 0.009), (0.0, 0.004)]  # grind up, sell-off, chop


class SyntheticSource:
    """Seeded regime-switching random market. Same seed, same market."""

    def __init__(self, seed: int, start_prices: dict, base_vol: dict, start_t: int, candle_ms: int, warmup: int = 0):
        self.symbols = list(start_prices)
        self.rng = mulberry32(seed)
        self.px = dict(start_prices)
        self.base_vol = base_vol
        self.t = start_t
        self.candle_ms = candle_ms
        self.regime = 2
        self.hist: dict[str, list[Candle]] = {s: [] for s in self.symbols}
        for _ in range(warmup):
            b = self._gen()
            for s in self.symbols:
                self.hist[s].append(b[s])
        self.index = 0

    def history(self):
        return self.hist

    def _gen(self) -> dict[str, Candle]:
        r = self.rng
        if r() < 0.02:
            self.regime = math.floor(r() * len(REGIMES))
        mu, sigma = REGIMES[self.regime]
        zm = gauss(r)
        out = {}
        for s in self.symbols:
            z = 0.6 * zm + 0.8 * gauss(r)
            o = self.px[s]
            c = o * math.exp(mu - 0.5 * sigma ** 2 + sigma * z)
            wick = lambda x: abs(gauss(r)) * sigma * 0.45 * x
            h = max(o, c) * (1 + wick(1))
            l = min(o, c) * (1 - wick(1))
            v = self.base_vol[s] * math.exp(0.4 * gauss(r)) * (1 + abs(z) * 0.5)
            out[s] = Candle(self.t, o, h, l, c, v)
            self.px[s] = c
        self.t += self.candle_ms
        return out

    def next(self):
        self.index += 1
        return self._gen()
