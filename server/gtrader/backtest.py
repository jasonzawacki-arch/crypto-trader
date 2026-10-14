from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Optional

from .engine import Engine
from .feeds import ticks_for
from .paper import PaperExchange
from .risk import RiskManager
from .strategies import strategy_by_id
from .util import js_round
from .types import Candle, SymbolRules


@dataclass
class BacktestOptions:
    symbol: str
    rules: SymbolRules
    candles: list[Candle]
    candle_ms: int
    strategy_id: str
    params: dict
    alloc_pct: float
    stop_pct: float
    paper: Optional[dict] = None
    risk: Optional[dict] = None


def run_backtest(o: BacktestOptions) -> dict:
    """Runs a strategy through the same engine, exchange and risk code the live session uses."""
    ex = PaperExchange(o.paper or {}, [o.rules])
    risk = RiskManager(o.risk or {}, ex.cfg.starting_cash)
    eng = Engine(ex, risk, o.candle_ms, 100000)
    eng.add_bot(o.strategy_id, o.symbol, params=o.params, alloc_pct=o.alloc_pct, stop_pct=o.stop_pct, enabled=True)
    equity, in_pos = [], 0
    for c in o.candles:
        for tk in ticks_for(o.symbol, c, 4, o.candle_ms):
            eng.tick(tk)
        equity.append({"t": c.t, "e": ex.equity()})
        if o.symbol in ex.positions:
            in_pos += 1
    first, last = o.candles[0], o.candles[-1]
    start = ex.cfg.starting_cash
    hold = [{"t": c.t, "e": start * c.c / first.o} for c in o.candles]
    sells = [f for f in ex.fills if f.side == "sell"]
    wins = [f for f in sells if f.realized > 0]
    gw = sum(f.realized for f in wins)
    gl = sum(-f.realized for f in sells if f.realized < 0)
    per = (365 * 24 * 3600 * 1000) / o.candle_ms
    rets = [equity[i]["e"] / equity[i - 1]["e"] - 1 for i in range(1, len(equity))]
    mean = sum(rets) / (len(rets) or 1)
    sd = math.sqrt(sum((x - mean) ** 2 for x in rets) / (len(rets) or 1))
    peak, mdd = start, 0.0
    for p in equity:
        peak = max(peak, p["e"])
        mdd = max(mdd, (peak - p["e"]) / peak)
    end = equity[-1]["e"] if equity else start
    m = {
        "startEquity": start, "endEquity": end, "returnPct": (end / start - 1) * 100,
        "buyHoldPct": (last.c / first.o - 1) * 100, "maxDrawdownPct": mdd * 100,
        "sharpe": (mean / sd) * math.sqrt(per) if sd > 0 else 0.0, "trades": len(sells),
        "winRatePct": len(wins) / len(sells) * 100 if sells else None,
        "profitFactor": gw / gl if gl > 0 else None,
        "exposurePct": in_pos / (len(o.candles) or 1) * 100, "feesPaid": ex.fees_paid, "candles": len(o.candles),
    }
    warnings = []
    days = len(o.candles) * o.candle_ms / 86400000
    if m["trades"] < 30:
        warnings.append(f"Only {m['trades']} closed trades. That is too few to tell skill from luck.")
    if days < 90:
        warnings.append(f"Only {days:.0f} days of data. One market regime can flatter any strategy.")
    if m["trades"] == 0:
        warnings.append("The strategy never traded in this window.")
    return {"metrics": m, "equity": equity, "hold": hold, "fills": ex.fills, "warnings": warnings}


def run_split(o: BacktestOptions, train_frac: float = 0.6) -> dict:
    from dataclasses import replace
    k = math.floor(len(o.candles) * train_frac)
    return {
        "train": run_backtest(replace(o, candles=o.candles[:k])),
        "test": run_backtest(replace(o, candles=o.candles[k:])),
        "splitAt": o.candles[k].t if k < len(o.candles) else 0,
    }


def _row(kind: str, label: str, r: dict) -> dict:
    m = r["metrics"]
    return {"kind": kind, "label": label, "returnPct": m["returnPct"], "buyHoldPct": m["buyHoldPct"],
            "maxDrawdownPct": m["maxDrawdownPct"], "trades": m["trades"]}


def _num(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else ("%.6f" % v).rstrip("0").rstrip(".")


def run_sweep(o: BacktestOptions, windows: int = 4) -> dict:
    """What-if runs: history slices, settings nudged ~20-25 percent, and doubled trading costs."""
    rows: list = []
    base = run_backtest(o)
    n = len(o.candles)
    wr: list = []
    for w in range(windows):
        a, b = n * w // windows, n * (w + 1) // windows
        if b - a < 20:
            continue
        r = run_backtest(replace(o, candles=o.candles[a:b]))
        wr.append(r["metrics"]["returnPct"])
        rows.append(_row("window", f"Slice {w + 1} of {windows}", r))
    strat = strategy_by_id(o.strategy_id)
    pr: list = []
    for p in strat.params:
        for name, k in (("-20%", 0.8), ("+25%", 1.25)):
            cur = o.params.get(p.key, p.default)
            v = js_round(cur * k / p.step) * p.step
            v = min(p.max, max(p.min, v))
            if v == cur:
                continue
            r = run_backtest(replace(o, params={**o.params, p.key: v}))
            pr.append(r["metrics"]["returnPct"])
            rows.append(_row("param", f"{p.label} {name} ({_num(v)})", r))
    from .paper import PaperConfig
    cfg = PaperConfig(**(o.paper or {}))
    doubled = base["metrics"]["returnPct"]
    for k in (2, 3):
        paper = {**(o.paper or {}), "taker_bps": cfg.taker_bps * k, "maker_bps": cfg.maker_bps * k, "spread_bps": cfg.spread_bps * k}
        r = run_backtest(replace(o, paper=paper))
        if k == 2:
            doubled = r["metrics"]["returnPct"]
        rows.append(_row("cost", f"Fees and spread x{k}", r))
    srt = sorted(wr)
    if srt:
        med = srt[(len(srt) - 1) // 2] if len(srt) % 2 else (srt[len(srt) // 2 - 1] + srt[len(srt) // 2]) / 2
    else:
        med = 0.0
    allr = [base["metrics"]["returnPct"], *pr]
    s = {"windows": len(wr), "windowsProfitable": sum(1 for x in wr if x > 0),
         "worstWindowPct": srt[0] if srt else 0.0, "medianWindowPct": med,
         "paramBestPct": max(allr), "paramWorstPct": min(allr),
         "baseReturnPct": base["metrics"]["returnPct"], "costDoubledPct": doubled, "verdict": []}
    v = s["verdict"]
    if s["windows"] and s["windowsProfitable"] < math.ceil(s["windows"] / 2):
        v.append(f"Lost money in {s['windows'] - s['windowsProfitable']} of {s['windows']} slices of history. It works only in some conditions.")
    if s["paramWorstPct"] < 0 and s["baseReturnPct"] > 0:
        v.append("A small nudge to one setting turns it into a loser. The good result may be a lucky setting.")
    if s["baseReturnPct"] > 0 and s["costDoubledPct"] <= 0:
        v.append("Profit disappears when fees and spread double. The edge is thinner than the costs.")
    if s["baseReturnPct"] <= 0:
        v.insert(0, "It lost money (or made nothing) over the full history with these settings.")
    if not v:
        v.append("No red flags in these runs. That still does not promise future profit.")
    return {"rows": rows, "summary": s}
