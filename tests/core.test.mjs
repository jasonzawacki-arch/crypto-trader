import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PaperExchange } from '../.test-build/core/paper.js';
import { RiskManager } from '../.test-build/core/risk.js';
import { Engine } from '../.test-build/core/engine.js';
import { STRATEGIES, strategyById, defaultParams } from '../.test-build/core/strategies.js';
import { rsi, sma } from '../.test-build/core/indicators.js';
import { runBacktest, runSplit } from '../.test-build/core/backtest.js';
import { ReplaySource, SyntheticSource, candlePath, ticksFor } from '../.test-build/core/feeds.js';
import { mulberry32, floorTo } from '../.test-build/core/util.js';

const H = 3600000;
const RULES = [
  { symbol: 'BTC-USD', base: 'BTC', quote: 'USD', minQty: 0.00001, qtyStep: 0.00000001, priceStep: 0.01 },
  { symbol: 'ETH-USD', base: 'ETH', quote: 'USD', minQty: 0.001, qtyStep: 0.000001, priceStep: 0.01 },
];
const ZERO = { takerBps: 0, makerBps: 0, spreadBps: 0, impactCoef: 0, maxImpactBps: 0 };
const mk = (cfg = {}) => {
  const ex = new PaperExchange({ startingCash: 10000, ...cfg }, RULES);
  ex.onTick({ symbol: 'BTC-USD', t: 0, price: 50000, vol: 10 });
  return ex;
};
const tick = (ex, price, t = 1, symbol = 'BTC-USD') => ex.onTick({ symbol, t, price, vol: 10 });
const data = JSON.parse(readFileSync(new URL('../data/candles.json', import.meta.url)));
const toC = (a) => a.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
const BTC = toC(data.candles['BTC-USD']);

test('market buy charges price, fee and spread; equity matches cash plus holdings', () => {
  const ex = mk({ takerBps: 40, makerBps: 20, spreadBps: 10, impactCoef: 0, maxImpactBps: 0 });
  const o = ex.place({ symbol: 'BTC-USD', side: 'buy', type: 'market', qty: 0.1 });
  assert.equal(o.status, 'filled');
  assert.equal(o.fillPrice, 50025); // half of a 10 bps spread
  const fee = 0.1 * 50025 * 0.004;
  assert.ok(Math.abs(ex.cash - (10000 - 0.1 * 50025 - fee)) < 1e-9);
  const p = ex.positions.get('BTC-USD');
  assert.equal(p.qty, 0.1);
  assert.ok(Math.abs(p.cost - (0.1 * 50025 + fee)) < 1e-9);
  assert.ok(Math.abs(ex.equity() - (ex.cash + 0.1 * 50000)) < 1e-9);
});

test('round trip at zero costs returns the price difference', () => {
  const ex = mk(ZERO);
  ex.place({ symbol: 'BTC-USD', side: 'buy', type: 'market', qty: 0.1 });
  tick(ex, 51000);
  const s = ex.place({ symbol: 'BTC-USD', side: 'sell', type: 'market', qty: 0.1 });
  assert.equal(s.status, 'filled');
  assert.ok(Math.abs(ex.realized - 100) < 1e-9);
  assert.ok(Math.abs(ex.cash - 10100) < 1e-9);
  assert.equal(ex.positions.size, 0);
});

test('rejects bad input without changing the account', () => {
  const ex = mk();
  const before = ex.cash;
  const cases = [
    [{ qty: 0 }, /above zero/],
    [{ qty: -1 }, /above zero/],
    [{ qty: NaN }, /above zero/],
    [{ qty: 0.000001 }, /minimum/],
    [{ qty: 1 }, /Not enough cash/],
    [{ side: 'sell', qty: 0.1 }, /Not enough BTC/],
    [{ symbol: 'DOGE-USD', qty: 1 }, /Unknown symbol/],
    [{ type: 'limit', qty: 0.01 }, /Enter a price/],
  ];
  for (const [patch, re] of cases) {
    const o = ex.place({ symbol: 'BTC-USD', side: 'buy', type: 'market', qty: 0.01, ...patch });
    assert.equal(o.status, 'rejected', JSON.stringify(patch));
    assert.match(o.reason, re);
  }
  assert.equal(ex.cash, before);
});

