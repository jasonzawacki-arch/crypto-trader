from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Optional

from .paper import PaperExchange
from .risk import RiskManager
from .strategies import default_params, strategy_by_id
from .types import Candle, Fill, OrderRequest, StrategyContext, Tick


@dataclass
class BotConfig:
    id: str
    name: str
    strategy_id: str
    symbol: str
    params: dict
    alloc_pct: float = 20  # % of equity committed per entry
    stop_pct: float = 5  # protective stop below entry, 0 = none
    enabled: bool = False


@dataclass
class BotState:
    qty: float = 0.0
    stop_id: Optional[str] = None
    last: Optional[dict] = None
    trades: int = 0
    pnl: float = 0.0


@dataclass
class Bot:
    cfg: BotConfig
    st: BotState = field(default_factory=BotState)


class Engine:
    """Turns ticks into candles, runs bots on closed candles, manages protective stops and the kill switch."""

    def __init__(self, ex: PaperExchange, risk: RiskManager, candle_ms: int, keep: int = 1500):
        self.ex, self.risk, self.candle_ms, self.keep = ex, risk, candle_ms, keep
        self.series: dict[str, list[Candle]] = {s: [] for s in ex.symbols()}
        self.cur: dict[str, Optional[Candle]] = {s: None for s in ex.symbols()}
        self.bots: list[Bot] = []
        self.log: list[dict] = []
        self.equity_log: list[dict] = []
        self._bot_seq = 1
        ex.on_fill = self._handle_fill

    def note(self, t: int, kind: str, text: str) -> None:
        self.log.append({"t": t, "kind": kind, "text": text})
        if len(self.log) > 300:
            del self.log[: len(self.log) - 250]

    def seed(self, symbol: str, candles: list[Candle]) -> None:
        self.series[symbol] = list(candles[-self.keep:])

    # ---- market data
    def tick(self, tk: Tick) -> None:
        ex = self.ex
        ex.on_tick(tk)
        bucket = (tk.t // self.candle_ms) * self.candle_ms
        c = self.cur.get(tk.symbol)
        if c is None or c.t != bucket:
            if c is not None:
                s = self.series[tk.symbol]
                s.append(c)
                if len(s) > self.keep:
                    del s[: len(s) - self.keep]
            self.cur[tk.symbol] = Candle(bucket, tk.price, tk.price, tk.price, tk.price, tk.vol)
            if c is not None:
                if tk.symbol == ex.symbols()[0]:
                    self.equity_log.append({"t": c.t, "e": ex.equity()})
                if len(self.equity_log) > 3000:
                    del self.equity_log[: len(self.equity_log) - 2500]
                self._on_candle_closed(tk.symbol, tk.t)
        else:
            c.h = max(c.h, tk.price)
            c.l = min(c.l, tk.price)
            c.c = tk.price
        self.risk.update(tk.t, ex.equity())

    # ---- bots
    def add_bot(self, strategy_id: str, symbol: str, name: Optional[str] = None, params: Optional[dict] = None,
                alloc_pct: float = 20, stop_pct: float = 5, enabled: bool = False) -> str:
        strat = strategy_by_id(strategy_id)
        bid = "bot%d" % self._bot_seq
        self._bot_seq += 1
        cfg = BotConfig(bid, name or strat.name, strat.id, symbol, {**default_params(strat), **(params or {})},
                        alloc_pct, stop_pct, enabled)
        self.bots.append(Bot(cfg))
        return bid

    def remove_bot(self, bot_id: str) -> None:
        b = self.bot(bot_id)
        if not b:
            return
        if b.st.stop_id:
            self.ex.cancel(b.st.stop_id)
        self.bots = [x for x in self.bots if x is not b]

    def bot(self, bot_id: str) -> Optional[Bot]:
        return next((b for b in self.bots if b.cfg.id == bot_id), None)

    def _on_candle_closed(self, symbol: str, t: int) -> None:
        candles = self.series[symbol]
        for b in self.bots:
            if not b.cfg.enabled or b.cfg.symbol != symbol:
                continue
            strat = strategy_by_id(b.cfg.strategy_id)
            if len(candles) < strat.warmup(b.cfg.params):
                continue
            in_pos = b.st.qty > 1e-12
            sig = strat.on_candle(b.cfg.params, StrategyContext(candles, in_pos, None))
            if sig.type == "hold":
                continue
            b.st.last = {"t": t, "text": sig.type.upper() + ": " + sig.note}
            if sig.type == "buy" and (not in_pos or strat.accumulate):
                self._bot_buy(b, t, sig.note)
            elif sig.type == "sell" and in_pos:
                self._bot_sell(b, t, sig.note)

    def _bot_buy(self, b: Bot, t: int, note: str) -> None:
        ex = self.ex
        mark = ex.mark(b.cfg.symbol)
        if not mark:
            return
        r = ex.rules(b.cfg.symbol)
        equity = ex.equity()
        spend = min(b.cfg.alloc_pct / 100 * equity, ex.available_cash() / (1 + ex.cfg.taker_bps / 1e4 + 0.01))
        req = OrderRequest(b.cfg.symbol, "buy", "market", spend / mark, None, b.cfg.id)
        if req.qty < r.min_qty:
            return self.note(t, "warn", f"{b.cfg.name}: skipped entry, not enough cash")
        pos = ex.positions.get(b.cfg.symbol)
        ok, reason = self.risk.check(req, mark, equity, (pos.qty if pos else 0) * mark)
        if not ok:
            return self.note(t, "risk", f"{b.cfg.name}: entry blocked. {reason}")
        self.note(t, "bot", f"{b.cfg.name}: {note}")
        o = ex.place(req)
        if o.status == "rejected":
            self.note(t, "warn", f"{b.cfg.name}: order rejected. {o.reason}")

    def _bot_sell(self, b: Bot, t: int, note: str) -> None:
        ex = self.ex
        if b.st.stop_id:
            ex.cancel(b.st.stop_id)
            b.st.stop_id = None
        self.note(t, "bot", f"{b.cfg.name}: {note}")
        o = ex.place(OrderRequest(b.cfg.symbol, "sell", "market", b.st.qty, None, b.cfg.id))
        if o.status == "rejected":
            self.note(t, "warn", f"{b.cfg.name}: exit rejected. {o.reason}")

    def _handle_fill(self, f: Fill) -> None:
        if f.side == "buy":
            self._attach_bracket(f)
        b = self.bot(f.source)
        tag = f" ({b.cfg.name if b else f.source})" if f.source != "manual" else ""
        self.note(f.t, "fill", f"{f.side.upper()} {f.qty:g} {f.symbol} @ {f.price:.2f}{tag}")
        if not b:
            return
        if f.side == "buy":
            b.st.qty += f.qty
            stop_pct = 0 if strategy_by_id(b.cfg.strategy_id).accumulate else b.cfg.stop_pct
            if stop_pct > 0 and not b.st.stop_id:
                px = f.price * (1 - stop_pct / 100)
                o = self.ex.place(OrderRequest(f.symbol, "sell", "stop", b.st.qty, px, b.cfg.id))
                if o.status == "open":
                    b.st.stop_id = o.id
                else:
                    self.note(f.t, "warn", f"{b.cfg.name}: stop not placed. {o.reason}")
        else:
            b.st.qty = max(0.0, b.st.qty - f.qty)
            b.st.pnl += f.realized
            if b.st.qty < 1e-12:
                b.st.qty = 0.0
                b.st.trades += 1
                if b.st.stop_id:
                    self.ex.cancel(b.st.stop_id)
                    b.st.stop_id = None

    def _attach_bracket(self, f: Fill) -> None:
        """A manual buy with a bracket gets its exit orders the moment it fills, as one OCO pair."""
        o = next((x for x in self.ex.orders if x.id == f.order_id), None)
        br = o.bracket if o else None
        if not o or not br:
            return
        stop, tp = br.get("stop_pct", 0) or 0, br.get("tp_pct", 0) or 0
        if stop <= 0 and tp <= 0:
            return
        group = "oco-" + o.id if stop > 0 and tp > 0 else None
        if stop > 0:
            r = self.ex.place(OrderRequest(f.symbol, "sell", "stop", f.qty, f.price * (1 - stop / 100), "manual", group))
            self.note(f.t, "info" if r.status == "open" else "warn",
                      f"Stop-loss set at {r.price}" if r.status == "open" else f"Stop-loss not placed. {r.reason}")
        if tp > 0:
            r = self.ex.place(OrderRequest(f.symbol, "sell", "limit", f.qty, f.price * (1 + tp / 100), "manual", group))
            self.note(f.t, "info" if r.status == "open" else "warn",
                      f"Take-profit set at {r.price}" if r.status == "open" else f"Take-profit not placed. {r.reason}")

    # ---- manual orders
    def place_manual(self, req: OrderRequest):
        """Returns (ok, order_or_reason)."""
        ex = self.ex
        mark = ex.mark(req.symbol)
        if mark is None:
            return False, "No market data yet"
        pos = ex.positions.get(req.symbol)
        ok, reason = self.risk.check(req, req.price or mark, ex.equity(), (pos.qty if pos else 0) * mark)
        if not ok:
            return False, reason
        req.source = "manual"
        o = ex.place(req)
        if o.status == "rejected":
            return False, o.reason or "Rejected"
        return True, o

    def kill(self, t: int) -> None:
        """Stops bots, cancels resting buy orders, leaves protective stops in place."""
        self.risk.kill()
        for b in self.bots:
            b.cfg.enabled = False
        n = self.ex.cancel_all(lambda o: o.side == "buy", "Kill switch")
        self.note(t, "risk", f"Kill switch on. Bots stopped, {n} buy order{'' if n == 1 else 's'} cancelled. Stops stay active.")

    # ---- persistence
    def snapshot(self) -> dict:
        return {
            "bots": [{"cfg": asdict(b.cfg), "st": asdict(b.st)} for b in self.bots], "bot_seq": self._bot_seq,
            "risk": {"limits": asdict(self.risk.limits), "s": asdict(self.risk.s)},
            "equity_log": self.equity_log[-2500:], "log": self.log[-120:], "ex": self.ex.snapshot(),
        }

    def restore(self, s: dict) -> None:
        from .risk import RiskLimits, RiskState
        self.ex.restore(s["ex"])
        self.risk.limits = RiskLimits(**s["risk"]["limits"])
        self.risk.s = RiskState(**s["risk"]["s"])
        self.bots = [Bot(BotConfig(**b["cfg"]), BotState(**b["st"])) for b in s["bots"]]
        self._bot_seq = s["bot_seq"]
        self.equity_log, self.log = s["equity_log"], s["log"]
