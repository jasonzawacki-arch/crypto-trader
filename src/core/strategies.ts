import type { Strategy, StrategyContext } from './types.js';
import { atr, highest, lowest, rsi, sma, stdev } from './indicators.js';

const closes = (c: StrategyContext) => c.candles.map((x) => x.c);

export const STRATEGIES: Strategy[] = [
  {
    id: 'sma-cross',
    name: 'Trend cross',
    blurb: 'Buys when the fast average crosses above the slow one and sells when it crosses back.',
    params: [
      { key: 'fast', label: 'Fast average (candles)', min: 2, max: 100, step: 1, def: 12 },
      { key: 'slow', label: 'Slow average (candles)', min: 5, max: 300, step: 1, def: 48 },
    ],
    warmup: (p) => Math.max(p.fast, p.slow) + 2,
    onCandle(p, ctx) {
      const c = closes(ctx);
      const n = c.length;
      const f1 = sma(c, p.fast, n),
        s1 = sma(c, p.slow, n),
        f0 = sma(c, p.fast, n - 1),
        s0 = sma(c, p.slow, n - 1);
      if (f1 == null || s1 == null || f0 == null || s0 == null) return { type: 'hold' };
      if (!ctx.inPosition && f0 <= s0 && f1 > s1) return { type: 'buy', note: `fast ${f1.toFixed(2)} crossed above slow ${s1.toFixed(2)}` };
      if (ctx.inPosition && f0 >= s0 && f1 < s1) return { type: 'sell', note: `fast ${f1.toFixed(2)} crossed below slow ${s1.toFixed(2)}` };
      return { type: 'hold' };
    },
  },
  {
    id: 'rsi-revert',
    name: 'Dip buyer',
    blurb: 'Buys when RSI is oversold and sells once it recovers. Works in ranges, struggles in steady downtrends.',
    params: [
      { key: 'period', label: 'RSI period (candles)', min: 2, max: 50, step: 1, def: 14 },
      { key: 'buyBelow', label: 'Buy below RSI', min: 5, max: 50, step: 1, def: 30 },
      { key: 'sellAbove', label: 'Sell above RSI', min: 40, max: 95, step: 1, def: 55 },
    ],
    warmup: (p) => p.period + 3,
    onCandle(p, ctx) {
      const r = rsi(closes(ctx), p.period);
      if (r == null) return { type: 'hold' };
      if (!ctx.inPosition && r < p.buyBelow) return { type: 'buy', note: `RSI ${r.toFixed(1)} below ${p.buyBelow}` };
      if (ctx.inPosition && r > p.sellAbove) return { type: 'sell', note: `RSI ${r.toFixed(1)} above ${p.sellAbove}` };
      return { type: 'hold' };
    },
  },
  {
    id: 'donchian',
    name: 'Breakout',
    blurb: 'Buys a new high over the entry window and exits on a new low over the shorter exit window.',
    params: [
      { key: 'entry', label: 'Entry window (candles)', min: 5, max: 300, step: 1, def: 48 },
      { key: 'exit', label: 'Exit window (candles)', min: 3, max: 150, step: 1, def: 24 },
    ],
    warmup: (p) => Math.max(p.entry, p.exit) + 2,
    onCandle(p, ctx) {
      const hi = ctx.candles.map((x) => x.h),
        lo = ctx.candles.map((x) => x.l),
        n = ctx.candles.length,
        last = ctx.candles[n - 1];
      const hh = highest(hi, p.entry, n - 1),
        ll = lowest(lo, p.exit, n - 1);
      if (hh == null || ll == null) return { type: 'hold' };
      if (!ctx.inPosition && last.c > hh) return { type: 'buy', note: `closed above ${p.entry}-candle high ${hh.toFixed(2)}` };
      if (ctx.inPosition && last.c < ll) return { type: 'sell', note: `closed below ${p.exit}-candle low ${ll.toFixed(2)}` };
      return { type: 'hold' };
    },
  },
  {
    id: 'atr-break',
    name: 'Volatility breakout',
    blurb: 'Buys when price jumps more than a set number of average daily-ranges above its recent average, and sells when it falls back under that average. Few trades, big moves.',
    params: [
      { key: 'period', label: 'Window (candles)', min: 5, max: 200, step: 1, def: 24 },
      { key: 'mult', label: 'Jump size (x average range)', min: 0.5, max: 5, step: 0.1, def: 1.5 },
    ],
    warmup: (p) => p.period + 2,
    onCandle(p, ctx) {
      const c = closes(ctx),
        n = c.length;
      const m = sma(c, p.period, n),
        a = atr(ctx.candles, p.period, n);
      if (m == null || a == null) return { type: 'hold' };
      const last = c[n - 1];
      if (!ctx.inPosition && last > m + p.mult * a) return { type: 'buy', note: `close ${last.toFixed(2)} is ${p.mult} ranges above its ${p.period}-candle average ${m.toFixed(2)}` };
      if (ctx.inPosition && last < m) return { type: 'sell', note: `close ${last.toFixed(2)} fell under its average ${m.toFixed(2)}` };
      return { type: 'hold' };
    },
  },
  {
    id: 'bollinger',
    name: 'Band bounce',
    blurb: 'Buys when price drops well below its recent average (a stretched dip) and sells when it returns to the average. Like the dip buyer, it struggles when prices keep falling.',
    params: [
      { key: 'period', label: 'Window (candles)', min: 5, max: 200, step: 1, def: 20 },
      { key: 'k', label: 'Band width (std. deviations)', min: 0.5, max: 4, step: 0.1, def: 2 },
    ],
    warmup: (p) => p.period + 2,
    onCandle(p, ctx) {
      const c = closes(ctx),
        n = c.length;
      const m = sma(c, p.period, n),
        sd = stdev(c, p.period, n);
      if (m == null || sd == null) return { type: 'hold' };
      const last = c[n - 1];
      if (!ctx.inPosition && last < m - p.k * sd) return { type: 'buy', note: `close ${last.toFixed(2)} below the lower band ${(m - p.k * sd).toFixed(2)}` };
      if (ctx.inPosition && last > m) return { type: 'sell', note: `close ${last.toFixed(2)} back above the average ${m.toFixed(2)}` };
      return { type: 'hold' };
    },
  },
  {
    id: 'dca',
    name: 'Steady buyer (DCA)',
    blurb: 'Buys the same slice of your equity every set number of candles, and never sells. Spreads the entry over time. It ignores the stop setting, and your position-size limit caps how much it can build.',
    params: [{ key: 'every', label: 'Buy every (candles)', min: 1, max: 720, step: 1, def: 24 }],
    accumulate: true,
    warmup: () => 1,
    onCandle(p, ctx) {
      const t = ctx.candles[ctx.candles.length - 1].t;
      return Math.floor(t / 3600000) % p.every === 0 ? { type: 'buy', note: `scheduled purchase (every ${p.every} candles)` } : { type: 'hold' };
    },
  },
  {
    id: 'buy-hold',
    name: 'Buy and hold',
    blurb: 'Buys once and never sells. The baseline every other bot has to beat after costs. If a protective stop sells it, it buys again on the next bar.',
    params: [],
    warmup: () => 1,
    onCandle(_p, ctx) {
      return ctx.inPosition ? { type: 'hold' } : { type: 'buy', note: 'initial purchase' };
    },
  },
];
export const strategyById = (id: string): Strategy => {
  const s = STRATEGIES.find((x) => x.id === id);
  if (!s) throw new Error('Unknown strategy ' + id);
  return s;
};
export const defaultParams = (s: Strategy): Record<string, number> =>
  Object.fromEntries(s.params.map((p) => [p.key, p.def]));
