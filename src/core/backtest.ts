import type { Candle, SymbolRules } from './types.js';
import { Engine } from './engine.js';
import { PaperExchange, type PaperConfig } from './paper.js';
import { RiskManager, type RiskLimits } from './risk.js';
import { ticksFor } from './feeds.js';
import { strategyById } from './strategies.js';

export interface BacktestOptions {
  symbol: string;
  rules: SymbolRules;
  candles: Candle[];
  candleMs: number;
  strategyId: string;
  params: Record<string, number>;
  allocPct: number;
  stopPct: number;
  paper?: Partial<PaperConfig>;
  risk?: Partial<RiskLimits>;
}
export interface Metrics {
  startEquity: number;
  endEquity: number;
  returnPct: number;
  buyHoldPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  trades: number;
  winRatePct: number | null;
  profitFactor: number | null;
  exposurePct: number;
  feesPaid: number;
  candles: number;
}
export interface BacktestResult {
  metrics: Metrics;
  equity: { t: number; e: number }[];
  hold: { t: number; e: number }[];
  fills: ReturnType<PaperExchange['snapshot']>['fills'];
  warnings: string[];
}

/** Runs a strategy over candles through the same engine, exchange and risk code the live session uses. */
export function runBacktest(o: BacktestOptions): BacktestResult {
  const ex = new PaperExchange(o.paper || {}, [o.rules]);
  const risk = new RiskManager(o.risk || {}, ex.cfg.startingCash);
  const eng = new Engine(ex, risk, o.candleMs, 100000);
  eng.addBot({
    strategyId: o.strategyId,
    symbol: o.symbol,
    params: o.params,
    allocPct: o.allocPct,
    stopPct: o.stopPct,
    enabled: true,
  });
  const equity: { t: number; e: number }[] = [];
  let inPos = 0;
  for (const c of o.candles) {
    for (const tk of ticksFor(o.symbol, c, 4, o.candleMs)) eng.tick(tk);
    equity.push({ t: c.t, e: ex.equity() });
    if (ex.positions.has(o.symbol)) inPos++;
  }
  const first = o.candles[0],
    last = o.candles[o.candles.length - 1];
  const start = ex.cfg.startingCash;
  const hold = o.candles.map((c) => ({ t: c.t, e: (start * c.c) / first.o }));
  const sells = ex.fills.filter((f) => f.side === 'sell');
  const wins = sells.filter((f) => f.realized > 0);
  const gw = wins.reduce((s, f) => s + f.realized, 0);
  const gl = sells.filter((f) => f.realized < 0).reduce((s, f) => s - f.realized, 0);
  // Hourly returns annualized by candles per year.
  const per = (365 * 24 * 3600 * 1000) / o.candleMs;
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) rets.push(equity[i].e / equity[i - 1].e - 1);
  const mean = rets.reduce((s, x) => s + x, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length || 1));
  let peak = start,
    mdd = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.e);
    mdd = Math.max(mdd, (peak - p.e) / peak);
  }
  const end = equity.length ? equity[equity.length - 1].e : start;
  const m: Metrics = {
    startEquity: start,
    endEquity: end,
    returnPct: (end / start - 1) * 100,
    buyHoldPct: (last.c / first.o - 1) * 100,
    maxDrawdownPct: mdd * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(per) : 0,
    trades: sells.length,
    winRatePct: sells.length ? (wins.length / sells.length) * 100 : null,
    profitFactor: gl > 0 ? gw / gl : null,
    exposurePct: (inPos / (o.candles.length || 1)) * 100,
    feesPaid: ex.feesPaid,
    candles: o.candles.length,
  };
  const warnings: string[] = [];
  const days = (o.candles.length * o.candleMs) / 86400000;
  if (m.trades < 30) warnings.push(`Only ${m.trades} closed trades. That is too few to tell skill from luck.`);
  if (days < 90) warnings.push(`Only ${days.toFixed(0)} days of data. One market regime can flatter any strategy.`);
  if (m.trades === 0) warnings.push('The strategy never traded in this window.');
  return { metrics: m, equity, hold, fills: ex.fills, warnings };
}

/** Runs the same settings on the first part and the rest of the data as separate accounts. */
export function runSplit(o: BacktestOptions, trainFrac = 0.6) {
  const k = Math.floor(o.candles.length * trainFrac);
  return {
    train: runBacktest({ ...o, candles: o.candles.slice(0, k) }),
    test: runBacktest({ ...o, candles: o.candles.slice(k) }),
    splitAt: o.candles[k]?.t ?? 0,
  };
}