test('quantity is floored to the exchange step', () => {
  const ex = mk(ZERO);
  const o = ex.place({ symbol: 'ETH-USD', side: 'buy', type: 'market', qty: 0.0019999 });
  assert.equal(o.status, 'rejected'); // no ETH price yet
  tick(ex, 2000, 2, 'ETH-USD');
  const o2 = ex.place({ symbol: 'ETH-USD', side: 'buy', type: 'market', qty: 0.0019999 });
  assert.equal(o2.qty, 0.001999);
});

test('resting limit buy fills only when price trades through it, at the limit price, as maker', () => {
  const ex = mk({ takerBps: 40, makerBps: 20, spreadBps: 0, impactCoef: 0, maxImpactBps: 0 });
  const o = ex.place({ symbol: 'BTC-USD', side: 'buy', type: 'limit', qty: 0.1, price: 49000 });
  assert.equal(o.status, 'open');
  assert.ok(o.reserve > 0 && ex.availableCash() < ex.cash);
  tick(ex, 49000); // touching is not a fill
  assert.equal(o.status, 'open');
  tick(ex, 48990);
  assert.equal(o.status, 'filled');
  assert.equal(o.fillPrice, 49000);
  assert.ok(Math.abs(o.fee - 0.1 * 49000 * 0.002) < 1e-9);
  assert.equal(ex.reservedCash(), 0);
});

test('a limit that crosses the market fills immediately as taker', () => {
  const ex = mk({ takerBps: 40, makerBps: 20, spreadBps: 0, impactCoef: 0, maxImpactBps: 0 });
  const o = ex.place({ symbol: 'BTC-USD', side: 'buy', type: 'limit', qty: 0.05, price: 51000 });
  assert.equal(o.status, 'filled');
  assert.equal(o.fillPrice, 50000);
  assert.ok(Math.abs(o.fee - 0.05 * 50000 * 0.004) < 1e-9);
});

test('stop sell triggers on a drop and fills at the worse price after a gap', () => {
  const ex = mk(ZERO);
  ex.place({ symbol: 'BTC-USD', side: 'buy', type: 'market', qty: 0.1 });
  const st = ex.place({ symbol: 'BTC-USD', side: 'sell', type: 'stop', qty: 0.1, price: 48000 });
  assert.equal(st.status, 'open');
  tick(ex, 48500);
  assert.equal(st.status, 'open');
  tick(ex, 46000); // gapped through the stop
  assert.equal(st.status, 'filled');
  assert.equal(st.fillPrice, 46000);
  assert.ok(ex.realized < -399 && ex.realized > -401);
});

test('stop on the wrong side of the market is refused', () => {
  const ex = mk(ZERO);
  ex.place({ symbol: 'BTC-USD', side: 'buy', type: 'market', qty: 0.1 });
  assert.equal(ex.place({ symbol: 'BTC-USD', side: 'sell', type: 'stop', qty: 0.1, price: 51000 }).status, 'rejected');
});

test('open orders reserve cash and coins so they cannot be spent twice', () => {
  const ex = mk(ZERO);
  assert.equal(ex.place({ symbol: 'BTC-USD', side: 'buy', type: 'limit', qty: 0.15, price: 49000 }).status, 'open');
  const second = ex.place({ symbol: 'BTC-USD', side: 'buy', type: 'limit', qty: 0.15, price: 49000 });
  assert.equal(second.status, 'rejected');
  ex.place({ symbol: 'BTC-USD', side: 'buy', type: 'market', qty: 0.05 });
  assert.equal(ex.place({ symbol: 'BTC-USD', side: 'sell', type: 'limit', qty: 0.04, price: 55000 }).status, 'open');
  assert.equal(ex.place({ symbol: 'BTC-USD', side: 'sell', type: 'market', qty: 0.04 }).status, 'rejected');
});

test('cancelling releases the reservation', () => {
  const ex = mk(ZERO);
  const o = ex.place({ symbol: 'BTC-USD', side: 'buy', type: 'limit', qty: 0.15, price: 49000 });
  assert.ok(ex.cancel(o.id));
  assert.equal(ex.reservedCash(), 0);
  assert.equal(ex.place({ symbol: 'BTC-USD', side: 'buy', type: 'limit', qty: 0.15, price: 49000 }).status, 'open');
});

test('bigger orders get more slippage, capped', () => {
  const ex = mk({ takerBps: 0, spreadBps: 0, impactCoef: 10, maxImpactBps: 100 });
  const small = ex.quote('BTC-USD', 'buy', 0.001);
  const big = ex.quote('BTC-USD', 'buy', 5);
  assert.ok(big > small);
  assert.ok(big <= 50000 * 1.01 + 0.01);
});

