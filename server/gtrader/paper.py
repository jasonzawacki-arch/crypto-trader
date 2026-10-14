from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from typing import Callable, Optional

from .types import Exchange, Fill, Order, OrderRequest, Position, SymbolRules, Tick
from .util import floor_to, round_to


@dataclass
class PaperConfig:
    starting_cash: float = 10000
    taker_bps: float = 40  # market, stop and marketable limit orders
    maker_bps: float = 20  # resting limit orders that fill
    spread_bps: float = 6  # full quoted spread; each side pays half
    impact_coef: float = 10  # bps of impact per 1% of the bar's traded value
    max_impact_bps: float = 100


class PaperExchange(Exchange):
    """Simulated spot exchange: fees, spread, size impact, reservations, conservative limit fills."""

    name = "Paper"
    live = False

    def __init__(self, cfg: Optional[dict] = None, rules: Optional[list[SymbolRules]] = None):
        self.cfg = PaperConfig(**(cfg or {}))
        self.cash = float(self.cfg.starting_cash)
        self.positions: dict[str, Position] = {}
        self.orders: list[Order] = []
        self.fills: list[Fill] = []
        self.marks: dict[str, float] = {}
        self.vols: dict[str, float] = {}
        self.fees_paid = 0.0
        self.realized = 0.0
        self.now = 0
        self._seq = 1
        self._rules = {r.symbol: r for r in (rules or [])}
        self.on_fill: Callable[[Fill], None] = lambda f: None
        self.on_order: Callable[[Order], None] = lambda o: None

    # ---- lookups
    def rules(self, symbol: str) -> SymbolRules:
        if symbol not in self._rules:
            raise KeyError("Unknown symbol " + symbol)
        return self._rules[symbol]

    def symbols(self) -> list[str]:
        return list(self._rules)

    def mark(self, symbol: str) -> Optional[float]:
        return self.marks.get(symbol)

    def equity(self) -> float:
        e = self.cash
        for p in self.positions.values():
            e += p.qty * self.marks.get(p.symbol, p.cost / p.qty)
        return e

    def reserved_cash(self) -> float:
        return sum(o.reserve for o in self.orders if o.status == "open" and o.side == "buy")

    def reserved_qty(self, symbol: str, exclude_group: Optional[str] = None) -> float:
        """Open sell quantity held back. An OCO group reserves its position once, not once per leg."""
        s, groups = 0.0, {}
        for o in self.orders:
            if o.status != "open" or o.side != "sell" or o.symbol != symbol:
                continue
            if o.group:
                if o.group != exclude_group:
                    groups[o.group] = max(groups.get(o.group, 0.0), o.qty)
            else:
                s += o.qty
        return s + sum(groups.values())

    def available_cash(self) -> float:
        return self.cash - self.reserved_cash()

    def available_qty(self, symbol: str, exclude_group: Optional[str] = None) -> float:
        p = self.positions.get(symbol)
        return (p.qty if p else 0.0) - self.reserved_qty(symbol, exclude_group)

    def unrealized(self) -> float:
        return sum(p.qty * self.marks.get(p.symbol, 0.0) - p.cost for p in self.positions.values())

    def open_orders(self) -> list[Order]:
        return [o for o in self.orders if o.status == "open"]

    # ---- pricing
    def _impact_bps(self, symbol: str, notional: float) -> float:
        v = self.vols.get(symbol, 0.0)
        if v <= 0:
            return self.cfg.max_impact_bps / 4
        return min(self.cfg.max_impact_bps, self.cfg.impact_coef * ((notional / v) * 100))

    def quote(self, symbol: str, side: str, qty: float) -> Optional[float]:
        ref = self.marks.get(symbol)
        if ref is None:
            return None
        bps = self.cfg.spread_bps / 2 + self._impact_bps(symbol, qty * ref)
        px = ref * (1 + bps / 1e4) if side == "buy" else ref * (1 - bps / 1e4)
        return round_to(px, self.rules(symbol).price_step)

    # ---- ticks
    def on_tick(self, tk: Tick) -> None:
        self.now = tk.t
        self.marks[tk.symbol] = tk.price
        if tk.vol > 0:
            self.vols[tk.symbol] = tk.vol * tk.price
        for o in list(self.orders):
            if o.status != "open" or o.symbol != tk.symbol:
                continue
            px = tk.price
            if o.type == "limit":
                # Conservative: price must trade through the limit, touching is not enough.
                if o.side == "buy" and px < o.price:
                    self._fill(o, o.price, True)
                elif o.side == "sell" and px > o.price:
                    self._fill(o, o.price, True)
            elif o.type == "stop":
                if o.side == "sell" and px <= o.price:
                    self._fill(o, self.quote(o.symbol, "sell", o.qty), False)
                elif o.side == "buy" and px >= o.price:
                    self._fill(o, self.quote(o.symbol, "buy", o.qty), False)

    # ---- orders
    def place_order(self, req: OrderRequest) -> Order:
        return self.place(req)

    def place(self, req: OrderRequest) -> Order:
        oid = "P%d" % self._seq
        self._seq += 1
        o = Order(symbol=req.symbol, side=req.side, type=req.type, qty=req.qty, price=req.price, id=oid,
                  created_at=self.now, source=req.source or "manual", group=req.group, bracket=req.bracket)

        def reject(reason: str) -> Order:
            o.status = "rejected"
            o.reason = reason
            self.orders.append(o)
            self._trim()
            self.on_order(o)
            return o

        try:
            r = self.rules(req.symbol)
        except KeyError:
            return reject("Unknown symbol")
        if req.side not in ("buy", "sell"):
            return reject("Bad side")
        if req.type not in ("market", "limit", "stop"):
            return reject("Bad order type")
        if not (isinstance(req.qty, (int, float)) and math.isfinite(req.qty)) or req.qty <= 0:
            return reject("Quantity must be above zero")
        o.qty = floor_to(req.qty, r.qty_step)
        if o.qty < r.min_qty:
            return reject(f"Below the minimum size of {r.min_qty:g} {r.base}")
        ref = self.marks.get(req.symbol)
        if ref is None:
            return reject("No market data yet")
        if req.type != "market":
            if req.price is None or not math.isfinite(req.price) or req.price <= 0:
                return reject("Enter a price")
            o.price = round_to(req.price, r.price_step)
        taker = self.cfg.taker_bps / 1e4

        if req.side == "sell":
            if o.qty > self.available_qty(req.symbol, req.group) + 1e-12:
                return reject("Not enough " + r.base + " to sell")
            if o.type == "stop" and o.price >= ref:
                return reject("Stop price must be below the market for a sell")
        elif o.type == "stop" and o.price <= ref:
            return reject("Stop price must be above the market for a buy")

        if o.type == "market":
            px = self.quote(req.symbol, req.side, o.qty)
            if req.side == "buy" and o.qty * px * (1 + taker) > self.available_cash() + 1e-9:
                return reject("Not enough cash")
            self.orders.append(o)
            self._fill(o, px, False)
            return o
        if o.type == "limit":
            qb = self.quote(req.symbol, "buy", o.qty)
            qs = self.quote(req.symbol, "sell", o.qty)
            marketable = o.price >= qb if req.side == "buy" else o.price <= qs
            if marketable:
                px = qb if req.side == "buy" else qs
                if req.side == "buy" and o.qty * px * (1 + taker) > self.available_cash() + 1e-9:
                    return reject("Not enough cash")
                self.orders.append(o)
                self._fill(o, px, False)
                return o
        if req.side == "buy":
            worst = o.price if o.type == "limit" else o.price * 1.02
            need = o.qty * worst * (1 + taker)
            if need > self.available_cash() + 1e-9:
                return reject("Not enough cash")
            o.reserve = need
        self.orders.append(o)
        self.on_order(o)
        return o

    def cancel_order(self, order_id: str) -> bool:
        return self.cancel(order_id)

    def cancel(self, order_id: str, reason: str = "Cancelled") -> bool:
        for o in self.orders:
            if o.id == order_id and o.status == "open":
                o.status = "cancelled"
                o.reason = reason
                o.reserve = 0.0
                self.on_order(o)
                return True
        return False

    def cancel_all(self, pred: Optional[Callable[[Order], bool]] = None, reason: str = "Cancelled") -> int:
        n = 0
        for o in self.open_orders():
            if pred is None or pred(o):
                n += 1 if self.cancel(o.id, reason) else 0
        return n

    def _fill(self, o: Order, price: float, maker: bool) -> None:
        bps = self.cfg.maker_bps if maker else self.cfg.taker_bps
        gross = o.qty * price
        fee = gross * (bps / 1e4)
        realized = 0.0
        o.reserve = 0.0
        if o.side == "buy":
            if gross + fee > self.cash + 1e-9:
                o.status, o.reason = "rejected", "Not enough cash when the order triggered"
                self.on_order(o)
                return
            self.cash -= gross + fee
            p = self.positions.get(o.symbol) or Position(o.symbol, 0.0, 0.0)
            p.qty += o.qty
            p.cost += gross + fee
            self.positions[o.symbol] = p
        else:
            p = self.positions.get(o.symbol)
            if p is None or p.qty + 1e-12 < o.qty:
                o.status, o.reason = "rejected", "Position was already closed"
                self.on_order(o)
                return
            cost_out = p.cost * (o.qty / p.qty)
            realized = gross - fee - cost_out
            self.cash += gross - fee
            p.qty -= o.qty
            p.cost -= cost_out
            if p.qty < 1e-12:
                del self.positions[o.symbol]
            self.realized += realized
        self.fees_paid += fee
        o.status, o.filled_at, o.fill_price, o.fee = "filled", self.now, price, fee
        f = Fill("F%d" % self._seq, o.id, o.symbol, o.side, o.qty, price, fee, self.now, o.source, maker, realized)
        self._seq += 1
        self.fills.append(f)
        self._trim()
        self.on_order(o)
        if o.group:
            for sib in self.open_orders():
                if sib.group == o.group and sib.id != o.id:
                    self.cancel(sib.id, "Other side of the pair filled")
        self.on_fill(f)

    def _trim(self) -> None:
        if len(self.orders) > 600:
            done = [o for o in self.orders if o.status != "open"][-300:]
            self.orders = [o for o in self.orders if o.status == "open"] + done
        if len(self.fills) > 4000:
            self.fills = self.fills[-3000:]

    # ---- snapshots (persistence and the UI mirror)
    def snapshot(self, fills_tail: int = 4000) -> dict:
        return {
            "cfg": asdict(self.cfg), "cash": self.cash, "positions": [asdict(p) for p in self.positions.values()],
            "orders": [asdict(o) for o in self.orders], "fills": [asdict(f) for f in self.fills[-fills_tail:]],
            "marks": dict(self.marks), "vols": dict(self.vols), "seq": self._seq, "fees_paid": self.fees_paid,
            "realized": self.realized, "now": self.now,
        }

    def restore(self, s: dict) -> None:
        self.cfg = PaperConfig(**s["cfg"])
        self.cash = s["cash"]
        self.positions = {p["symbol"]: Position(**p) for p in s["positions"]}
        self.orders = [Order(**o) for o in s["orders"]]
        self.fills = [Fill(**f) for f in s["fills"]]
        self.marks, self.vols = dict(s["marks"]), dict(s["vols"])
        self._seq, self.fees_paid, self.realized = s["seq"], s["fees_paid"], s["realized"]
        self.now = s.get("now", 0)