export interface SweepRow {
  kind: 'window' | 'param' | 'cost';
  label: string;
  returnPct: number;
  buyHoldPct: number;
  maxDrawdownPct: number;
  trades: number;
}
export interface SweepResult {
  rows: SweepRow[];
  summary: {
    windows: number;
    windowsProfitable: number;
    worstWindowPct: number;
    medianWindowPct: number;
    paramBestPct: number;
    paramWorstPct: number;
    baseReturnPct: number;
    costDoubledPct: number;
    verdict: string[];
  };
}

const rowOf = (kind: SweepRow['kind'], label: string, r: BacktestResult): SweepRow => ({
  kind,
  label,
  returnPct: r.metrics.returnPct,
  buyHoldPct: r.metrics.buyHoldPct,
  maxDrawdownPct: r.metrics.maxDrawdownPct,
  trades: r.metrics.trades,
});

/**
 * "What if" runs: the same bot on several separate slices of history, with each setting nudged by about
 * 20 to 25 percent, and with trading costs doubled. A real edge should survive all three.
 */
export function runSweep(o: BacktestOptions, windows = 4): SweepResult {
  const rows: SweepRow[] = [];
  const base = runBacktest(o);
  const n = o.candles.length;
  const wr: number[] = [];
  for (let w = 0; w < windows; w++) {
    const a = Math.floor((n * w) / windows),
      b = Math.floor((n * (w + 1)) / windows);
    if (b - a < 20) continue;
    const r = runBacktest({ ...o, candles: o.candles.slice(a, b) });
    wr.push(r.metrics.returnPct);
    rows.push(rowOf('window', `Slice ${w + 1} of ${windows}`, r));
  }
  const strat = strategyById(o.strategyId);
  const pr: number[] = [];
  for (const p of strat?.params || []) {
    for (const [name, k] of [['-20%', 0.8], ['+25%', 1.25]] as const) {
      const cur = o.params[p.key] ?? p.def;
      let v = Math.round((cur * k) / p.step) * p.step;
      v = Math.min(p.max, Math.max(p.min, v));
      if (v === cur) continue;
      const r = runBacktest({ ...o, params: { ...o.params, [p.key]: v } });
      pr.push(r.metrics.returnPct);
      rows.push(rowOf('param', `${p.label} ${name} (${+v.toFixed(6)})`, r));
    }
  }
  const cfg = new PaperExchange(o.paper || {}, [o.rules]).cfg;
  let doubled = base.metrics.returnPct;
  for (const k of [2, 3]) {
    const r = runBacktest({
      ...o,
      paper: { ...(o.paper || {}), takerBps: cfg.takerBps * k, makerBps: cfg.makerBps * k, spreadBps: cfg.spreadBps * k },
    });
    if (k === 2) doubled = r.metrics.returnPct;
    rows.push(rowOf('cost', `Fees and spread x${k}`, r));
  }
  const sorted = [...wr].sort((a, b) => a - b);
  const med = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : 0;
  const all = [base.metrics.returnPct, ...pr];
  const s = {
    windows: wr.length,
    windowsProfitable: wr.filter((x) => x > 0).length,
    worstWindowPct: sorted.length ? sorted[0] : 0,
    medianWindowPct: med,
    paramBestPct: Math.max(...all),
    paramWorstPct: Math.min(...all),
    baseReturnPct: base.metrics.returnPct,
    costDoubledPct: doubled,
    verdict: [] as string[],
  };
  if (s.windows && s.windowsProfitable < Math.ceil(s.windows / 2)) s.verdict.push(`Lost money in ${s.windows - s.windowsProfitable} of ${s.windows} slices of history. It works only in some conditions.`);
  if (s.paramWorstPct < 0 && s.baseReturnPct > 0) s.verdict.push('A small nudge to one setting turns it into a loser. The good result may be a lucky setting.');
  if (s.baseReturnPct > 0 && s.costDoubledPct <= 0) s.verdict.push('Profit disappears when fees and spread double. The edge is thinner than the costs.');
  if (s.baseReturnPct <= 0) s.verdict.unshift('It lost money (or made nothing) over the full history with these settings.');
  if (!s.verdict.length) s.verdict.push('No red flags in these runs. That still does not promise future profit.');
  return { rows, summary: s };
}