test('property: accounting holds across 300 random sessions', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = mulberry32(seed);
    const ex = new PaperExchange({ startingCash: 10000, takerBps: 40, makerBps: 20, spreadBps: 6 }, RULES);
    let price = 50000;
    ex.onTick({ symbol: 'BTC-USD', t: 0, price, vol: 10 });
    for (let i = 1; i < 200; i++) {
      price *= 1 + (r() - 0.5) * 0.02;
      ex.onTick({ symbol: 'BTC-USD', t: i * 60000, price, vol: 10 });
      const x = r();
      const side = r() < 0.5 ? 'buy' : 'sell';
      const type = x < 0.5 ? 'market' : x < 0.8 ? 'limit' : 'stop';
      const px = type === 'market' ? undefined : price * (1 + (r() - 0.5) * 0.04);
      ex.place({ symbol: 'BTC-USD', side, type, qty: r() * 0.2, price: px });
      if (r() < 0.1) ex.cancelAll();
      assert.ok(ex.cash >= -1e-6, 'cash went negative, seed ' + seed);
      for (const p of ex.positions.values()) assert.ok(p.qty > 0, 'position qty');
      assert.ok(ex.reservedCash() <= ex.cash + 1e-6, 'over-reserved cash');
    }
    // Equity moved only by realized profit and open profit. Fees are inside both.
    const drift = ex.equity() - 10000 - (ex.realized + ex.unrealized());
    assert.ok(Math.abs(drift) < 1e-6, `ledger drift ${drift} at seed ${seed}`);
  }
});

test('snapshot and restore reproduce the account exactly', () => {
  const ex = mk();
  ex.place({ symbol: 'BTC-USD', side: 'buy', type: 'market', qty: 0.1 });
  ex.place({ symbol: 'BTC-USD', side: 'sell', type: 'limit', qty: 0.05, price: 60000 });
  const snap = ex.snapshot();
  const b = new PaperExchange({}, RULES);
  b.restore(JSON.parse(JSON.stringify(snap)));
  assert.deepEqual(b.snapshot(), snap);
  assert.equal(b.equity(), ex.equity());
});

test('risk: size limits, kill switch and halts only block buys', () => {
  const risk = new RiskManager({ maxOrderPct: 25, maxPositionPct: 40, minNotional: 10 }, 10000);
  const base = { refPrice: 100, equity: 10000, positionValue: 0 };
  const buy = (qty, positionValue = 0) => risk.check({ ...base, positionValue, req: { symbol: 'X', side: 'buy', type: 'market', qty } });
  assert.equal(buy(20).ok, true); // $2,000
  assert.equal(buy(30).ok, false); // $3,000 is 30%
  assert.equal(buy(20, 3000).ok, false); // 50% position
  assert.equal(buy(0.01).ok, false); // $1 under the minimum
  risk.kill();
  assert.equal(buy(20).ok, false);
  assert.equal(risk.check({ ...base, req: { symbol: 'X', side: 'sell', type: 'market', qty: 5 } }).ok, true);
  risk.reset(10000);
  assert.equal(buy(20).ok, true);
});

test('risk: daily loss halts buys and clears on the next day', () => {
  const risk = new RiskManager({ maxDailyLossPct: 3 }, 10000);
  risk.update(0, 10000);
  risk.update(1000, 9800);
  assert.equal(risk.blocked(), null);
  risk.update(2000, 9690);
  assert.match(risk.blocked(), /Daily loss/);
  risk.update(86400000 + 5, 9690);
  assert.equal(risk.blocked(), null);
});

test('risk: drawdown halt stays until reset', () => {
  const risk = new RiskManager({ maxDailyLossPct: 99, maxDrawdownPct: 10 }, 10000);
  risk.update(0, 10000);
  risk.update(86400000, 10500);
  risk.update(2 * 86400000, 9400);
  assert.match(risk.blocked(), /Drawdown/);
  risk.update(3 * 86400000, 10400);
  assert.match(risk.blocked(), /Drawdown/);
  risk.reset(10400);
  assert.equal(risk.blocked(), null);
});

