import type { Exchange, Fill, Order, OrderRequest, Position, SymbolRules, Tick } from './types.js';
import { floorTo, roundTo } from './util.js';

export interface PaperConfig {
  startingCash: number;
  takerBps: number; // fee for market, stop and marketable limit orders
  makerBps: number; // fee for resting limit orders that fill
  spreadBps: number; // full quoted spread; each side pays half
  impactCoef: number; // bps of impact per 1% of the bar's traded value
  maxImpactBps: number;
}
export const DEFAULT_PAPER: PaperConfig = {
  startingCash: 10000,
  takerBps: 40,
  makerBps: 20,
  spreadBps: 6,
  impactCoef: 10,
  maxImpactBps: 100,
};

export interface PaperSnapshot {
  cfg: PaperConfig;
  cash: number;
  positions: Position[];
  orders: Order[];
  fills: Fill[];
  marks: Record<string, number>;
  vols: Record<string, number>;
  seq: number;
  feesPaid: number;
  realized: number;
}

/**
 * A simulated spot exchange. It follows the same async interface a real exchange adapter would,
 * and applies fees, spread, size-based slippage, order reservations and conservative limit fills.
 */
export class PaperExchange implements Exchange {
  readonly name = 'Paper';
  readonly live = false;
  cfg: PaperConfig;
  cash: number;
  positions = new Map<string, Position>();
  orders: Order[] = [];
  fills: Fill[] = [];
  marks: Record<string, number> = {};
  vols: Record<string, number> = {};
  feesPaid = 0;
  realized = 0;
  now = 0;
  private seq = 1;
  private rulesBy = new Map<string, SymbolRules>();
  onFill: (f: Fill) => void = () => {};
  onOrder: (o: Order) => void = () => {};

  constructor(cfg: Partial<PaperConfig>, rules: SymbolRules[]) {
    this.cfg = { ...DEFAULT_PAPER, ...cfg };
    this.cash = this.cfg.startingCash;
    rules.forEach((r) => this.rulesBy.set(r.symbol, r));
  }

  rules(symbol: string): SymbolRules {
    const r = this.rulesBy.get(symbol);
    if (!r) throw new Error('Unknown symbol ' + symbol);
    return r;
  }
  symbols(): string[] {
    return [...this.rulesBy.keys()];
  }

  // ---- derived state
  mark(symbol: string): number | null {
    return this.marks[symbol] ?? null;
  }
  equity(): number {
    let e = this.cash;
    for (const p of this.positions.values()) e += p.qty * (this.marks[p.symbol] ?? p.cost / p.qty);
    return e;
  }
  reservedCash(): number {
    return this.orders.reduce((s, o) => (o.status === 'open' && o.side === 'buy' ? s + (o.reserve || 0) : s), 0);
  }
  /** Open sell quantity held back. An OCO group reserves its position once, not once per leg. */
  reservedQty(symbol: string, excludeGroup?: string): number {
    let s = 0;
    const groups = new Map<string, number>();
    for (const o of this.orders) {
      if (o.status !== 'open' || o.side !== 'sell' || o.symbol !== symbol) continue;
      if (o.group) {
        if (o.group !== excludeGroup) groups.set(o.group, Math.max(groups.get(o.group) ?? 0, o.qty));
      } else s += o.qty;
    }
    for (const q of groups.values()) s += q;
    return s;
  }
  availableCash(): number {
    return this.cash - this.reservedCash();
  }
  availableQty(symbol: string, excludeGroup?: string): number {
    return (this.positions.get(symbol)?.qty ?? 0) - this.reservedQty(symbol, excludeGroup);
  }
  unrealized(): number {
    let u = 0;
    for (const p of this.positions.values()) u += p.qty * (this.marks[p.symbol] ?? 0) - p.cost;
    return u;
  }
  openOrders(): Order[] {
    return this.orders.filter((o) => o.status === 'open');
  }

