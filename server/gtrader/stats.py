"""Session statistics from fills and the equity curve. Mirrors src/core/stats.ts (parity-tested)."""
from __future__ import annotations

from typing import Optional


def _mean(a: list[float]) -> Optional[float]:
    return sum(a) / len(a) if a else None


def _group(fills: list, key) -> list[dict]:
    m: dict = {}
    for f in fills:
        g = m.setdefault(key(f), {"trades": 0, "wins": 0, "realized": 0.0, "fees": 0.0})
        g["fees"] += f.fee
        if f.side == "sell":
            g["trades"] += 1
            g["realized"] += f.realized
            if f.realized > 0:
                g["wins"] += 1
    out = [{"key": k, "trades": g["trades"], "realized": g["realized"], "fees": g["fees"],
            "winRatePct": g["wins"] / g["trades"] * 100 if g["trades"] else None} for k, g in m.items()]
    return sorted(out, key=lambda x: (-x["realized"], x["key"]))


def compute_stats(fills: list, equity_log: list[dict], start_cash: float, equity: float) -> dict:
    sells = [f for f in fills if f.side == "sell"]
    wins = [f.realized for f in sells if f.realized > 0]
    losses = [-f.realized for f in sells if f.realized < 0]
    gw, gl = sum(wins), sum(losses)
    peak, dd = start_cash, 0.0
    for p in [x["e"] for x in equity_log] + [equity]:
        peak = max(peak, p)
        dd = max(dd, (peak - p) / peak)
    rs = [f.realized for f in sells]
    return {
        "startCash": start_cash, "equity": equity, "returnPct": (equity / start_cash - 1) * 100,
        "maxDrawdownPct": dd * 100, "feesPaid": sum(f.fee for f in fills), "realized": sum(rs),
        "trades": len(sells), "wins": len(wins), "losses": len(losses),
        "winRatePct": len(wins) / len(sells) * 100 if sells else None,
        "avgWin": _mean(wins), "avgLoss": _mean(losses), "expectancy": _mean(rs),
        "profitFactor": gw / gl if gl > 0 else None,
        "best": max(rs) if rs else None, "worst": min(rs) if rs else None,
        "bySource": _group(fills, lambda f: f.source), "bySymbol": _group(fills, lambda f: f.symbol),
    }
