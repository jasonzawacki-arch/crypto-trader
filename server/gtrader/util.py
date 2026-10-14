import math


def decimals(step: float) -> int:
    s = repr(float(step)) if not isinstance(step, int) else str(step)
    if "e-" in s:
        return int(s.split("e-")[1])
    i = s.find(".")
    if i < 0:
        return 0
    t = s[i + 1:]
    return 0 if t == "0" else len(t)


def js_round(x: float) -> float:
    """Math.round semantics (halves go up), unlike Python's banker's rounding."""
    return math.floor(x + 0.5)


def floor_to(x: float, step: float) -> float:
    return float(f"{math.floor(x / step + 1e-9) * step:.{decimals(step)}f}")


def round_to(x: float, step: float) -> float:
    return float(f"{js_round(x / step) * step:.{decimals(step)}f}")


def mulberry32(seed: int):
    a = seed & 0xFFFFFFFF

    def imul(x, y):
        return (x * y) & 0xFFFFFFFF

    def nxt() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = imul(t ^ (t >> 15), t | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        t &= 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return nxt


def gauss(r) -> float:
    u = 0.0
    while u == 0:
        u = r()
    return math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * r())
