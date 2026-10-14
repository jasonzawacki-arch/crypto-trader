from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Callable, Optional


@dataclass
class Candle:
    t: int  # open time, ms
    o: float
    h: float
    l: float
    c: float
    v: float


@dataclass
class Tick:
    symbol: str
    t: int
    price: float
    vol: float  # base volume of the bar this tick belongs to


@dataclass
class SymbolRules:
    symbol: str
    base: str
    quote: str
    min_qty: float
    qty_step: float
    price_step: float


@dataclass
class OrderRequest:
    symbol: str
    side: str  # buy | sell
    type: str  # market | limit | stop
    qty: float
    price: Optional[float] = None  # limit price or stop trigger
    source: str = "manual"
    group: Optional[str] = None  # orders sharing a group are one-cancels-other and share one reservation
    bracket: Optional[dict] = None  # buy only: {"stop_pct": x, "tp_pct": y} exits placed when the buy fills


@dataclass
class Order:
    symbol: str
    side: str
    type: str
    qty: float
    id: str
    created_at: int
    price: Optional[float] = None
    status: str = "open"  # open | filled | cancelled | rejected
    source: str = "manual"
    filled_at: Optional[int] = None
    fill_price: Optional[float] = None
    fee: Optional[float] = None
    reason: Optional[str] = None
    reserve: float = 0.0
    group: Optional[str] = None
    bracket: Optional[dict] = None


@dataclass
class Fill:
    id: str
    order_id: str
    symbol: str
    side: str
    qty: float
    price: float
    fee: float
    t: int
    source: str
    maker: bool
    realized: float  # sell profit net of fees and cost basis; 0 for buys


@dataclass
class Position:
    symbol: str
    qty: float
    cost: float  # total cost of the open quantity, fees included


class Exchange(ABC):
    """What the engine needs from any venue. A live adapter implements the same four methods."""

    name: str = "abstract"
    live: bool = False

    @abstractmethod
    def rules(self, symbol: str) -> SymbolRules: ...

    @abstractmethod
    def place_order(self, req: OrderRequest) -> Order: ...

    @abstractmethod
    def cancel_order(self, order_id: str) -> bool: ...

    @abstractmethod
    def open_orders(self) -> list[Order]: ...


@dataclass
class StrategyContext:
    candles: list[Candle]  # closed candles only, last one just closed
    in_position: bool
    entry_price: Optional[float] = None


@dataclass
class Signal:
    type: str  # hold | buy | sell
    note: str = ""


@dataclass
class ParamDef:
    key: str
    label: str
    min: float
    max: float
    step: float
    default: float


@dataclass
class Strategy:
    id: str
    name: str
    blurb: str
    params: list[ParamDef]
    warmup: Callable[[dict], int]
    on_candle: Callable[[dict, StrategyContext], Signal]
    accumulate: bool = False  # keep buying while holding (DCA); no protective stop is attached
