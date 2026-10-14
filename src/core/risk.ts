import type { OrderRequest } from './types.js';

export interface RiskLimits {
  maxOrderPct: number; // largest single buy, % of equity
  maxPositionPct: number; // largest holding in one symbol, % of equity
  maxDailyLossPct: number; // halts new buys for the rest of the day
  maxDrawdownPct: number; // halts new buys until reset
  minNotional: number; // smallest order value, quote currency
}
export const DEFAULT_RISK: RiskLimits = {
  maxOrderPct: 25,
  maxPositionPct: 40,
  maxDailyLossPct: 3,
  maxDrawdownPct: 15,
  minNotional: 10,
};

export interface RiskState {
  killed: boolean;
  haltReason: string | null;
  day: number;
  dayStartEquity: number;
  peak: number;
}

export interface CheckInput {
  req: OrderRequest;
  refPrice: number;
  equity: number;
  positionValue: number; // current value of this symbol's holding
}

const DAY = 86400000;

/** Pre-trade checks. Sells that reduce a position are always allowed so you can get out. */
export class RiskManager {
  limits: RiskLimits;
  s: RiskState;
  constructor(limits: Partial<RiskLimits> = {}, equity = 0) {
    this.limits = { ...DEFAULT_RISK, ...limits };
    this.s = { killed: false, haltReason: null, day: -1, dayStartEquity: equity, peak: equity };
  }

  update(t: number, equity: number): void {
    const day = Math.floor(t / DAY);
    if (day !== this.s.day) {
      this.s.day = day;
      this.s.dayStartEquity = equity;
      if (this.s.haltReason && this.s.haltReason.startsWith('Daily loss')) this.s.haltReason = null;
    }
    this.s.peak = Math.max(this.s.peak, equity);
    if (!this.s.haltReason) {
      const dayLoss = ((this.s.dayStartEquity - equity) / this.s.dayStartEquity) * 100;
      const dd = ((this.s.peak - equity) / this.s.peak) * 100;
      if (dayLoss >= this.limits.maxDailyLossPct)
        this.s.haltReason = `Daily loss limit of ${this.limits.maxDailyLossPct}% reached`;
      else if (dd >= this.limits.maxDrawdownPct)
        this.s.haltReason = `Drawdown limit of ${this.limits.maxDrawdownPct}% reached`;
    }
  }

  dayPnlPct(equity: number): number {
    return this.s.dayStartEquity ? ((equity - this.s.dayStartEquity) / this.s.dayStartEquity) * 100 : 0;
  }
  drawdownPct(equity: number): number {
    return this.s.peak ? ((this.s.peak - equity) / this.s.peak) * 100 : 0;
  }

  kill(): void {
    this.s.killed = true;
  }
  /** Clears the kill switch and any halt. The peak resets so the drawdown limit starts fresh. */
  reset(equity: number): void {
    this.s.killed = false;
    this.s.haltReason = null;
    this.s.peak = equity;
    this.s.dayStartEquity = equity;
  }
  blocked(): string | null {
    if (this.s.killed) return 'Kill switch is on';
    return this.s.haltReason;
  }

  check(i: CheckInput): { ok: true } | { ok: false; reason: string } {
    const { req } = i;
    const notional = req.qty * i.refPrice;
    if (req.side === 'sell') return { ok: true };
    const b = this.blocked();
    if (b) return { ok: false, reason: b + ': buys are paused' };
    if (notional < this.limits.minNotional)
      return { ok: false, reason: `Order is under the $${this.limits.minNotional} minimum` };
    if (i.equity <= 0) return { ok: false, reason: 'No equity' };
    const orderPct = (notional / i.equity) * 100;
    if (orderPct > this.limits.maxOrderPct + 1e-9)
      return { ok: false, reason: `Order is ${orderPct.toFixed(1)}% of equity, limit is ${this.limits.maxOrderPct}%` };
    const posPct = ((i.positionValue + notional) / i.equity) * 100;
    if (posPct > this.limits.maxPositionPct + 1e-9)
      return { ok: false, reason: `Position would be ${posPct.toFixed(1)}% of equity, limit is ${this.limits.maxPositionPct}%` };
    return { ok: true };
  }
}