  // ---- pricing
  private impactBps(symbol: string, notional: number): number {
    const v = this.vols[symbol] || 0;
    if (v <= 0) return this.cfg.maxImpactBps / 4;
    return Math.min(this.cfg.maxImpactBps, this.cfg.impactCoef * ((notional / v) * 100));
  }
  /** Price a market order would pay or receive right now. */
  quote(symbol: string, side: 'buy' | 'sell', qty: number): number | null {
    const ref = this.marks[symbol];
    if (ref == null) return null;
    const bps = this.cfg.spreadBps / 2 + this.impactBps(symbol, qty * ref);
    const px = side === 'buy' ? ref * (1 + bps / 1e4) : ref * (1 - bps / 1e4);
    return roundTo(px, this.rules(symbol).priceStep);
  }

  // ---- ticks
  onTick(tk: Tick): void {
    this.now = tk.t;
    this.marks[tk.symbol] = tk.price;
    if (tk.vol > 0) this.vols[tk.symbol] = tk.vol * tk.price;
    for (const o of this.orders) {
      if (o.status !== 'open' || o.symbol !== tk.symbol) continue;
      const px = tk.price;
      if (o.type === 'limit') {
        // Conservative: price must trade through the limit, touching it is not enough.
        if (o.side === 'buy' && px < o.price!) this.fill(o, o.price!, true);
        else if (o.side === 'sell' && px > o.price!) this.fill(o, o.price!, true);
      } else if (o.type === 'stop') {
        if (o.side === 'sell' && px <= o.price!) this.fill(o, this.quote(o.symbol, 'sell', o.qty)!, false);
        else if (o.side === 'buy' && px >= o.price!) this.fill(o, this.quote(o.symbol, 'buy', o.qty)!, false);
      }
    }
  }

  // ---- orders
  async placeOrder(req: OrderRequest): Promise<Order> {
    return this.place(req);
  }
  place(req: OrderRequest): Order {
    const id = 'P' + this.seq++;
    const o: Order = { ...req, id, status: 'open', createdAt: this.now, source: req.source || 'manual' };
    const reject = (reason: string): Order => {
      o.status = 'rejected';
      o.reason = reason;
      this.orders.push(o);
      this.trim();
      this.onOrder(o);
      return o;
    };
    let r: SymbolRules;
    try {
      r = this.rules(req.symbol);
    } catch (e) {
      return reject('Unknown symbol');
    }
    if (req.side !== 'buy' && req.side !== 'sell') return reject('Bad side');
    if (!Number.isFinite(req.qty) || req.qty <= 0) return reject('Quantity must be above zero');
    o.qty = floorTo(req.qty, r.qtyStep);
    if (o.qty < r.minQty) return reject(`Below the minimum size of ${r.minQty} ${r.base}`);
    const ref = this.marks[req.symbol];
    if (ref == null) return reject('No market data yet');
    if (req.type !== 'market') {
      if (!Number.isFinite(req.price) || req.price! <= 0) return reject('Enter a price');
      o.price = roundTo(req.price!, r.priceStep);
    }
    const taker = this.cfg.takerBps / 1e4;

    if (req.side === 'sell') {
      if (o.qty > this.availableQty(req.symbol, req.group) + 1e-12) return reject('Not enough ' + r.base + ' to sell');
      if (o.type === 'stop' && o.price! >= ref) return reject('Stop price must be below the market for a sell');
    } else if (o.type === 'stop' && o.price! <= ref) {
      return reject('Stop price must be above the market for a buy');
    }

    if (o.type === 'market') {
      const px = this.quote(req.symbol, req.side, o.qty)!;
      if (req.side === 'buy' && o.qty * px * (1 + taker) > this.availableCash() + 1e-9)
        return reject('Not enough cash');
      this.orders.push(o);
      this.fill(o, px, false);
      return o;
    }
    if (o.type === 'limit') {
      const marketable =
        req.side === 'buy'
          ? o.price! >= this.quote(req.symbol, 'buy', o.qty)!
          : o.price! <= this.quote(req.symbol, 'sell', o.qty)!;
      if (marketable) {
        const px = this.quote(req.symbol, req.side, o.qty)!;
        if (req.side === 'buy' && o.qty * px * (1 + taker) > this.availableCash() + 1e-9)
          return reject('Not enough cash');
        this.orders.push(o);
        this.fill(o, px, false);
        return o;
      }
    }
    if (req.side === 'buy') {
      const worst = o.type === 'limit' ? o.price! : o.price! * 1.02;
      const need = o.qty * worst * (1 + taker);
      if (need > this.availableCash() + 1e-9) return reject('Not enough cash');
      o.reserve = need;
    }
    this.orders.push(o);
    this.onOrder(o);
    return o;
  }

