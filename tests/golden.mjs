// Generates server/tests/golden.json: TypeScript backtest results the Python port must reproduce.
import fs from 'node:fs';
import { runBacktest, runSweep } from '../.test-build/core/backtest.js';
import { STRATEGIES, defaultParams } from '../.test-build/core/strategies.js';
import { computeStats } from '../.test-build/core/stats.js';
import { SyntheticSource, ticksFor } from '../.test-build/core/feeds.js';
import { PaperExchange } from '../.test-build/core/paper.js';
import { RiskManager } from '../.test-build/core/risk.js';
import { Engine } from '../.test-build/core/engine.js';
import { mulberry32 } from '../.test-build/core/util.js';
const raw = JSON.parse(fs.readFileSync(new URL('../data/candles.json', import.meta.url))).candles;
const RULES = {
  'BTC-USD': { symbol: 'BTC-USD', base: 'BTC', quote: 'USD', minQty: 0.00001, qtyStep: 0.00000001, priceStep: 0.01 },
  'ETH-USD': { symbol: 'ETH-USD', base: 'ETH', quote: 'USD', minQty: 0.001, qtyStep: 0.000001, priceStep: 0.01 },
  'SOL-USD': { symbol: 'SOL-USD', base: 'SOL', quote: 'USD', minQty: 0.001, qtyStep: 0.000001, priceStep: 0.001 },
};
const out = { backtests: [], synthetic: null, stats: [], sweeps: [], scenarios: [] };

// Scenario: two bots plus seeded random manual orders (market, limit, stop, brackets, cancels, kill switch).
// The Python tests replay the identical script and compare every fill, order and balance.
function scenario(seed) {
  const syms = ['BTC-USD', 'ETH-USD'];
  const rules = syms.map((x) => RULES[x]);
  const ex = new PaperExchange({}, rules);
  const risk = new RiskManager({}, ex.cfg.startingCash);
  const eng = new Engine(ex, risk, 3600000, 100000);
  eng.addBot({ strategyId: 'sma-cross', symbol: 'BTC-USD', allocPct: 20, stopPct: 5, enabled: true });
  eng.addBot({ strategyId: 'bollinger', symbol: 'ETH-USD', allocPct: 15, stopPct: 4, enabled: true });
  const cs = Object.fromEntries(syms.map((x) => [x, raw[x].map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }))]));
  const rng = mulberry32(seed);
  const rd = (x, k) => Math.round(x * k) / k;
  const results = [];
  const n = 700;
  for (let i = 0; i < n; i++) {
    const tk = syms.map((x) => ticksFor(x, cs[x][i], 4, 3600000));
    for (let k = 0; k < 4; k++) for (let j = 0; j < syms.length; j++) eng.tick(tk[j][k]);
    if (i % 7 !== 6) continue;
    const sym = syms[Math.floor(rng() * 2)];
    const mark = ex.mark(sym);
    const r = rng();
    let res = null;
    const big = sym === 'BTC-USD' ? 1 : 20;
    if (r < 0.25) {
      const req = { symbol: sym, side: 'buy', type: 'market', qty: rd((0.01 + rng() * 0.04) * big, 1000) };
      if (rng() < 0.5) req.bracket = { stopPct: 3, tpPct: rng() < 0.5 ? 6 : 0 };
      res = eng.placeManual(req);
    } else if (r < 0.4) {
      res = eng.placeManual({ symbol: sym, side: 'buy', type: 'limit', qty: rd((0.01 + rng() * 0.03) * big, 1000), price: rd(mark * (1 - rng() * 0.03), 100) });
    } else if (r < 0.5) {
      const q = rd(ex.availableQty(sym) * 0.5, 1000);
      if (q > 0) res = eng.placeManual({ symbol: sym, side: 'sell', type: 'stop', qty: q, price: rd(mark * 0.97, 100) });
    } else if (r < 0.6) {
      const q = rd(ex.availableQty(sym), 1000);
      if (q > 0) res = eng.placeManual({ symbol: sym, side: 'sell', type: 'market', qty: q });
    } else if (r < 0.66) {
      const open = ex.openOrders();
      if (open.length) ex.cancel(open[Math.floor(rng() * open.length)].id);
    } else if (r < 0.68) {
      eng.kill(ex.now);
    } else if (r < 0.7) {
      risk.reset(ex.equity());
    }
    results.push(res ? (res.ok ? 'ok' : res.reason) : 'skip');
  }
  const pos = [...ex.positions.values()].map((p) => ({ symbol: p.symbol, qty: p.qty, cost: p.cost })).sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  return {
    seed,
    results,
    fills: ex.fills.map((f) => ({ id: f.id, symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, fee: f.fee, t: f.t, source: f.source, maker: f.maker, realized: f.realized })),
    orders: ex.orders.map((o) => ({ id: o.id, status: o.status, type: o.type, qty: o.qty, price: o.price ?? null, group: o.group ?? null })),
    cash: ex.cash,
    equity: ex.equity(),
    feesPaid: ex.feesPaid,
    positions: pos,
    killed: risk.s.killed,
  };
}
for (const sd of [1, 3, 4, 5, 6]) out.scenarios.push(scenario(sd));

for (const sym of Object.keys(raw)) {
  const candles = raw[sym].map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
  for (const s of STRATEGIES) {
    for (const stop of [0, 5]) {
      const r = runBacktest({ symbol: sym, rules: RULES[sym], candles, candleMs: 3600000, strategyId: s.id, params: defaultParams(s), allocPct: 20, stopPct: stop });
      out.stats.push({ symbol: sym, strategy: s.id, stop, stats: computeStats({ fills: r.fills, equityLog: r.equity, startCash: 10000, equity: r.equity[r.equity.length - 1].e }) });
      out.backtests.push({ symbol: sym, strategy: s.id, stop, metrics: r.metrics, fills: r.fills.length, lastEquity: r.equity[r.equity.length - 1].e });
    }
  }
}
for (const [sym, sid] of [['BTC-USD', 'sma-cross'], ['ETH-USD', 'bollinger'], ['SOL-USD', 'rsi-revert']]) {
  const candles = raw[sym].map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
  const s = STRATEGIES.find((x) => x.id === sid) || STRATEGIES[0];
  const o = { symbol: sym, rules: RULES[sym], candles, candleMs: 3600000, strategyId: s.id, params: defaultParams(s), allocPct: 20, stopPct: 5 };
  out.sweeps.push({ symbol: sym, strategy: s.id, result: runSweep(o) });
}
const last = { 'BTC-USD': 70000, 'ETH-USD': 3000 }, vol = { 'BTC-USD': 5, 'ETH-USD': 80 };
const src = new SyntheticSource(42, last, vol, 1800000000000, 3600000, 0);
const bars = [];
for (let i = 0; i < 20; i++) bars.push(src.next());
out.synthetic = bars.map((b) => ({ btc: b['BTC-USD'], eth: b['ETH-USD'] }));
fs.writeFileSync('server/tests/golden.json', JSON.stringify(out, null, 1));
console.log(out.backtests.length, 'cases');
