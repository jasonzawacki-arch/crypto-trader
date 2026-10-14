import type { Candle, Tick } from './types.js';
import { gauss, mulberry32 } from './util.js';

export type Bars = Record<string, Candle>;
export interface CandleSource {
  readonly symbols: string[];
  /** Candles that happened before the session starts, so charts and indicators have context. */
  history(): Record<string, Candle[]>;
  /** Next bar for every symbol, or null at the end of the data. */
  next(): Bars | null;
  /** Number of bars already delivered. Used to resume a saved session. */
  index: number;
}

/**
 * Price path inside a candle. Bullish bars dip to the low first, bearish bars spike to the high first.
 * With n = 3k + 1 points the path passes exactly through open, both extremes and close.
 */
export function candlePath(c: Candle, n: number): number[] {
  const bull = c.c >= c.o;
  const v = bull ? [c.o, c.l, c.h, c.c] : [c.o, c.h, c.l, c.c];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0 : (i / (n - 1)) * 3;
    const k = Math.min(2, Math.floor(u + 1e-9));
    out.push(v[k] + (v[k + 1] - v[k]) * (u - k));
  }
  out[0] = c.o;
  out[n - 1] = c.c;
  return out;
}

export function ticksFor(symbol: string, c: Candle, n: number, candleMs: number): Tick[] {
  return candlePath(c, n).map((price, i) => ({
    symbol,
    price,
    vol: c.v,
    t: c.t + Math.floor((i / n) * candleMs),
  }));
}

export class ReplaySource implements CandleSource {
  index: number;
  readonly symbols: string[];
  constructor(
    private data: Record<string, Candle[]>,
    private start: number,
  ) {
    this.symbols = Object.keys(data);
    this.index = start;
  }
  history(): Record<string, Candle[]> {
    return Object.fromEntries(this.symbols.map((s) => [s, this.data[s].slice(0, this.start)]));
  }
  next(): Bars | null {
    const out: Bars = {};
    for (const s of this.symbols) {
      const c = this.data[s][this.index];
      if (!c) return null;
      out[s] = c;
    }
    this.index++;
    return out;
  }
  remaining(): number {
    return this.data[this.symbols[0]].length - this.index;
  }
}

interface Regime {
  mu: number;
  sigma: number;
}
const REGIMES: Regime[] = [
  { mu: 0.0004, sigma: 0.006 }, // grind up
  { mu: -0.0005, sigma: 0.009 }, // sell-off
  { mu: 0, sigma: 0.004 }, // chop
];

/** A seeded, regime-switching random market. Same seed, same market, so results can be compared. */
export class SyntheticSource implements CandleSource {
  index = 0;
  readonly symbols: string[];
  private rng: () => number;
  private px: Record<string, number>;
  private t: number;
  private regime = 2;
  private hist: Record<string, Candle[]> = {};
  constructor(
    seed: number,
    private startPrices: Record<string, number>,
    private baseVol: Record<string, number>,
    startT: number,
    private candleMs: number,
    warmup: number,
  ) {
    this.symbols = Object.keys(startPrices);
    this.rng = mulberry32(seed);
    this.px = { ...startPrices };
    this.t = startT;
    this.symbols.forEach((s) => (this.hist[s] = []));
    for (let i = 0; i < warmup; i++) {
      const b = this.gen();
      this.symbols.forEach((s) => this.hist[s].push(b[s]));
    }
    this.index = 0;
  }
  history(): Record<string, Candle[]> {
    return this.hist;
  }
  private gen(): Bars {
    const r = this.rng;
    if (r() < 0.02) this.regime = Math.floor(r() * REGIMES.length);
    const g = REGIMES[this.regime];
    const zm = gauss(r);
    const out: Bars = {};
    for (const s of this.symbols) {
      const z = 0.6 * zm + 0.8 * gauss(r);
      const o = this.px[s];
      const c = o * Math.exp(g.mu - 0.5 * g.sigma ** 2 + g.sigma * z);
      const wick = (x: number) => Math.abs(gauss(r)) * g.sigma * 0.45 * x;
      const h = Math.max(o, c) * (1 + wick(1));
      const l = Math.min(o, c) * (1 - wick(1));
      const v = this.baseVol[s] * Math.exp(0.4 * gauss(r)) * (1 + Math.abs(z) * 0.5);
      out[s] = { t: this.t, o, h, l, c, v };
      this.px[s] = c;
    }
    this.t += this.candleMs;
    return out;
  }
  next(): Bars | null {
    this.index++;
    return this.gen();
  }
}