test('indicators', () => {
  assert.equal(sma([1, 2, 3, 4, 5], 3), 4);
  assert.equal(sma([1, 2], 3), null);
  assert.equal(rsi(Array.from({ length: 30 }, (_, i) => i), 14), 100);
  assert.equal(rsi(Array.from({ length: 30 }, (_, i) => 100 - i), 14), 0);
  const flat = rsi(Array(30).fill(5), 14);
  assert.equal(flat, 50);
  assert.equal(floorTo(0.1 + 0.2, 0.01), 0.3);
});

test('candle path visits open, both extremes and close in order', () => {
  const up = { t: 0, o: 100, h: 110, l: 95, c: 108, v: 1 };
  const p = candlePath(up, 10);
  assert.equal(p[0], 100);
  assert.equal(p[3], 95);
  assert.equal(p[6], 110);
  assert.equal(p[9], 108);
  assert.ok(Math.max(...p) === 110 && Math.min(...p) === 95);
  const down = { t: 0, o: 100, h: 110, l: 90, c: 92, v: 1 };
  const q = candlePath(down, 4);
  assert.deepEqual(q, [100, 110, 90, 92]);
  const ts = ticksFor('X', up, 10, H);
  assert.ok(ts.every((x, i) => i === 0 || x.t > ts[i - 1].t) && ts[9].t < H);
});

test('real candle data is valid and gap free', () => {
  for (const [sym, rows] of Object.entries(data.candles)) {
    for (let i = 0; i < rows.length; i++) {
      const [t, o, h, l, c, v] = rows[i];
      assert.ok(h >= Math.max(o, c) && l <= Math.min(o, c) && v >= 0, sym + ' bad bar ' + i);
      if (i) assert.equal(t - rows[i - 1][0], H, sym + ' gap ' + i);
    }
  }
});

test('synthetic market is deterministic and valid', () => {
  const mkS = (seed) => new SyntheticSource(seed, { 'BTC-USD': 80000 }, { 'BTC-USD': 8 }, 0, H, 50);
  const a = mkS(7), b = mkS(7), c = mkS(8);
  const A = [], B = [], C = [];
  for (let i = 0; i < 100; i++) { A.push(a.next()['BTC-USD']); B.push(b.next()['BTC-USD']); C.push(c.next()['BTC-USD']); }
  assert.deepEqual(A, B);
  assert.notDeepEqual(A, C);
  for (const x of A) assert.ok(x.h >= Math.max(x.o, x.c) && x.l <= Math.min(x.o, x.c) && x.l > 0);
});

test('replay source gives history first and then bars in order', () => {
  const src = new ReplaySource({ 'BTC-USD': BTC }, 300);
  assert.equal(src.history()['BTC-USD'].length, 300);
  const b = src.next();
  assert.equal(b['BTC-USD'].t, BTC[300].t);
  assert.equal(src.index, 301);
});

const bt = (strategyId, params, extra = {}) =>
  runBacktest({ symbol: 'BTC-USD', rules: RULES[0], candles: BTC, candleMs: H, strategyId, params, allocPct: 90, stopPct: 0, ...extra });

test('backtest is deterministic', () => {
  const a = bt('sma-cross', { fast: 12, slow: 48 });
  const b = bt('sma-cross', { fast: 12, slow: 48 });
  assert.deepEqual(a.metrics, b.metrics);
  assert.deepEqual(a.fills, b.fills);
});

test('buy and hold bot lands near the market return, minus costs', () => {
  const r = bt('buy-hold', {}, { paper: { takerBps: 0, makerBps: 0, spreadBps: 0, impactCoef: 0 }, risk: { maxOrderPct: 100, maxPositionPct: 100 }, allocPct: 99 });
  // Invests about 99% so the result is 99% of the price move.
  const expected = r.metrics.buyHoldPct * 0.99;
  assert.ok(Math.abs(r.metrics.returnPct - expected) < 0.6, `${r.metrics.returnPct} vs ${expected}`);
  assert.equal(r.metrics.trades, 0);
});

test('costs reduce results', () => {
  const free = bt('sma-cross', { fast: 6, slow: 24 }, { paper: ZERO, risk: { maxOrderPct: 100, maxPositionPct: 100 } });
  const paid = bt('sma-cross', { fast: 6, slow: 24 }, { paper: { takerBps: 40, makerBps: 20, spreadBps: 6 }, risk: { maxOrderPct: 100, maxPositionPct: 100 } });
  assert.ok(free.metrics.trades > 5);
  assert.ok(paid.metrics.returnPct < free.metrics.returnPct);
  assert.ok(paid.metrics.feesPaid > 0);
});

