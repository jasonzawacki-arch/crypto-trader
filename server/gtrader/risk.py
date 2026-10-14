from __future__ import annotations

from dataclasses import dataclass, asdict, field
from typing import Optional

from .types import OrderRequest

DAY = 86400000


@dataclass
class RiskLimits:
    max_order_pct: float = 25  # largest single buy, % of equity
    max_position_pct: float = 40  # largest holding in one symbol, % of equity
    max_daily_loss_pct: float = 3  # halts new buys for the rest of the day
    max_drawdown_pct: float = 15  # halts new buys until reset
    min_notional: float = 10  # smallest order value, quote currency


@dataclass
class RiskState:
    killed: bool = False
    halt_reason: Optional[str] = None
    day: int = -1
    day_start_equity: float = 0.0
    peak: float = 0.0


class RiskManager:
    """Pre-trade checks. Sells that reduce a position are always allowed so you can get out."""

    def __init__(self, limits: Optional[dict] = None, equity: float = 0.0):
        self.limits = RiskLimits(**(limits or {}))
        self.s = RiskState(day_start_equity=equity, peak=equity)
        self.stale_fn = None  # live mode: returns a reason string while market data is stale

    def update(self, t: int, equity: float) -> None:
        day = t // DAY
        if day != self.s.day:
            self.s.day = day
            self.s.day_start_equity = equity
            if self.s.halt_reason and self.s.halt_reason.startswith("Daily loss"):
                self.s.halt_reason = None
        self.s.peak = max(self.s.peak, equity)
        if not self.s.halt_reason:
            day_loss = (self.s.day_start_equity - equity) / self.s.day_start_equity * 100
            dd = (self.s.peak - equity) / self.s.peak * 100
            if day_loss >= self.limits.max_daily_loss_pct:
                self.s.halt_reason = f"Daily loss limit of {self.limits.max_daily_loss_pct:g}% reached"
            elif dd >= self.limits.max_drawdown_pct:
                self.s.halt_reason = f"Drawdown limit of {self.limits.max_drawdown_pct:g}% reached"

    def day_pnl_pct(self, equity: float) -> float:
        d = self.s.day_start_equity
        return (equity - d) / d * 100 if d else 0.0

    def drawdown_pct(self, equity: float) -> float:
        p = self.s.peak
        return (p - equity) / p * 100 if p else 0.0

    def kill(self) -> None:
        self.s.killed = True

    def reset(self, equity: float) -> None:
        self.s.killed = False
        self.s.halt_reason = None
        self.s.peak = equity
        self.s.day_start_equity = equity

    def blocked(self) -> Optional[str]:
        if self.s.killed:
            return "Kill switch is on"
        if self.stale_fn:
            r = self.stale_fn()
            if r:
                return r
        return self.s.halt_reason

    def check(self, req: OrderRequest, ref_price: float, equity: float, position_value: float):
        """Returns (ok, reason)."""
        notional = req.qty * ref_price
        if req.side == "sell":
            return True, ""
        b = self.blocked()
        if b:
            return False, b + ": buys are paused"
        if notional < self.limits.min_notional:
            return False, f"Order is under the ${self.limits.min_notional:g} minimum"
        if equity <= 0:
            return False, "No equity"
        order_pct = notional / equity * 100
        if order_pct > self.limits.max_order_pct + 1e-9:
            return False, f"Order is {order_pct:.1f}% of equity, limit is {self.limits.max_order_pct:g}%"
        pos_pct = (position_value + notional) / equity * 100
        if pos_pct > self.limits.max_position_pct + 1e-9:
            return False, f"Position would be {pos_pct:.1f}% of equity, limit is {self.limits.max_position_pct:g}%"
        return True, ""
