import type { Candle, Fill, OrderRequest, Tick } from './types.js';
import { PaperExchange } from './paper.js';
import { RiskManager } from './risk.js';
import { defaultParams, strategyById } from './strategies.js';

export interface BotConfig {
  id: string;
  name: string;
  strategyId: string;
  symbol: string;
  params: Record<string, number>;
  allocPct: number; // % of equity committed per entry
  stopPct: number; // protective stop below entry, 0 = none
  enabled: boolean;
}
export interface BotState {
  qty: number;
  stopId: string | null;
  pending: boolean;
  last: { t: number; text: string } | null;
  trades: number;
  pnl: number;
}
export interface LogEntry {
  t: number;
  kind: 'info' | 'fill' | 'warn' | 'bot' | 'risk';
  text: string;
}
export interface EquityPoint {
  t: number;
  e: number;
}

export class Engine {
  series: Record<string, Candle[]> = {};
  cur: Record<string, Candle | null> = {};
  bots: { cfg: BotConfig; st: BotState }[] = [];
  log: LogEntry[] = [];
  equityLog: EquityPoint[] = [];
  private botSeq = 1;
  listeners: (() => void)[] = [];

  constructor(
    public ex: PaperExchange,
    public risk: RiskManager,
    public candleMs: number,
    public keep = 1500,
  ) {
    ex.onFill = (f) => this.handleFill(f);
    ex.symbols().forEach((s) => {
      this.series[s] = [];
      this.cur[s] = null;
    });
  }

  note(t: number, kind: LogEntry['kind'], text: string): void {
    this.log.push({ t, kind, text });
    if (this.log.length > 300) this.log.splice(0, this.log.length - 250);
  }

  seed(symbol: string, candles: Candle[]): void {
    this.series[symbol] = candles.slice(-this.keep);
  }

  // ---- market data
  tick(tk: Tick): void {
    const ex = this.ex;
    ex.onTick(tk);
    const bucket = Math.floor(tk.t / this.candleMs) * this.candleMs;
    const c = this.cur[tk.symbol];
    if (!c || c.t !== bucket) {
      if (c) {
        const s = this.series[tk.symbol];
        s.push(c);
        if (s.length > this.keep) s.splice(0, s.length - this.keep);
      }
      this.cur[tk.symbol] = { t: bucket, o: tk.price, h: tk.price, l: tk.price, c: tk.price, v: tk.vol };
      if (c) {
        // The previous candle just closed. Bots act on it and orders fill at this new bar's price.
        if (tk.symbol === ex.symbols()[0]) this.equityLog.push({ t: c.t, e: ex.equity() });
        if (this.equityLog.length > 3000) this.equityLog.splice(0, this.equityLog.length - 2500);
        this.onCandleClosed(tk.symbol, tk.t);
      }
    } else {
      c.h = Math.max(c.h, tk.price);
      c.l = Math.min(c.l, tk.price);
      c.c = tk.price;
    }
    this.risk.update(tk.t, ex.equity());
  }

  // ---- bots
  addBot(partial: Partial<BotConfig> & { strategyId: string; symbol: string }): string {
    const strat = strategyById(partial.strategyId);
    const id = 'bot' + this.botSeq++;
    const cfg: BotConfig = {
      id,
      name: partial.name || strat.name,
      strategyId: strat.id,
      symbol: partial.symbol,
      params: { ...defaultParams(strat), ...(partial.params || {}) },
      allocPct: partial.allocPct ?? 20,
      stopPct: partial.stopPct ?? 5,
      enabled: partial.enabled ?? false,
    };
    this.bots.push({ cfg, st: { qty: 0, stopId: null, pending: false, last: null, trades: 0, pnl: 0 } });
    return id;
  }
  removeBot(id: string): void {
    const b = this.bots.find((x) => x.cfg.id === id);
    if (!b) return;
    if (b.st.stopId) this.ex.cancel(b.st.stopId);
    this.bots = this.bots.filter((x) => x !== b);
  }
  bot(id: string) {
    return this.bots.find((x) => x.cfg.id === id);
  }

  private onCandleClosed(symbol: string, t: number): void {
    const candles = this.series[symbol];
    for (const b of this.bots) {
      if (!b.cfg.enabled || b.cfg.symbol !== symbol) continue;
      const strat = strategyById(b.cfg.strategyId);
      if (candles.length < strat.warmup(b.cfg.params)) continue;
      const inPos = b.st.qty > 1e-12;
      const sig = strat.onCandle(b.cfg.params, { candles, inPosition: inPos, entryPrice: null });
      if (sig.type === 'hold') continue;
      b.st.last = { t, text: sig.type.toUpperCase() + ': ' + sig.note };
      if (sig.type === 'buy' && (!inPos || strat.accumulate)) this.botBuy(b, t, sig.note);
      else if (sig.type === 'sell' && inPos) this.botSell(b, t, sig.note);
    }
  }
  private botBuy(b: { cfg: BotConfig; st: BotState }, t: number, note: string): void {
    const ex = this.ex;
    const mark = ex.mark(b.cfg.symbol);
    if (!mark) return;
    const r = ex.rules(b.cfg.symbol);
    const equity = ex.equity();
    const spend = Math.min((b.cfg.allocPct / 100) * equity, ex.availableCash() / (1 + ex.cfg.takerBps / 1e4 + 0.01));
    const req: OrderRequest = { symbol: b.cfg.symbol, side: 'buy', type: 'market', qty: spend / mark, source: b.cfg.id };
    if (req.qty < r.minQty) return this.note(t, 'warn', `${b.cfg.name}: skipped entry, not enough cash`);
    const chk = this.risk.check({
      req,
      refPrice: mark,
      equity,
      positionValue: (ex.positions.get(b.cfg.symbol)?.qty ?? 0) * mark,
    });
    if (!chk.ok) return this.note(t, 'risk', `${b.cfg.name}: entry blocked. ${chk.reason}`);
    this.note(t, 'bot', `${b.cfg.name}: ${note}`);
    const o = ex.place(req);
    if (o.status === 'rejected') this.note(t, 'warn', `${b.cfg.name}: order rejected. ${o.reason}`);
  }
  private botSell(b: { cfg: BotConfig; st: BotState }, t: number, note: string): void {
    const ex = this.ex;
    if (b.st.stopId) {
      ex.cancel(b.st.stopId);
      b.st.stopId = null;
    }
    this.note(t, 'bot', `${b.cfg.name}: ${note}`);
    const o = ex.place({ symbol: b.cfg.symbol, side: 'sell', type: 'market', qty: b.st.qty, source: b.cfg.id });
    if (o.status === 'rejected') this.note(t, 'warn', `${b.cfg.name}: exit rejected. ${o.reason}`);
  }