test('no look-ahead: bot orders fill at the first price of the bar after the signal', () => {
  const r = bt('sma-cross', { fast: 6, slow: 24 }, { risk: { maxOrderPct: 100, maxPositionPct: 100 } });
  assert.ok(r.fills.length > 2);
  for (const f of r.fills.filter((x) => x.source !== 'manual')) {
    assert.equal(f.t % H, 0, 'bot market fills happen on a bar open');
  }
});

test('every strategy runs on every symbol without errors and respects risk limits', () => {
  for (const s of STRATEGIES) {
    for (const [sym, rows] of Object.entries(data.candles)) {
      const rule = RULES.find((x) => x.symbol === sym) || { symbol: sym, base: sym.split('-')[0], quote: 'USD', minQty: 0.001, qtyStep: 0.001, priceStep: 0.001 };
      const res = runBacktest({ symbol: sym, rules: rule, candles: toC(rows), candleMs: H, strategyId: s.id, params: defaultParams(s), allocPct: 20, stopPct: 5 });
      assert.ok(Number.isFinite(res.metrics.returnPct), s.id + sym);
      assert.ok(res.metrics.maxDrawdownPct >= 0 && res.metrics.maxDrawdownPct <= 100);
      for (const f of res.fills) assert.ok(f.qty > 0 && f.price > 0);
    }
  }
});

test('stop loss caps a losing trade near the stop distance', () => {
  // Constructed market: buy-hold bot enters, price falls 20%, 5% stop should exit.
  const candles = [];
  let p = 100;
  for (let i = 0; i < 40; i++) {
    const o = p;
    p = i < 5 ? p : p * 0.99;
    candles.push({ t: i * H, o, h: Math.max(o, p) * 1.001, l: Math.min(o, p) * 0.999, c: p, v: 1000 });
  }
  const r = runBacktest({ symbol: 'BTC-USD', rules: { ...RULES[0], minQty: 0.001, qtyStep: 0.001 }, candles, candleMs: H, strategyId: 'buy-hold', params: {}, allocPct: 20, stopPct: 5, paper: ZERO });
  const sell = r.fills.find((f) => f.side === 'sell');
  assert.ok(sell, 'stop fired');
  assert.ok(sell.price > 100 * 0.93 && sell.price < 100 * 0.96, 'exit near -5%: ' + sell.price);
  assert.ok(sell.realized > -0.012 * 10000 && sell.realized < 0, 'first loss is about 1% of equity: ' + sell.realized);
});

test('split backtest gives separate train and test accounts', () => {
  const s = runSplit({ symbol: 'BTC-USD', rules: RULES[0], candles: BTC, candleMs: H, strategyId: 'donchian', params: { entry: 48, exit: 24 }, allocPct: 20, stopPct: 5 });
  assert.equal(s.train.metrics.candles + s.test.metrics.candles, BTC.length);
  assert.equal(s.train.metrics.startEquity, 10000);
  assert.equal(s.test.metrics.startEquity, 10000);
});

test('engine: kill switch stops bots, cancels buys, keeps stops, blocks new buys', () => {
  const ex = new PaperExchange({ startingCash: 10000, ...ZERO }, RULES);
  const risk = new RiskManager({}, 10000);
  const eng = new Engine(ex, risk, H);
  ex.onTick({ symbol: 'BTC-USD', t: 0, price: 50000, vol: 10 });
  const id = eng.addBot({ strategyId: 'buy-hold', symbol: 'BTC-USD', allocPct: 20, stopPct: 5, enabled: true });
  eng.placeManual({ symbol: 'BTC-USD', side: 'buy', type: 'market', qty: 0.04 });
  ex.place({ symbol: 'BTC-USD', side: 'sell', type: 'stop', qty: 0.04, price: 45000, source: 'manual' });
  ex.place({ symbol: 'BTC-USD', side: 'buy', type: 'limit', qty: 0.01, price: 40000 });
  eng.kill(1);
  assert.equal(eng.bot(id).cfg.enabled, false);
  assert.equal(ex.openOrders().filter((o) => o.side === 'buy').length, 0);
  assert.equal(ex.openOrders().filter((o) => o.type === 'stop').length, 1);
  assert.equal(eng.placeManual({ symbol: 'BTC-USD', side: 'buy', type: 'market', qty: 0.01 }).ok, false);
  assert.equal(eng.placeManual({ symbol: 'BTC-USD', side: 'sell', type: 'market', qty: 0.01 }).ok, false); // 0.04 is held by the stop
});

