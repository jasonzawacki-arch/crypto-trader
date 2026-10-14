from typing import Optional


def sma(v: list[float], n: int, end: Optional[int] = None) -> Optional[float]:
    end = len(v) if end is None else end
    if n <= 0 or end < n:
        return None
    return sum(v[end - n:end]) / n


def rsi(closes: list[float], n: int) -> Optional[float]:
    """Wilder RSI; None until n+1 closes exist."""
    if len(closes) < n + 1:
        return None
    g = l = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        if d >= 0:
            g += d
        else:
            l -= d
    g /= n
    l /= n
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        g = (g * (n - 1) + (d if d > 0 else 0)) / n
        l = (l * (n - 1) + (-d if d < 0 else 0)) / n
    if l == 0:
        return 50.0 if g == 0 else 100.0
    return 100 - 100 / (1 + g / l)


def atr(c: list, n: int, end: Optional[int] = None) -> Optional[float]:
    """Mean of the last n true ranges (needs n+1 candles). Plain loops so results match the TypeScript bit for bit."""
    end = len(c) if end is None else end
    if end < n + 1:
        return None
    s = 0.0
    for i in range(end - n, end):
        s += max(c[i].h - c[i].l, abs(c[i].h - c[i - 1].c), abs(c[i].l - c[i - 1].c))
    return s / n


def stdev(v: list[float], n: int, end: Optional[int] = None) -> Optional[float]:
    end = len(v) if end is None else end
    if end < n or n <= 0:
        return None
    m = 0.0
    for i in range(end - n, end):
        m += v[i]
    m /= n
    q = 0.0
    for i in range(end - n, end):
        q += (v[i] - m) * (v[i] - m)
    return (q / n) ** 0.5


def highest(v: list[float], n: int, end: Optional[int] = None) -> Optional[float]:
    end = len(v) if end is None else end
    return None if end < n else max(v[end - n:end])


def lowest(v: list[float], n: int, end: Optional[int] = None) -> Optional[float]:
    end = len(v) if end is None else end
    return None if end < n else min(v[end - n:end])