  private handleFill(f: Fill): void {
    const label = `${f.side.toUpperCase()} ${f.qty} ${f.symbol} @ ${f.price.toFixed(2)}`;
    this.note(f.t, 'fill', `${label}${f.source !== 'manual' ? ' (' + (this.bot(f.source)?.cfg.name || f.source) + ')' : ''}`);
    if (f.side === 'buy') this.attachBracket(f);
    const b = this.bot(f.source);
    if (!b) return;
    if (f.side === 'buy') {
      b.st.qty += f.qty;
      const stop = strategyById(b.cfg.strategyId).accumulate ? 0 : b.cfg.stopPct;
      if (stop > 0 && !b.st.stopId) {
        const px = f.price * (1 - stop / 100);
        const o = this.ex.place({ symbol: f.symbol, side: 'sell', type: 'stop', qty: b.st.qty, price: px, source: b.cfg.id });
        if (o.status === 'open') b.st.stopId = o.id;
        else this.note(f.t, 'warn', `${b.cfg.name}: stop not placed. ${o.reason}`);
      }
    } else {
      b.st.qty = Math.max(0, b.st.qty - f.qty);
      b.st.pnl += f.realized;
      if (b.st.qty < 1e-12) {
        b.st.qty = 0;
        b.st.trades++;
        if (b.st.stopId) {
          this.ex.cancel(b.st.stopId);
          b.st.stopId = null;
        }
      }
    }
  }

  /** A manual buy with a bracket gets its exit orders the moment it fills, as one OCO pair. */
  private attachBracket(f: Fill): void {
    const o = this.ex.orders.find((x) => x.id === f.orderId);
    const br = o?.bracket;
    if (!o || !br || (br.stopPct <= 0 && br.tpPct <= 0)) return;
    const group = br.stopPct > 0 && br.tpPct > 0 ? 'oco-' + o.id : undefined;
    if (br.stopPct > 0) {
      const r = this.ex.place({ symbol: f.symbol, side: 'sell', type: 'stop', qty: f.qty, price: f.price * (1 - br.stopPct / 100), source: 'manual', group });
      this.note(f.t, r.status === 'open' ? 'info' : 'warn', r.status === 'open' ? `Stop-loss set at ${r.price}` : `Stop-loss not placed. ${r.reason}`);
    }
    if (br.tpPct > 0) {
      const r = this.ex.place({ symbol: f.symbol, side: 'sell', type: 'limit', qty: f.qty, price: f.price * (1 + br.tpPct / 100), source: 'manual', group });
      this.note(f.t, r.status === 'open' ? 'info' : 'warn', r.status === 'open' ? `Take-profit set at ${r.price}` : `Take-profit not placed. ${r.reason}`);
    }
  }

  // ---- manual orders
  placeManual(req: OrderRequest) {
    const ex = this.ex;
    const mark = ex.mark(req.symbol);
    if (mark == null) return { ok: false as const, reason: 'No market data yet' };
    const chk = this.risk.check({
      req,
      refPrice: req.price || mark,
      equity: ex.equity(),
      positionValue: (ex.positions.get(req.symbol)?.qty ?? 0) * mark,
    });
    if (!chk.ok) return chk;
    const o = ex.place({ ...req, source: 'manual' });
    if (o.status === 'rejected') return { ok: false as const, reason: o.reason || 'Rejected' };
    return { ok: true as const, order: o };
  }

  /** Stops bots, cancels resting buy orders and leaves protective stops in place. */
  kill(t: number): void {
    this.risk.kill();
    this.bots.forEach((b) => (b.cfg.enabled = false));
    const n = this.ex.cancelAll((o) => o.side === 'buy', 'Kill switch');
    this.note(t, 'risk', `Kill switch on. Bots stopped, ${n} buy order${n === 1 ? '' : 's'} cancelled. Stops stay active.`);
  }

  serialize() {
    return {
      bots: this.bots,
      botSeq: this.botSeq,
      risk: { limits: this.risk.limits, s: this.risk.s },
      equityLog: this.equityLog,
      log: this.log.slice(-120),
      ex: this.ex.snapshot(),
    };
  }
}