const mkEng = () => {
  const ex = mk({ ...ZERO });
  return { ex, eng: new Engine(ex, new RiskManager({}, 10000), H) };
};
test('OCO bracket: exits share one reservation and the filled leg cancels the other', () => {
  const { ex, eng } = mkEng();
  const r = eng.placeManual({ symbol: 'BTC-USD', side: 'buy', type: 'market', qty: 0.05, bracket: { stopPct: 5, tpPct: 10 } });
  assert.ok(r.ok);
  const legs = ex.openOrders();
  assert.deepEqual(legs.map((o) => o.type).sort(), ['limit', 'stop']);
  assert.equal(legs[0].group, legs[1].group);
  assert.ok(Math.abs(ex.availableQty('BTC-USD')) < 1e-12);
  assert.equal(ex.place({ symbol: 'BTC-USD', side: 'sell', type: 'market', qty: 0.01 }).reason, 'Not enough BTC to sell');
  tick(ex, 47000);
  assert.equal(ex.openOrders().length, 0);
  assert.equal(ex.fills.length, 2);
  assert.ok(ex.fills[1].realized < 0);
  assert.ok(ex.orders.filter((o) => o.type === 'limit').every((o) => o.status === 'cancelled'));
});
test('OCO bracket: take-profit fill cancels the stop; single leg and resting buys work', () => {
  const a = mkEng();
  a.eng.placeManual({ symbol: 'BTC-USD', side: 'buy', type: 'market', qty: 0.05, bracket: { stopPct: 5, tpPct: 10 } });
  tick(a.ex, 56000);
  assert.equal(a.ex.openOrders().length, 0);
  assert.ok(a.ex.fills[1].realized > 0 && a.ex.fills.length === 2);
  const b = mkEng();
  b.eng.placeManual({ symbol: 'BTC-USD', side: 'buy', type: 'market', qty: 0.05, bracket: { stopPct: 3, tpPct: 0 } });
  assert.deepEqual(b.ex.openOrders().map((o) => o.type), ['stop']);
  const c = mkEng();
  const r = c.eng.placeManual({ symbol: 'BTC-USD', side: 'buy', type: 'limit', qty: 0.05, price: 48000, bracket: { stopPct: 3, tpPct: 6 } });
  assert.equal(r.order.status, 'open');
  assert.equal(c.ex.openOrders().length, 1);
  tick(c.ex, 47900);
  assert.deepEqual(c.ex.openOrders().map((o) => o.type).sort(), ['limit', 'stop']);
});

test('DCA keeps buying while holding and ignores the protective stop; band and ATR bots trade', () => {
  const run = (id, stop) =>
    runBacktest({ symbol: 'BTC-USD', rules: RULES[0], candles: BTC, candleMs: H, strategyId: id, params: defaultParams(strategyById(id)), allocPct: 5, stopPct: stop });
  const d = run('dca', 5);
  const buys = d.fills.filter((f) => f.side === 'buy').length;
  assert.ok(buys > 3, 'several buys until the 40% position cap: ' + buys);
  assert.equal(d.fills.filter((f) => f.side === 'sell').length, 0);
  assert.equal(d.fills.filter((f) => f.source === 'stop').length, 0);
  assert.ok(run('bollinger', 5).metrics.trades > 0);
  assert.ok(run('atr-break', 0).fills.length > 0);
});

test('journal tags: a sell takes its own tag or the latest tagged buy of that coin', async () => {
  const { statsByTag } = await import('../.test-build/core/stats.js');
  const f = (id, side, realized = 0) => ({ id, side, symbol: 'BTC-USD', source: 'manual', realized, fee: 1 });
  const fills = [f('F1', 'buy'), f('F2', 'sell', 50), f('F3', 'buy'), f('F4', 'sell', -20)];
  const g = statsByTag(fills, { F1: { tag: 'Plan', note: '' }, F4: { tag: 'Panic', note: '' } });
  const by = Object.fromEntries(g.map((x) => [x.key, x]));
  assert.equal(by.Plan.realized, 50);
  assert.equal(by.Panic.realized, -20);
  assert.equal(by.Plan.trades, 1);
});