  async cancelOrder(id: string): Promise<boolean> {
    return this.cancel(id);
  }
  cancel(id: string, reason = 'Cancelled'): boolean {
    const o = this.orders.find((x) => x.id === id && x.status === 'open');
    if (!o) return false;
    o.status = 'cancelled';
    o.reason = reason;
    o.reserve = 0;
    this.onOrder(o);
    return true;
  }
  cancelAll(filter?: (o: Order) => boolean, reason?: string): number {
    let n = 0;
    for (const o of this.openOrders()) if (!filter || filter(o)) n += this.cancel(o.id, reason) ? 1 : 0;
    return n;
  }

  private fill(o: Order, price: number, maker: boolean): void {
    const bps = maker ? this.cfg.makerBps : this.cfg.takerBps;
    const gross = o.qty * price;
    const fee = gross * (bps / 1e4);
    let realized = 0;
    o.reserve = 0;
    if (o.side === 'buy') {
      if (gross + fee > this.cash + 1e-9) {
        o.status = 'rejected';
        o.reason = 'Not enough cash when the order triggered';
        this.onOrder(o);
        return;
      }
      this.cash -= gross + fee;
      const p = this.positions.get(o.symbol) || { symbol: o.symbol, qty: 0, cost: 0 };
      p.qty += o.qty;
      p.cost += gross + fee;
      this.positions.set(o.symbol, p);
    } else {
      const p = this.positions.get(o.symbol);
      if (!p || p.qty + 1e-12 < o.qty) {
        o.status = 'rejected';
        o.reason = 'Position was already closed';
        this.onOrder(o);
        return;
      }
      const costOut = p.cost * (o.qty / p.qty);
      realized = gross - fee - costOut;
      this.cash += gross - fee;
      p.qty -= o.qty;
      p.cost -= costOut;
      if (p.qty < 1e-12) this.positions.delete(o.symbol);
      this.realized += realized;
    }
    this.feesPaid += fee;
    o.status = 'filled';
    o.filledAt = this.now;
    o.fillPrice = price;
    o.fee = fee;
    const f: Fill = {
      id: 'F' + this.seq++,
      orderId: o.id,
      symbol: o.symbol,
      side: o.side,
      qty: o.qty,
      price,
      fee,
      t: this.now,
      source: o.source,
      maker,
      realized,
    };
    this.fills.push(f);
    this.trim();
    this.onOrder(o);
    if (o.group) for (const s of this.openOrders()) if (s.group === o.group && s.id !== o.id) this.cancel(s.id, 'Other side of the pair filled');
    this.onFill(f);
  }

  private trim(): void {
    if (this.orders.length > 600) this.orders = this.orders.filter((o) => o.status === 'open').concat(this.orders.filter((o) => o.status !== 'open').slice(-300));
    if (this.fills.length > 4000) this.fills = this.fills.slice(-3000);
  }

  snapshot(): PaperSnapshot {
    return JSON.parse(
      JSON.stringify({
        cfg: this.cfg,
        cash: this.cash,
        positions: [...this.positions.values()],
        orders: this.orders,
        fills: this.fills,
        marks: this.marks,
        vols: this.vols,
        seq: this.seq,
        feesPaid: this.feesPaid,
        realized: this.realized,
      }),
    );
  }
  restore(s: PaperSnapshot): void {
    this.cfg = { ...DEFAULT_PAPER, ...s.cfg };
    this.cash = s.cash;
    this.positions = new Map(s.positions.map((p) => [p.symbol, p]));
    this.orders = s.orders;
    this.fills = s.fills;
    this.marks = s.marks;
    this.vols = s.vols;
    this.seq = s.seq;
    this.feesPaid = s.feesPaid;
    this.realized = s.realized;
  }
}
