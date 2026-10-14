from .indicators import atr, highest, lowest, rsi, sma, stdev
from .types import ParamDef, Signal, Strategy, StrategyContext

HOLD = Signal("hold")


def _closes(ctx: StrategyContext) -> list[float]:
    return [x.c for x in ctx.candles]


def _sma_cross(p: dict, ctx: StrategyContext) -> Signal:
    c = _closes(ctx)
    n = len(c)
    f1, s1 = sma(c, int(p["fast"]), n), sma(c, int(p["slow"]), n)
    f0, s0 = sma(c, int(p["fast"]), n - 1), sma(c, int(p["slow"]), n - 1)
    if None in (f1, s1, f0, s0):
        return HOLD
    if not ctx.in_position and f0 <= s0 and f1 > s1:
        return Signal("buy", f"fast {f1:.2f} crossed above slow {s1:.2f}")
    if ctx.in_position and f0 >= s0 and f1 < s1:
        return Signal("sell", f"fast {f1:.2f} crossed below slow {s1:.2f}")
    return HOLD


def _rsi_revert(p: dict, ctx: StrategyContext) -> Signal:
    r = rsi(_closes(ctx), int(p["period"]))
    if r is None:
        return HOLD
    if not ctx.in_position and r < p["buyBelow"]:
        return Signal("buy", f"RSI {r:.1f} below {p['buyBelow']:g}")
    if ctx.in_position and r > p["sellAbove"]:
        return Signal("sell", f"RSI {r:.1f} above {p['sellAbove']:g}")
    return HOLD


def _donchian(p: dict, ctx: StrategyContext) -> Signal:
    hi = [x.h for x in ctx.candles]
    lo = [x.l for x in ctx.candles]
    n = len(ctx.candles)
    last = ctx.candles[-1]
    hh = highest(hi, int(p["entry"]), n - 1)
    ll = lowest(lo, int(p["exit"]), n - 1)
    if hh is None or ll is None:
        return HOLD
    if not ctx.in_position and last.c > hh:
        return Signal("buy", f"closed above {p['entry']:g}-candle high {hh:.2f}")
    if ctx.in_position and last.c < ll:
        return Signal("sell", f"closed below {p['exit']:g}-candle low {ll:.2f}")
    return HOLD


def _atr_break(p: dict, ctx: StrategyContext) -> Signal:
    c = _closes(ctx)
    n = len(c)
    m, a = sma(c, int(p["period"]), n), atr(ctx.candles, int(p["period"]), n)
    if m is None or a is None:
        return HOLD
    last = c[n - 1]
    if not ctx.in_position and last > m + p["mult"] * a:
        return Signal("buy", f"close {last:.2f} is {p['mult']:g} ranges above its {p['period']:g}-candle average {m:.2f}")
    if ctx.in_position and last < m:
        return Signal("sell", f"close {last:.2f} fell under its average {m:.2f}")
    return HOLD


def _bollinger(p: dict, ctx: StrategyContext) -> Signal:
    c = _closes(ctx)
    n = len(c)
    m, sd = sma(c, int(p["period"]), n), stdev(c, int(p["period"]), n)
    if m is None or sd is None:
        return HOLD
    last = c[n - 1]
    if not ctx.in_position and last < m - p["k"] * sd:
        return Signal("buy", f"close {last:.2f} below the lower band {m - p['k'] * sd:.2f}")
    if ctx.in_position and last > m:
        return Signal("sell", f"close {last:.2f} back above the average {m:.2f}")
    return HOLD


def _dca(p: dict, ctx: StrategyContext) -> Signal:
    t = ctx.candles[-1].t
    return Signal("buy", f"scheduled purchase (every {p['every']:g} candles)") if (t // 3600000) % int(p["every"]) == 0 else HOLD


def _buy_hold(p: dict, ctx: StrategyContext) -> Signal:
    return HOLD if ctx.in_position else Signal("buy", "initial purchase")


STRATEGIES: list[Strategy] = [
    Strategy(
        "sma-cross", "Trend cross",
        "Buys when the fast average crosses above the slow one and sells when it crosses back.",
        [ParamDef("fast", "Fast average (candles)", 2, 100, 1, 12), ParamDef("slow", "Slow average (candles)", 5, 300, 1, 48)],
        lambda p: int(max(p["fast"], p["slow"])) + 2, _sma_cross,
    ),
    Strategy(
        "rsi-revert", "Dip buyer",
        "Buys when RSI is oversold and sells once it recovers. Works in ranges, struggles in steady downtrends.",
        [ParamDef("period", "RSI period (candles)", 2, 50, 1, 14), ParamDef("buyBelow", "Buy below RSI", 5, 50, 1, 30), ParamDef("sellAbove", "Sell above RSI", 40, 95, 1, 55)],
        lambda p: int(p["period"]) + 3, _rsi_revert,
    ),
    Strategy(
        "donchian", "Breakout",
        "Buys a new high over the entry window and exits on a new low over the shorter exit window.",
        [ParamDef("entry", "Entry window (candles)", 5, 300, 1, 48), ParamDef("exit", "Exit window (candles)", 3, 150, 1, 24)],
        lambda p: int(max(p["entry"], p["exit"])) + 2, _donchian,
    ),
    Strategy(
        "atr-break", "Volatility breakout",
        "Buys when price jumps more than a set number of average daily-ranges above its recent average, and sells when it falls back under that average. Few trades, big moves.",
        [ParamDef("period", "Window (candles)", 5, 200, 1, 24), ParamDef("mult", "Jump size (x average range)", 0.5, 5, 0.1, 1.5)],
        lambda p: int(p["period"]) + 2, _atr_break,
    ),
    Strategy(
        "bollinger", "Band bounce",
        "Buys when price drops well below its recent average (a stretched dip) and sells when it returns to the average. Like the dip buyer, it struggles when prices keep falling.",
        [ParamDef("period", "Window (candles)", 5, 200, 1, 20), ParamDef("k", "Band width (std. deviations)", 0.5, 4, 0.1, 2)],
        lambda p: int(p["period"]) + 2, _bollinger,
    ),
    Strategy(
        "dca", "Steady buyer (DCA)",
        "Buys the same slice of your equity every set number of candles, and never sells. Spreads the entry over time. It ignores the stop setting, and your position-size limit caps how much it can build.",
        [ParamDef("every", "Buy every (candles)", 1, 720, 1, 24)], lambda p: 1, _dca, accumulate=True,
    ),
    Strategy(
        "buy-hold", "Buy and hold",
        "Buys once and never sells. The baseline every other bot has to beat after costs. If a protective stop sells it, it buys again on the next bar.",
        [], lambda p: 1, _buy_hold,
    ),
]


def strategy_by_id(sid: str) -> Strategy:
    for s in STRATEGIES:
        if s.id == sid:
            return s
    raise KeyError("Unknown strategy " + sid)


def default_params(s: Strategy) -> dict:
    return {p.key: p.default for p in s.params}
