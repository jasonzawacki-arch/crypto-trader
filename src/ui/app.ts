import { Session, SPEEDS, H, toCandles, type Backend, type Calibration, type RawData } from './session.js';
import { RemoteSession } from './remote.js';
import { readTheme, drawCandles, drawLines, type CandleGeom, type Theme } from './chart.js';
import { STRATEGIES, strategyById, defaultParams } from '../core/strategies.js';
import { runBacktest, runSplit, runSweep, type BacktestResult, type SweepResult } from '../core/backtest.js';
import { decimals, floorTo } from '../core/util.js';
import type { Fill, OrderType, Side } from '../core/types.js';
import { JOURNAL_TAGS, statsByTag, type Stats } from '../core/stats.js';

declare global {
  interface Window {
    __CANDLES__: { candles: RawData };
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const usd = (x: number, d = 2) => (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sgn = (x: number, d = 2) => (x > 0 ? '+' : x < 0 ? '-' : '') + Math.abs(x).toFixed(d);
const sgnUsd = (x: number) => (x > 0 ? '+' : x < 0 ? '-' : '') + '$' + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const arrow = (x: number) => (x > 0.005 ? '▲ ' : x < -0.005 ? '▼ ' : '');
const cls = (x: number) => (x > 0.005 ? 'up' : x < -0.005 ? 'down' : 'flat');
const pnl = (x: number) => `<span class="${cls(x)}">${arrow(x)}${sgnUsd(x)}</span>`;
const pct = (x: number, d = 2) => `<span class="${cls(x)}">${arrow(x)}${sgn(x, d)}%</span>`;
const qtyStr = (q: number, step: number) => {
  const s = q.toFixed(decimals(step));
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};
const tstr = (t: number) => {
  const d = new Date(t);
  return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

type Tab = 'trade' | 'stats' | 'bots' | 'test' | 'risk';
type Sub = 'pos' | 'ord' | 'fills';
const LOCAL = new Session(window.__CANDLES__.candles);
let S: Backend = LOCAL;

const ui = {
  tab: 'trade' as Tab,
  sub: 'pos' as Sub,
  bars: 120,
  sma: true,
  hover: null as number | null,
  geom: null as CandleGeom | null,
  tk: { side: 'buy' as Side, type: 'market' as OrderType, qty: '', price: '', sl: '', tp: '' },
  bt: { strategy: STRATEGIES[0].id, symbol: 'BTC-USD', params: {} as Record<string, number>, alloc: 20, stop: 5 },
  jr: null as null | string,
  calib: null as null | Calibration,
  audit: null as null | any[],
  sweep: null as null | { label: string; r: SweepResult },
  btRes: null as null | { r: BacktestResult; split: ReturnType<typeof runSplit>; label: string },
  cmp: null as null | { name: string; r: BacktestResult }[],
  newBot: { strategy: STRATEGIES[0].id, symbol: 'BTC-USD' },
  confirm: '' as '' | 'reset',
  confirmTimer: 0 as number,
  theme: 'auto' as 'auto' | 'dark' | 'light',
  notify: false,
  srv: { url: 'http://127.0.0.1:8000', token: '', user: '', pass: '', status: '' as string, busy: false },
};
ui.bt.params = defaultParams(strategyById(ui.bt.strategy));

// ---------- shell
const ICON = {
  trade: '<svg viewBox="0 0 24 24"><path d="M4 18V9M10 18V5M16 18v-7M22 18H2"/></svg>',
  stats: '<svg viewBox="0 0 24 24"><path d="M3 17l5-6 4 3 8-9M3 21h18"/></svg>',
  bots: '<svg viewBox="0 0 24 24"><rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 8V4M9 13h.01M15 13h.01"/></svg>',
  test: '<svg viewBox="0 0 24 24"><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/></svg>',
  risk: '<svg viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>',
  theme: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
};
const PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
const STEP = '<svg viewBox="0 0 24 24"><path d="M5 4l10 8-10 8zM17 4h3v16h-3z"/></svg>';

function shell(): void {
  const app = $('app')!;
  app.innerHTML = `
  <header class="top glass">
    <div class="brand"><b></b>Glass Trader</div>
    <div class="tags"><span class="tag paper">Paper money</span><span class="tag" id="modeTag"></span>
      <button class="iconbtn" data-act="theme" aria-label="Switch theme" title="Theme: auto / dark / light">${ICON.theme}</button></div>
  </header>
  <section class="hero glass" aria-label="Account">
    <div class="stack" style="gap:12px">
      <div class="eq"><span class="big num" id="hEq"></span><span class="chg" id="hDay"></span></div>
      <div class="stats" id="hStats"></div>
    </div>
    <div class="stack" style="gap:10px;justify-items:start">
      <div class="ctrl">
        <button class="btn pri" id="hPlay" data-act="play"></button>
        <button class="btn" data-act="step" title="Advance one bar">${STEP}Bar</button>
        <button class="btn ghost" data-act="restart" id="hRestart">Restart</button>
      </div>
      <div class="ctrl">
        <div class="seg" role="group" aria-label="Speed" id="hSpeed"></div>
        <div class="seg" role="group" aria-label="Market" id="hSym"></div>
      </div>
      <div class="faint num" id="hClock" style="font-size:12px"></div>
    </div>
  </section>
  <div id="banner"></div>
  <main id="view"></main>
  <nav class="dock glass" aria-label="Sections">
    ${(['trade', 'stats', 'bots', 'test', 'risk'] as Tab[]).map((t) => `<button data-act="tab" data-v="${t}">${ICON[t]}${{ trade: 'Trade', stats: 'Stats', bots: 'Bots', test: 'Backtest', risk: 'Risk' }[t]}</button>`).join('')}
  </nav>
  <div id="toast" class="glass" role="status" aria-live="polite"></div>`;
  $('hSpeed')!.innerHTML = SPEEDS.map((s) => `<button data-act="speed" data-v="${s}">${s}×</button>`).join('');
  $('hSym')!.innerHTML = S.symbols().map((s) => `<button data-act="sym" data-v="${s}">${s.split('-')[0]}</button>`).join('');
}

let toastT = 0;
function toast(msg: string): void {
  const t = $('toast')!;
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = window.setTimeout(() => t.classList.remove('on'), 2800);
}

// ---------- views
const field = (label: string, inner: string) => `<label class="f"><span>${label}</span>${inner}</label>`;
const numIn = (key: string, v: number | string, extra = '') => `<input inputmode="decimal" data-f="${key}" value="${v}" ${extra}>`;

function tradeView(): string {
  const r = S.rules();
  const tk = ui.tk;
  const needPx = tk.type !== 'market';
  return `
  <div class="trade">
    <section class="glass card">
      <div class="chead" style="margin-bottom:10px">
        <div class="seg" role="group" aria-label="Market" id="mSym">${S.symbols().map((x) => `<button data-act="sym" data-v="${x}" aria-pressed="${x === S.symbol}">${x.split('-')[0]}</button>`).join('')}</div>
        <span class="num" id="mPx" style="font-weight:600;font-size:18px"></span>
      </div>
      <div class="chead">
        <div class="seg" role="group" aria-label="Bars shown">${[60, 120, 240].map((b) => `<button data-act="bars" data-v="${b}" aria-pressed="${ui.bars === b}">${b}h</button>`).join('')}</div>
        <div class="seg"><button data-act="sma" aria-pressed="${ui.sma}">SMA 20/50</button></div>
      </div>
      <div class="ohlc num" id="ohlc"></div>
      <div class="cvwrap"><canvas class="chart" id="cv" role="img" aria-label="${r.symbol} candlestick chart"></canvas><div id="tip" class="glass" hidden></div></div>
    </section>
    <section class="glass card stack">
      <h3>Order ticket · ${r.symbol}</h3>
      <div class="seg buy-sell ${tk.side}" role="group" aria-label="Side" style="width:100%">
        <button data-act="side" data-v="buy" aria-pressed="${tk.side === 'buy'}" style="flex:1;${tk.side === 'buy' ? 'color:var(--up)' : ''}">Buy</button>
        <button data-act="side" data-v="sell" aria-pressed="${tk.side === 'sell'}" style="flex:1;${tk.side === 'sell' ? 'color:var(--down)' : ''}">Sell</button>
      </div>
      <div class="seg" role="group" aria-label="Order type" style="width:100%">
        ${(['market', 'limit', 'stop'] as OrderType[]).map((t) => `<button data-act="otype" data-v="${t}" aria-pressed="${tk.type === t}" style="flex:1">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
      </div>
      ${tk.type === 'market' ? '<p class="sub faint" style="margin:0;font-size:12px">Tip: tap the chart to set a limit price.</p>' : '<p class="sub faint" style="margin:0;font-size:12px">Tap the chart to move the price.</p>'}
      ${needPx ? field(tk.type === 'limit' ? 'Limit price (USD)' : 'Trigger price (USD)', numIn('tk-price', tk.price, 'id="tkPrice"')) : ''}
      ${field(`Quantity (${r.base})`, numIn('tk-qty', tk.qty, 'id="tkQty"'))}
      <div class="chips" role="group" aria-label="Size shortcuts">${[25, 50, 75, 100].map((p) => `<button class="chip" data-act="chip" data-v="${p}">${p}%</button>`).join('')}</div>
      ${tk.side === 'buy' ? `<div class="grid2">${field('Stop-loss % (optional)', numIn('tk-sl', tk.sl, 'id="tkSl" placeholder="off"'))}${field('Take-profit % (optional)', numIn('tk-tp', tk.tp, 'id="tkTp" placeholder="off"'))}</div>
      <p class="sub faint" style="margin:-4px 0 0;font-size:12px">Set either or both. They are placed the moment the buy fills, and when one triggers the other is cancelled.</p>` : ''}
      <div class="sumrows" id="est"></div>
      <button class="btn ${tk.side}" data-act="submit" id="tkGo" style="width:100%"></button>
      <div class="msg" id="tmsg" aria-live="polite"></div>
      <p class="sub faint" style="margin:0;font-size:12px">${tk.type === 'market' ? 'Fills right away at the quoted price, including spread and size impact.' : tk.type === 'limit' ? 'Rests until the market trades through your price, then fills as a maker.' : 'Triggers at your price and fills at the market. Use it to cap a loss.'}</p>
    </section>
    <section class="glass card wide">
      <div class="chead"><div class="seg" role="tablist">${(
        [['pos', 'Positions'], ['ord', 'Open orders'], ['fills', 'Fills']] as [Sub, string][]
      ).map(([k, l]) => `<button role="tab" data-act="sub" data-v="${k}" aria-pressed="${ui.sub === k}">${l}</button>`).join('')}</div></div>
      <div class="tw" id="tbl"></div>
      ${journalEditor()}
    </section>
    <section class="glass card">
      <h3>Equity curve</h3>
      <canvas class="chart" id="cv2" role="img" aria-label="Account equity over time"></canvas>
    </section>
    <section class="glass card">
      <h3>Activity</h3>
      <div class="log" id="log"></div>
    </section>
  </div>`;
}

function paramInputs(bot: string, strat: ReturnType<typeof strategyById>, p: Record<string, number>): string {
  if (!strat.params.length) return '<p class="sub faint" style="margin:0">No settings.</p>';
  return `<div class="grid2">${strat.params
    .map((d) => field(d.label, `<input type="number" data-f="${bot}p" data-k="${d.key}" min="${d.min}" max="${d.max}" step="${d.step}" value="${p[d.key] ?? d.def}">`))
    .join('')}</div>`;
}

function botsView(): string {
  const e = S.eng;
  const list = e.bots
    .map((b) => {
      const st = strategyById(b.cfg.strategyId);
      return `<article class="glass card stack" data-bot="${b.cfg.id}">
        <div class="bothead"><div><h4>${esc(b.cfg.name)}</h4><div class="sub faint" style="margin:0">${b.cfg.symbol} · ${st.name}</div></div>
        <span class="pill ${b.cfg.enabled ? 'on' : 'off'}" id="bp-${b.cfg.id}"></span></div>
        <p class="sub" style="margin:0">${st.blurb}</p>
        ${paramInputs('b:' + b.cfg.id, st, b.cfg.params)}
        <div class="grid2">
          ${field('Use of equity per entry (%)', `<input type="number" data-f="b:${b.cfg.id}:alloc" min="1" max="40" step="1" value="${b.cfg.allocPct}">`)}
          ${field('Protective stop (%, 0 = off)', `<input type="number" data-f="b:${b.cfg.id}:stop" min="0" max="30" step="0.5" value="${b.cfg.stopPct}">`)}
        </div>
        <div class="sumrows" id="bs-${b.cfg.id}"></div>
        <div class="ctrl">
          <button class="btn ${b.cfg.enabled ? '' : 'pri'}" data-act="botToggle" data-v="${b.cfg.id}">${b.cfg.enabled ? 'Stop bot' : 'Start bot'}</button>
          <button class="btn ghost sm" data-act="botTest" data-v="${b.cfg.id}">Backtest this</button>
          <button class="btn ghost sm" data-act="botDel" data-v="${b.cfg.id}">Remove</button>
        </div>
      </article>`;
    })
    .join('');
  const ns = strategyById(ui.newBot.strategy);
  return `<div class="stack">
    <section class="glass card stack">
      <h3>Add a bot</h3>
      <div class="grid3">
        ${field('Strategy', `<select data-f="nb-strategy">${STRATEGIES.map((s) => `<option value="${s.id}" ${s.id === ui.newBot.strategy ? 'selected' : ''}>${s.name}</option>`).join('')}</select>`)}
        ${field('Market', `<select data-f="nb-symbol">${S.symbols().map((s) => `<option ${s === ui.newBot.symbol ? 'selected' : ''}>${s}</option>`).join('')}</select>`)}
        <div class="f"><span>&nbsp;</span><button class="btn pri" data-act="botAdd" style="min-height:42px">Add bot</button></div>
      </div>
      <p class="sub" style="margin:0">${ns.blurb} New bots start stopped, so you can backtest first.</p>
    </section>
    ${e.bots.length ? `<div class="cards">${list}</div>` : '<div class="glass card empty">No bots yet. Add one above. Bots trade only on closed hourly candles and every entry goes through the same risk checks as your own orders.</div>'}
  </div>`;
}

function testView(): string {
  const b = ui.bt;
  const st = strategyById(b.strategy);
  const res = ui.btRes;
  const m = res?.r.metrics;
  const tile = (l: string, v: string) => `<div class="tile"><small>${l}</small><b>${v}</b></div>`;
  let out = '';
  if (res && m) {
    const sp = res.split;
    const row = (name: string, r: BacktestResult) =>
      `<tr><td>${name}</td><td class="num r">${pct(r.metrics.returnPct)}</td><td class="num r">${pct(r.metrics.buyHoldPct)}</td><td class="num r">${r.metrics.maxDrawdownPct.toFixed(1)}%</td><td class="num r">${r.metrics.trades}</td></tr>`;
    out = `<section class="glass card stack"><h3>Result · ${esc(res.label)}</h3>
      ${res.r.warnings.length ? `<ul class="warns">${res.r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <div class="tiles">
        ${tile('Return', pct(m.returnPct))}${tile('Buy & hold', pct(m.buyHoldPct))}${tile('Max drawdown', m.maxDrawdownPct.toFixed(1) + '%')}
        ${tile('Sharpe', m.sharpe.toFixed(2))}${tile('Trades', String(m.trades))}${tile('Win rate', m.winRatePct == null ? 'n/a' : m.winRatePct.toFixed(0) + '%')}
        ${tile('Profit factor', m.profitFactor == null ? 'n/a' : m.profitFactor.toFixed(2))}${tile('Time in market', m.exposurePct.toFixed(0) + '%')}${tile('Fees paid', usd(m.feesPaid))}
      </div>
      <div class="legend"><span><i style="background:var(--accent)"></i>Strategy</span><span><i style="background:var(--mute)"></i>Buy & hold</span></div>
      <canvas class="chart" id="cvb" role="img" aria-label="Strategy equity against buy and hold"></canvas>
      <h3 style="margin-top:6px">Out-of-sample check</h3>
      <p class="sub" style="margin:0">Same settings on the first 60% of the data and on the last 40%, as separate accounts. A strategy that only works on the first part is probably fitted to it.</p>
      <div class="tw"><table><thead><tr><th>Window</th><th class="r">Return</th><th class="r">Buy & hold</th><th class="r">Max DD</th><th class="r">Trades</th></tr></thead><tbody>
        ${row('First 60%', sp.train)}${row('Last 40%', sp.test)}</tbody></table></div>
    </section>`;
  }
  const cmp = ui.cmp
    ? `<section class="glass card stack"><h3>All strategies · ${b.symbol} · default settings</h3><div class="tw"><table><thead><tr><th>Strategy</th><th class="r">Return</th><th class="r">Buy & hold</th><th class="r">Max DD</th><th class="r">Sharpe</th><th class="r">Trades</th></tr></thead><tbody>
      ${ui.cmp.map((c) => `<tr><td>${esc(c.name)}</td><td class="num r">${pct(c.r.metrics.returnPct)}</td><td class="num r">${pct(c.r.metrics.buyHoldPct)}</td><td class="num r">${c.r.metrics.maxDrawdownPct.toFixed(1)}%</td><td class="num r">${c.r.metrics.sharpe.toFixed(2)}</td><td class="num r">${c.r.metrics.trades}</td></tr>`).join('')}
      </tbody></table></div></section>`
    : '';
  let sw = '';
  if (ui.sweep) {
    const q = ui.sweep.r.summary;
    const rows = ui.sweep.r.rows
      .map((x) => `<tr><td>${esc(x.label)}</td><td class="num r ${x.returnPct >= 0 ? 'up' : 'down'}">${pct(x.returnPct)}</td><td class="num r">${pct(x.buyHoldPct)}</td><td class="num r">${x.maxDrawdownPct.toFixed(1)}%</td><td class="num r">${x.trades}</td></tr>`)
      .join('');
    sw = `<section class="glass card stack"><h3>Stress test · ${esc(ui.sweep.label)}</h3>
      <ul class="warns">${q.verdict.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
      <div class="tiles">${tile('Profitable slices', `${q.windowsProfitable} of ${q.windows}`)}${tile('Worst slice', pct(q.worstWindowPct))}${tile('Median slice', pct(q.medianWindowPct))}
      ${tile('Settings range', `${pct(q.paramWorstPct)} to ${pct(q.paramBestPct)}`)}${tile('Base return', pct(q.baseReturnPct))}${tile('Costs doubled', pct(q.costDoubledPct))}</div>
      <p class="sub" style="margin:0">Each slice is a separate account on a quarter of the history. Setting runs nudge one number at a time. Cost runs multiply fees and spread.</p>
      <div class="tw"><table><thead><tr><th>Run</th><th class="r">Return</th><th class="r">Buy & hold</th><th class="r">Max DD</th><th class="r">Trades</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }
  return `<div class="stack">
    <section class="glass card stack">
      <h3>Backtest</h3>
      <p class="sub" style="margin:0">Runs a strategy over the real Gemini hourly candles in this app (about two months) using the same engine, fees, spread, impact and risk limits as the live paper session. It cannot predict anything. Treat a good result as a reason to look closer, not as a promise.</p>
      <div class="grid3">
        ${field('Strategy', `<select data-f="bt-strategy">${STRATEGIES.map((s) => `<option value="${s.id}" ${s.id === b.strategy ? 'selected' : ''}>${s.name}</option>`).join('')}</select>`)}
        ${field('Market', `<select data-f="bt-symbol">${S.symbols().map((s) => `<option ${s === b.symbol ? 'selected' : ''}>${s}</option>`).join('')}</select>`)}
        ${field('Use of equity (%)', `<input type="number" data-f="bt-alloc" min="1" max="40" step="1" value="${b.alloc}">`)}
      </div>
      <div class="grid3">${st.params
        .map((d) => field(d.label, `<input type="number" data-f="bt-p" data-k="${d.key}" min="${d.min}" max="${d.max}" step="${d.step}" value="${b.params[d.key] ?? d.def}">`))
        .join('')}
        ${field('Protective stop (%)', `<input type="number" data-f="bt-stop" min="0" max="30" step="0.5" value="${b.stop}">`)}</div>
      <div class="ctrl"><button class="btn pri" data-act="btRun">Run backtest</button><button class="btn" data-act="btAll">Compare all strategies</button><button class="btn" data-act="btSweep">Stress test</button></div>
    </section>${sw}${cmp}${out}</div>`;
}

function liveCard(): string {
  return S.feed ? `<div id="liveCard" style="grid-column:1/-1">${liveInner()}</div>` : '';
}
function liveInner(): string {
  const f = S.feed;
  if (!f) return '';
  const rows = Object.entries(f.symbols)
    .map(([s, q]) => `<tr><td>${s}</td><td class="num r">${q.bid == null ? '·' : usd(q.bid)}</td><td class="num r">${q.ask == null ? '·' : usd(q.ask)}</td><td class="num r ${q.ageS != null && q.ageS > f.staleAfterS ? 'down' : ''}">${q.ageS == null ? 'none' : q.ageS.toFixed(0) + 's'}</td></tr>`)
    .join('');
  const c = ui.calib;
  const cal = c
    ? `<ul class="warns">${c.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
       <div class="tiles"><div class="tile"><small>Paper cost vs mid</small><b>${c.paperCostBps == null ? 'n/a' : c.paperCostBps.toFixed(1) + ' bps'}</b></div><div class="tile"><small>Live half-spread</small><b>${c.liveHalfSpreadBps == null ? 'n/a' : c.liveHalfSpreadBps.toFixed(1) + ' bps'}</b></div><div class="tile"><small>Market-style fills</small><b>${c.takerFills}</b></div></div>
       <div class="tw"><table><thead><tr><th>Coin</th><th class="r">Mean spread</th><th class="r">Median</th><th class="r">90th pct</th></tr></thead><tbody>${Object.entries(c.spreads).map(([s, x]) => `<tr><td>${s}</td><td class="num r">${x.meanBps.toFixed(1)} bps</td><td class="num r">${x.medianBps.toFixed(1)} bps</td><td class="num r">${x.p90Bps.toFixed(1)} bps</td></tr>`).join('') || '<tr><td colspan="4" class="faint">No quotes yet.</td></tr>'}</tbody></table></div>`
    : '';
  return `<section class="glass card stack">
    <h3>Live prices</h3>
    <p class="sub" style="margin:0">Real Gemini quotes with paper money. If quotes stop for more than ${f.staleAfterS}s, new buys pause and an alert fires. Sells always work.</p>
    <div class="tw"><table><thead><tr><th>Coin</th><th class="r">Bid</th><th class="r">Ask</th><th class="r">Quote age</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${f.lastError ? `<p class="sub faint" style="margin:0;font-size:12px">Last problem (${f.errors} so far): ${esc(f.lastError)}</p>` : ''}
    <div class="ctrl"><button class="btn" data-act="calib">Compare paper fills with the live market</button></div>${cal}</section>`;
}

function auditCard(): string {
  if (!S.who || S.who.role !== 'admin' || !S.audit || S.who.name === 'local') return '';
  const rows = ui.audit
    ? `<div class="tw"><table><thead><tr><th>Time</th><th>Who</th><th>Action</th><th class="r">Result</th><th>Detail</th></tr></thead><tbody>${ui.audit
        .map((r) => `<tr><td class="num">${tstr(r.t * 1000)}</td><td>${esc(r.user)}${r.role ? ` <span class="faint">${esc(r.role)}</span>` : ''}</td><td>${esc(r.method)} ${esc(r.path.replace('/api/', ''))}</td><td class="num r ${r.status >= 400 ? 'down' : ''}">${r.status}</td><td class="faint" style="max-width:260px;overflow-wrap:anywhere">${esc(r.detail)}</td></tr>`)
        .join('')}</tbody></table></div>`
    : '';
  return `<section class="glass card stack" style="grid-column:1/-1"><h3>Audit log</h3>
    <p class="sub" style="margin:0">Every change made through the server, and every sign-in attempt, with who did it and whether it worked. Signed in as ${esc(S.who.name)}.</p>
    <div class="ctrl"><button class="btn" data-act="audit">${ui.audit ? 'Refresh' : 'Show the latest 60'}</button></div>${rows}</section>`;
}

function riskView(): string {
  const c = S.ex.cfg;
  const l = S.eng.risk.limits;
  const cf = (label: string, key: string, v: number, step = 1, min = 0, max = 1e9) => field(label, `<input type="number" data-f="${key}" value="${v}" step="${step}" min="${min}" max="${max}">`);
  return `<div class="cards">
    <section class="glass card stack">
      <h3>Kill switch</h3>
      <p class="sub" style="margin:0">Stops every bot and cancels resting buy orders. Protective stops stay in place so open positions keep their safety net. Sells always work.</p>
      <div id="killState"></div>
      <div class="ctrl"><button class="btn danger" data-act="kill">Kill switch</button><button class="btn" data-act="resume">Resume trading</button></div>
    </section>
    <section class="glass card stack">
      <h3>Risk limits</h3>
      <div class="grid2">
        ${cf('Largest order (% equity)', 'r-maxOrderPct', l.maxOrderPct, 1, 1, 100)}${cf('Largest position (% equity)', 'r-maxPositionPct', l.maxPositionPct, 1, 1, 100)}
        ${cf('Daily loss halt (%)', 'r-maxDailyLossPct', l.maxDailyLossPct, 0.5, 0.5, 50)}${cf('Drawdown halt (%)', 'r-maxDrawdownPct', l.maxDrawdownPct, 0.5, 1, 90)}
        ${cf('Smallest order (USD)', 'r-minNotional', l.minNotional, 1, 1, 1000)}
      </div>
      <p class="sub faint" style="margin:0;font-size:12px">A halt pauses new buys only. The daily one lifts at the next UTC day, the drawdown one stays until you resume.</p>
    </section>
    <section class="glass card stack">
      <h3>Trading costs</h3>
      <div class="grid2">
        ${cf('Taker fee (bps)', 'c-takerBps', c.takerBps, 1, 0, 200)}${cf('Maker fee (bps)', 'c-makerBps', c.makerBps, 1, 0, 200)}
        ${cf('Spread (bps)', 'c-spreadBps', c.spreadBps, 1, 0, 200)}${cf('Impact (bps per 1% of bar)', 'c-impactCoef', c.impactCoef, 1, 0, 100)}
      </div>
      <p class="sub faint" style="margin:0;font-size:12px">100 bps = 1%. Defaults are pessimistic on purpose: paper results that ignore costs are flattering.</p>
    </section>
    <section class="glass card stack">
      <h3>Account and data</h3>
      <div class="grid2">${cf('Starting cash (USD)', 'c-startingCash', c.startingCash, 1000, 100, 1e8)}
        ${field('Market data', `<select data-f="mode"><option value="replay" ${S.mode === 'replay' ? 'selected' : ''}>Replay real candles</option><option value="synthetic" ${S.mode === 'synthetic' ? 'selected' : ''}>Synthetic market</option>${S.kind === 'server' ? `<option value="live" ${S.mode === 'live' ? 'selected' : ''}>Live prices (paper money)</option>` : ''}</select>`)}</div>
      <p class="sub" style="margin:0">${S.mode === 'live' ? 'Real Gemini prices as they happen, traded with simulated money. Press Play to start polling. Nothing here can place a real order.' : S.mode === 'replay' ? 'Replays real Gemini hourly candles for BTC, ETH and SOL. Price paths inside each hour are interpolated.' : 'A seeded random market with calm, trending and wild stretches (seed ' + S.seed + '). Good for testing against conditions the real data lacks.'}</p>
      <div class="ctrl"><button class="btn ${ui.confirm ? 'danger' : ''}" data-act="reset" id="rReset">${ui.confirm ? 'Tap again to confirm' : 'Reset account'}</button></div>
      <p class="sub faint" style="margin:0;font-size:12px">Reset wipes positions, orders, fills and bot state, and applies the starting cash and data mode above. Cost and risk settings are kept.</p>
    </section>
    ${liveCard()}
    ${auditCard()}
    <section class="glass card stack">
      <h3>Alerts</h3>
      <p class="sub" style="margin:0">Risk halts and the kill switch always pop up here. Fills pop up too unless the market is playing fast.</p>
      <div class="ctrl"><button class="btn ${ui.notify ? 'pri' : ''}" data-act="notify" aria-pressed="${ui.notify}">${ui.notify ? 'Browser notifications on' : 'Turn on browser notifications'}</button></div>
      <p class="sub faint" style="margin:0;font-size:12px">For alerts on your phone while the page is closed, start the server with GT_ALERT_URL set (ntfy, Slack or Discord). See server/README.</p>
    </section>
    <section class="glass card stack" style="grid-column:1/-1">
      <h3>Where the trading runs</h3>
      <div class="seg" role="group" aria-label="Backend">
        <button data-act="useLocal" aria-pressed="${S.kind === 'local'}">In this page</button>
        <button data-act="useServer" aria-pressed="${S.kind === 'server'}">Python server</button>
      </div>
      <p class="sub" style="margin:0">${S.kind === 'local' ? 'The simulation runs inside this page and saves to this browser. It works anywhere, including the Claude preview.' : 'Connected to your Python server. It owns the account, orders, risk limits and saved history; this page only displays and sends commands.'}</p>
      <div class="grid2">
        ${field('Server address', `<input data-f="srv-url" value="${esc(ui.srv.url)}" autocapitalize="off" spellcheck="false">`)}
        ${field('Access token (if set)', `<input data-f="srv-token" type="password" value="${esc(ui.srv.token)}" autocomplete="off">`)}
        ${field('User name (if the server has logins)', `<input data-f="srv-user" value="${esc(ui.srv.user)}" autocapitalize="off" autocomplete="username" spellcheck="false">`)}
        ${field('Password', `<input data-f="srv-pass" type="password" value="${esc(ui.srv.pass)}" autocomplete="current-password">`)}
      </div>
      <div class="ctrl"><button class="btn pri" data-act="connect" ${ui.srv.busy ? 'disabled' : ''}>${S.kind === 'server' ? 'Reconnect' : 'Connect'}</button></div>
      <div class="msg ${ui.srv.status.startsWith('Connected') ? 'ok' : ''}" id="srvMsg" aria-live="polite">${esc(ui.srv.status)}</div>
      <p class="sub faint" style="margin:0;font-size:12px">Run the server with <span class="mono">uvicorn gtrader.api:app</span> (see server/README). A page opened from another site needs the server started with GT_CORS set to that site. The token is kept for this tab only.</p>
    </section>
    <section class="glass card stack" style="grid-column:1/-1">
      <h3>Going live is locked</h3>
      <p class="sub" style="margin:0">This build only trades paper money. A real exchange plugs into the same order interface, but not from a browser page: API keys must live on a server you control.</p>
      <ul class="check">
        <li><b>·</b><span>Signing backend that holds keys, with trade-only permission and no withdrawal rights</span></li>
        <li><b>·</b><span>Exchange adapter implementing the same interface, reconciled against real balances</span></li>
        <li><b>·</b><span>Weeks of paper results that survive realistic costs and a held-out period</span></li>
        <li><b>·</b><span>Hard server-side limits that repeat the ones here, plus an out-of-band kill switch</span></li>
        <li><b>·</b><span>A first live phase with trivially small size</span></li>
      </ul>
    </section>
  </div>`;
}

function render(): void {
  const v = $('view')!;
  try {
    v.innerHTML = ui.tab === 'trade' ? tradeView() : ui.tab === 'stats' ? statsView() : ui.tab === 'bots' ? botsView() : ui.tab === 'test' ? testView() : riskView();
  } catch (err) {
    v.innerHTML = `<div class="banner bad" role="alert">This tab failed to draw: ${esc(String((err as Error)?.message || err))}. Tap Reset account on the Risk tab if it persists.</div>`;
  }
  document.querySelectorAll<HTMLElement>('.dock button').forEach((b) => b.setAttribute('aria-current', b.dataset.v === ui.tab ? 'page' : 'false'));
  paint();
}

// ---------- live painting (no input is ever replaced here)
let th: Theme;
const setHtml = (el: HTMLElement | null, html: string) => {
  if (el && (el as any)._h !== html) {
    (el as any)._h = html;
    el.innerHTML = html;
  }
};

function ticketQtyNum(): number {
  return parseFloat(ui.tk.qty);
}

function paintEstimate(): void {
  const ex = S.ex;
  const sym = S.symbol;
  const r = S.rules();
  const tk = ui.tk;
  const mark = ex.mark(sym);
  const go = $('tkGo');
  if (go) go.textContent = `${tk.side === 'buy' ? 'Buy' : 'Sell'} ${r.base}`;
  const est = $('est');
  if (!est || mark == null) return;
  const qty = ticketQtyNum();
  const availCash = ex.availableCash();
  const availQty = ex.availableQty(sym);
  const rows: string[] = [`<div><span>Market</span><span class="num">${usd(mark)}</span></div>`];
  rows.push(`<div><span>Available</span><span class="num">${tk.side === 'buy' ? usd(availCash) : qtyStr(availQty, r.qtyStep) + ' ' + r.base}</span></div>`);
  if (qty > 0) {
    const px = tk.type === 'market' ? ex.quote(sym, tk.side, qty)! : parseFloat(tk.price) || mark;
    const notional = qty * px;
    const bps = tk.type === 'limit' ? ex.cfg.makerBps : ex.cfg.takerBps;
    rows.push(`<div><span>${tk.type === 'market' ? 'Expected price' : 'Order price'}</span><span class="num">${usd(px)}</span></div>`);
    rows.push(`<div><span>Value</span><span class="num">${usd(notional)} · ${((notional / ex.equity()) * 100).toFixed(1)}% of equity</span></div>`);
    rows.push(`<div><span>Fee${tk.type === 'limit' ? ' (if it rests)' : ''}</span><span class="num">${usd((notional * bps) / 1e4)}</span></div>`);
    if (tk.side === 'buy') {
      const chk = S.eng.risk.check({ req: { symbol: sym, side: 'buy', type: tk.type, qty, price: px }, refPrice: px, equity: ex.equity(), positionValue: (ex.positions.get(sym)?.qty ?? 0) * mark });
      rows.push(`<div><span>Risk check</span><span class="${chk.ok ? 'up' : 'down'}">${chk.ok ? '✓ Passes' : '✕ ' + esc(chk.reason)}</span></div>`);
    }
  }
  setHtml(est, rows.join(''));
}

function tableHtml(): string {
  const ex = S.ex;
  if (ui.sub === 'pos') {
    const rows = [...ex.positions.values()].filter((p) => p.qty > 1e-12);
    if (!rows.length) return '<div class="empty">No open positions. Buy something to see it here.</div>';
    return `<table><thead><tr><th>Market</th><th class="r">Quantity</th><th class="r">Avg cost</th><th class="r">Price</th><th class="r">Value</th><th class="r">Profit / loss</th><th></th></tr></thead><tbody>${rows
      .map((p) => {
        const r = S.rules(p.symbol);
        const mk = ex.mark(p.symbol) ?? 0;
        const val = p.qty * mk;
        const pl = val - p.cost;
        return `<tr><td>${p.symbol}</td><td class="num r">${qtyStr(p.qty, r.qtyStep)}</td><td class="num r">${usd(p.cost / p.qty)}</td><td class="num r">${usd(mk)}</td><td class="num r">${usd(val)}</td><td class="num r">${pnl(pl)} ${pct((pl / p.cost) * 100, 1)}</td><td class="r"><button class="btn sm" data-act="sellAll" data-v="${p.symbol}">Sell all</button></td></tr>`;
      })
      .join('')}</tbody></table>`;
  }
  if (ui.sub === 'ord') {
    const rows = ex.openOrders();
    if (!rows.length) return '<div class="empty">No resting orders. Limit and stop orders wait here until they trigger.</div>';
    return `<table><thead><tr><th>Market</th><th>Side</th><th>Type</th><th class="r">Quantity</th><th class="r">Price</th><th>From</th><th></th></tr></thead><tbody>${rows
      .map((o) => `<tr><td>${o.symbol}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? '▲ Buy' : '▼ Sell'}</td><td>${o.type}</td><td class="num r">${qtyStr(o.qty, S.rules(o.symbol).qtyStep)}</td><td class="num r">${usd(o.price!)}</td><td>${o.source === 'manual' ? 'You' : esc(S.eng.bot(o.source)?.cfg.name || o.source)}</td><td class="r"><button class="btn sm" data-act="cancel" data-v="${o.id}">Cancel</button></td></tr>`)
      .join('')}</tbody></table>`;
  }
  const rows = ex.fills.slice(-40).reverse();
  if (!rows.length) return '<div class="empty">No fills yet.</div>';
  return `<table><thead><tr><th>Time</th><th>Market</th><th>Side</th><th class="r">Quantity</th><th class="r">Price</th><th class="r">Fee</th><th class="r">Realized</th><th>From</th><th>Journal</th></tr></thead><tbody>${rows
    .map((f) => `<tr><td class="num">${tstr(f.t)}</td><td>${f.symbol}</td><td class="${f.side === 'buy' ? 'up' : 'down'}">${f.side === 'buy' ? '▲ Buy' : '▼ Sell'}</td><td class="num r">${qtyStr(f.qty, S.rules(f.symbol).qtyStep)}</td><td class="num r">${usd(f.price)}</td><td class="num r">${usd(f.fee)}</td><td class="num r">${f.side === 'sell' ? pnl(f.realized) : '<span class="faint">·</span>'}</td><td>${f.source === 'manual' ? 'You' : esc(S.eng.bot(f.source)?.cfg.name || f.source)}${f.maker ? ' · maker' : ''}</td><td>${journalCell(f.id)}</td></tr>`)
    .join('')}</tbody></table>`;
}

function journalCell(id: string): string {
  const j = S.journal[id];
  const label = j ? esc(j.tag || 'note') : '＋';
  return `<button class="btn sm" data-act="jr" data-v="${id}" title="${j?.note ? esc(j.note) : 'Add a tag or note'}">${label}</button>`;
}
function journalEditor(): string {
  const id = ui.jr;
  if (!id) return '';
  const f = S.ex.fills.find((x) => x.id === id);
  if (!f) return '';
  const j = S.journal[id] || { tag: '', note: '' };
  return `<div class="stack" style="margin-top:10px" id="jrEd">
    <small class="faint">Journal · ${f.side === 'buy' ? 'Buy' : 'Sell'} ${f.symbol} at ${usd(f.price)}. Tag a buy to label why you entered; the next sell of that coin takes the tag unless it has its own.</small>
    <div class="grid2">${field('Tag', `<select id="jrTag"><option value="">None</option>${JOURNAL_TAGS.map((t) => `<option ${t === j.tag ? 'selected' : ''}>${t}</option>`).join('')}</select>`)}
    ${field('Note', `<input id="jrNote" maxlength="500" value="${esc(j.note)}" placeholder="What was the thinking?">`)}</div>
    <div class="ctrl"><button class="btn pri" data-act="jrSave">Save</button><button class="btn" data-act="jrClear">Clear</button><button class="btn" data-act="jrClose">Close</button></div></div>`;
}

function ohlcText(i: number | null): string {
  const e = S.eng;
  const all = [...(e.series[S.symbol] || [])];
  const cur = e.cur[S.symbol];
  if (cur) all.push(cur);
  const start = Math.max(0, all.length - ui.bars);
  const c = i == null ? all[all.length - 1] : all[start + i];
  if (!c) return '';
  const d = S.rules().priceStep < 0.01 ? 3 : 2;
  const f = (x: number) => x.toFixed(d);
  return `${tstr(c.t)}  O ${f(c.o)}  H ${f(c.h)}  L ${f(c.l)}  C ${f(c.c)}  Vol ${c.v.toFixed(1)}`;
}

function paint(): void {
  if (!th) th = readTheme(document.documentElement);
  const ex = S.ex;
  const eq = ex.equity();
  const start = ex.cfg.startingCash;
  const risk = S.eng.risk;
  const dayAbs = eq - risk.s.dayStartEquity;
  setHtml($('hEq'), usd(eq));
  setHtml($('hDay'), `<span class="${cls(dayAbs)}">${arrow(dayAbs)}${sgnUsd(dayAbs)} (${sgn(risk.dayPnlPct(eq))}%) today</span>`);
  const tot = eq - start;
  const stat = (l: string, v: string) => `<div class="stat"><small>${l}</small><b>${v}</b></div>`;
  setHtml($('hStats'), stat('Total return', pct((tot / start) * 100)) + stat('Cash', usd(ex.cash)) + stat('Open P&L', pnl(ex.unrealized())) + stat('Realized', pnl(ex.realized)) + stat('Fees paid', usd(ex.feesPaid)) + stat('Drawdown', risk.drawdownPct(eq).toFixed(1) + '%'));
  setHtml($('hPlay'), `${S.playing ? PAUSE : PLAY}${S.playing ? 'Pause' : S.ended ? 'Ended' : 'Play'}`);
  ($('hPlay') as HTMLButtonElement).disabled = S.ended && !S.playing;
  setHtml($('hClock'), `Market time ${tstr(ex.now)} UTC`);
  setHtml($('modeTag'), (S.kind === 'server' ? 'Server · ' : '') + (S.mode === 'live' ? 'Live prices · paper money' : S.mode === 'replay' ? 'Real data replay' : 'Synthetic · seed ' + S.seed));
  const live = S.mode === 'live';
  $('hSpeed')!.style.display = live ? 'none' : '';
  document.querySelector<HTMLElement>('[data-act=step]')!.style.display = live ? 'none' : '';
  $('hRestart')!.textContent = ui.confirm ? 'Tap again to confirm' : 'Restart';
  document.querySelectorAll<HTMLElement>('#hSpeed button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.v! === S.speed)));
  document.querySelectorAll<HTMLElement>('#hSym button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === S.symbol)));
  const blocked = risk.blocked();
  const stale = S.feed?.stale;
  setHtml($('banner'), S.error ? `<div class="banner bad" role="alert">${esc(S.error)}</div>` : stale ? `<div class="banner bad" role="alert">${esc(stale)}. New buys are paused; you can still sell.</div>` : blocked ? `<div class="banner ${risk.s.killed ? 'bad' : ''}" role="alert">${esc(blocked)}. New buys are paused; you can still sell. <a href="#" data-act="tab" data-v="risk" style="color:inherit;font-weight:800">Risk tab</a></div>` : '');

  if (ui.tab === 'trade') {
    const sym = S.symbol;
    const closed = S.eng.series[sym] || [];
    const cur = S.eng.cur[sym];
    const all = cur ? [...closed, cur] : closed;
    const cv = $<HTMLCanvasElement>('cv');
    if (cv) {
      const pos = ex.positions.get(sym);
      ui.geom = drawCandles(cv, {
        candles: all,
        bars: ui.bars,
        decimals: S.rules().priceStep < 0.01 ? 3 : 2,
        fills: ex.fills.filter((f) => f.symbol === sym),
        orders: ex.openOrders().filter((o) => o.symbol === sym),
        avgCost: pos && pos.qty > 1e-12 ? pos.cost / pos.qty : null,
        sma: ui.sma,
        hover: ui.hover,
        ticket: ui.tk.type !== 'market' && parseFloat(ui.tk.price) > 0 ? { price: parseFloat(ui.tk.price), side: ui.tk.side, type: ui.tk.type } : null,
        th,
      });
    }
    document.querySelectorAll<HTMLElement>('#mSym button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === S.symbol)));
    const mp = $('mPx');
    if (mp) mp.textContent = ex.mark(sym) != null ? usd(ex.mark(sym)!, S.rules().priceStep < 0.01 ? 3 : 2) : '';
    const oh = $('ohlc');
    if (oh) oh.textContent = ohlcText(ui.hover);
    paintEstimate();
    setHtml($('tbl'), tableHtml());
    setHtml($('log'), S.eng.log.slice(-40).reverse().map((l) => `<div class="k-${l.kind}"><time>${l.t ? tstr(l.t) : '--'}</time><span>${esc(l.text)}</span></div>`).join('') || '<div class="k-info">Nothing yet.</div>');
    const cv2 = $<HTMLCanvasElement>('cv2');
    if (cv2) drawLines(cv2, [{ name: 'Equity', pts: S.eng.equityLog.slice(-600), color: th.accent }], th, { base: start, money: true });
  } else if (ui.tab === 'stats') {
    paintStats();
  } else if (ui.tab === 'bots') {
    for (const b of S.eng.bots) {
      const pill = $('bp-' + b.cfg.id);
      if (pill) {
        pill.textContent = b.cfg.enabled ? 'Running' : 'Stopped';
        pill.className = 'pill ' + (b.cfg.enabled ? 'on' : 'off');
      }
      const r = S.rules(b.cfg.symbol);
      setHtml(
        $('bs-' + b.cfg.id),
        `<div><span>Holding</span><span class="num">${b.st.qty > 0 ? qtyStr(b.st.qty, r.qtyStep) + ' ' + r.base : 'Flat'}</span></div>
         <div><span>Closed trades</span><span class="num">${b.st.trades}</span></div>
         <div><span>Realized P&L</span><span class="num">${pnl(b.st.pnl)}</span></div>
         <div><span>Last signal</span><span style="text-align:right">${b.st.last ? esc(b.st.last.text) : '<span class="faint">none yet</span>'}</span></div>`,
      );
    }
  } else if (ui.tab === 'risk') {
    setHtml($('killState'), risk.s.killed ? '<span class="pill" style="color:var(--down);border-color:var(--down)">Kill switch is ON</span>' : blocked ? `<span class="pill" style="color:var(--warn);border-color:var(--warn)">${esc(blocked)}</span>` : '<span class="pill on">All clear</span>');
    if ($('liveCard')) setHtml($('liveCard'), liveInner());
    const rr = $('rReset');
    if (rr) rr.textContent = ui.confirm ? 'Tap again to confirm' : 'Reset account';
  } else if (ui.tab === 'test') {
    const cvb = $<HTMLCanvasElement>('cvb');
    if (cvb && ui.btRes) drawLines(cvb, [{ name: 'Buy & hold', pts: ui.btRes.r.hold, color: th.mute, dash: true }, { name: 'Strategy', pts: ui.btRes.r.equity, color: th.accent }], th, { base: start, money: true });
  }
}

// ---------- alerts: toasts for risk events and slow-play fills, plus optional browser notifications
const seenLog = new Set<string>();
const logKey = (l: { t: number; text: string }) => l.t + '|' + l.text;
function primeAlerts(): void {
  seenLog.clear();
  S.eng.log.forEach((l) => seenLog.add(logKey(l)));
}
let lastNotify = 0;
function checkAlerts(): void {
  const fresh = S.eng.log.slice(-12).filter((l) => !seenLog.has(logKey(l)));
  for (const l of fresh) {
    seenLog.add(logKey(l));
    if (l.kind === 'risk' || (l.kind === 'fill' && (!S.playing || S.speed <= 4))) {
      toast(l.text);
      if (ui.notify && 'Notification' in window && Notification.permission === 'granted' && Date.now() - lastNotify > 4000) {
        lastNotify = Date.now();
        try {
          new Notification(l.kind === 'risk' ? 'Glass Trader: risk' : 'Glass Trader: fill', { body: l.text });
        } catch (e) {
          /* some browsers only allow this from a service worker */
        }
      }
    }
  }
  if (seenLog.size > 800) primeAlerts();
}

let raf = 0;
const onEmit = () => {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    paint();
    checkAlerts();
  });
};
LOCAL.listeners.add(onEmit);

// ---------- actions
function setQtyFromPct(p: number): void {
  const ex = S.ex;
  const r = S.rules();
  const mark = ex.mark(S.symbol);
  if (mark == null) return;
  let q: number;
  if (ui.tk.side === 'buy') {
    const px = ui.tk.type === 'market' ? mark * 1.002 : parseFloat(ui.tk.price) || mark;
    q = (ex.availableCash() / (1 + ex.cfg.takerBps / 1e4 + 0.012) / px) * (p / 100);
  } else q = ex.availableQty(S.symbol) * (p / 100);
  q = floorTo(q, r.qtyStep);
  ui.tk.qty = q > 0 ? qtyStr(q, r.qtyStep) : '';
  const el = $<HTMLInputElement>('tkQty');
  if (el) el.value = ui.tk.qty;
  paintEstimate();
}

async function submit(): Promise<void> {
  const r = S.rules();
  const tk = ui.tk;
  const qty = parseFloat(tk.qty);
  const msg = $('tmsg')!;
  const fail = (t: string) => {
    msg.className = 'msg';
    msg.textContent = t;
  };
  if (!(qty > 0)) return fail('Enter a quantity.');
  const price = parseFloat(tk.price);
  if (tk.type !== 'market' && !(price > 0)) return fail('Enter a price.');
  const sl = parseFloat(tk.sl) || 0,
    tpv = parseFloat(tk.tp) || 0;
  if (tk.side === 'buy' && (sl < 0 || sl > 50 || tpv < 0 || tpv > 500)) return fail('Stop-loss must be 0 to 50% and take-profit 0 to 500%.');
  const bracket = tk.side === 'buy' && (sl > 0 || tpv > 0) ? { stopPct: sl, tpPct: tpv } : undefined;
  const res = await S.placeOrder({ symbol: S.symbol, side: tk.side, type: tk.type, qty, price: tk.type === 'market' ? undefined : price, bracket });
  if (!res.ok) return fail(res.reason);
  msg.className = 'msg ok';
  const o = res.order;
  msg.textContent = o.status === 'filled' ? `Filled ${qtyStr(o.qty, r.qtyStep)} ${r.base} at ${usd(o.fillPrice ?? 0)}.` : 'Order placed and resting.';
  toast(msg.textContent);
}

function runBtLocal(id: string): BacktestResult {
  const b = ui.bt;
  return runBacktest({
    symbol: b.symbol,
    rules: S.rules(b.symbol),
    candles: S.data[b.symbol],
    candleMs: H,
    strategyId: id,
    params: id === b.strategy ? b.params : defaultParams(strategyById(id)),
    allocPct: b.alloc,
    stopPct: b.stop,
    paper: S.ex.cfg,
    risk: S.eng.risk.limits,
  });
}

function clampInput(el: HTMLInputElement): number {
  let v = parseFloat(el.value);
  const lo = el.min !== '' ? +el.min : -Infinity,
    hi = el.max !== '' ? +el.max : Infinity;
  if (!Number.isFinite(v)) v = lo > -Infinity ? lo : 0;
  v = Math.min(hi, Math.max(lo, v));
  el.value = String(v);
  return v;
}

function armReset(): boolean {
  if (ui.confirm) {
    clearTimeout(ui.confirmTimer);
    ui.confirm = '';
    return true;
  }
  ui.confirm = 'reset';
  clearTimeout(ui.confirmTimer);
  ui.confirmTimer = window.setTimeout(() => {
    ui.confirm = '';
    paint();
  }, 4000);
  paint();
  return false;
}

document.addEventListener('click', async (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  const act = el.dataset.act!,
    v = el.dataset.v || '';
  if (el.tagName === 'A') ev.preventDefault();
  switch (act) {
    case 'tab':
      ui.tab = v as Tab;
      ui.hover = null;
      render();
      window.scrollTo({ top: 0 });
      break;
    case 'play':
      S.playing ? S.pause() : S.play();
      break;
    case 'step':
      S.pause();
      S.stepBar();
      break;
    case 'restart':
    case 'reset':
      if (armReset()) {
        await S.reset();
        primeAlerts();
        toast('Account reset.');
        render();
      }
      break;
    case 'speed':
      S.setSpeed(+v);
      break;
    case 'sym':
      ui.hover = null;
      ui.tk.qty = '';
      ui.tk.price = '';
      await S.setSymbol(v);
      if (ui.tab === 'trade') render();
      else paint();
      break;
    case 'theme': {
      ui.theme = ui.theme === 'auto' ? 'dark' : ui.theme === 'dark' ? 'light' : 'auto';
      applyTheme();
      toast('Theme: ' + ui.theme);
      break;
    }
    case 'bars':
      ui.bars = +v;
      render();
      break;
    case 'sma':
      ui.sma = !ui.sma;
      render();
      break;
    case 'side':
      ui.tk.side = v as Side;
      ui.tk.qty = '';
      render();
      break;
    case 'otype':
      ui.tk.type = v as OrderType;
      if (ui.tk.type !== 'market' && !ui.tk.price) ui.tk.price = String(S.ex.mark(S.symbol) ?? '');
      render();
      break;
    case 'chip':
      setQtyFromPct(+v);
      break;
    case 'submit':
      submit();
      break;
    case 'sub':
      ui.sub = v as Sub;
      render();
      break;
    case 'audit':
      try {
        ui.audit = await S.audit!();
      } catch (e) {
        toast((e as Error).message);
      }
      render();
      break;
    case 'calib':
      try {
        ui.calib = await S.calibration!();
      } catch (e) {
        toast((e as Error).message);
      }
      render();
      break;
    case 'jr':
      ui.jr = ui.jr === v ? null : v;
      render();
      break;
    case 'jrClose':
      ui.jr = null;
      render();
      break;
    case 'jrSave':
    case 'jrClear': {
      if (!ui.jr) break;
      const clear = act === 'jrClear';
      try {
        await S.setJournal(ui.jr, clear ? '' : ($<HTMLSelectElement>('jrTag')?.value ?? ''), clear ? '' : ($<HTMLInputElement>('jrNote')?.value ?? ''));
      } catch (e) {
        toast((e as Error).message);
      }
      ui.jr = null;
      render();
      break;
    }
    case 'cancel':
      await S.cancelOrder(v);
      break;
    case 'sellAll': {
      const q = S.ex.availableQty(v);
      if (q > 0) {
        const res = await S.placeOrder({ symbol: v, side: 'sell', type: 'market', qty: q });
        toast(res.ok ? 'Sold the position.' : res.reason);
      }
      break;
    }
    case 'kill':
      await S.killSwitch();
      toast('Kill switch on. Bots stopped.');
      break;
    case 'resume':
      await S.resumeTrading();
      toast('Trading resumed.');
      break;
    case 'botAdd': {
      await S.addBot(ui.newBot.strategy, ui.newBot.symbol);
      toast('Bot added, stopped. Backtest it first.');
      render();
      break;
    }
    case 'botToggle': {
      const b = S.eng.bot(v);
      if (!b) break;
      const e = await S.patchBot(v, { enabled: !b.cfg.enabled });
      if (e) toast(e);
      render();
      break;
    }
    case 'botDel':
      await S.removeBot(v);
      render();
      break;
    case 'botTest': {
      const b = S.eng.bot(v);
      if (!b) break;
      ui.bt = { strategy: b.cfg.strategyId, symbol: b.cfg.symbol, params: { ...b.cfg.params }, alloc: b.cfg.allocPct, stop: b.cfg.stopPct };
      ui.tab = 'test';
      await doBacktest();
      render();
      window.scrollTo({ top: 0 });
      break;
    }
    case 'exportFills':
      await exportFills().catch((e) => toast((e as Error).message));
      break;
    case 'exportSummary':
      await exportSummary().catch((e) => toast((e as Error).message));
      break;
    case 'notify':
      if (!('Notification' in window)) {
        toast('This browser does not support notifications here.');
        break;
      }
      if (ui.notify) ui.notify = false;
      else {
        try {
          const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
          ui.notify = perm === 'granted';
          if (!ui.notify) toast('Notifications are blocked for this page.');
        } catch (e) {
          toast('Notifications are not available here.');
        }
      }
      render();
      break;
    case 'useLocal':
      if (S.kind !== 'local') {
        useBackend(LOCAL);
        ui.srv.status = '';
        toast('Running in this page.');
        render();
      }
      break;
    case 'useServer':
    case 'connect':
      await connectServer();
      break;
    case 'btRun':
      await doBacktest();
      render();
      break;
    case 'btSweep':
      try {
        const bb = ui.bt;
        toast('Running stress test…');
        const r = S.sweep
          ? await S.sweep({ symbol: bb.symbol, strategy: bb.strategy, params: bb.params, allocPct: bb.alloc, stopPct: bb.stop, split: false })
          : runSweep({ symbol: bb.symbol, rules: S.rules(bb.symbol), candles: S.data[bb.symbol], candleMs: H, strategyId: bb.strategy, params: bb.params, allocPct: bb.alloc, stopPct: bb.stop, paper: S.ex.cfg, risk: S.eng.risk.limits });
        ui.sweep = { label: `${strategyById(bb.strategy).name} on ${bb.symbol}`, r };
      } catch (e) {
        toast((e as Error).message);
      }
      render();
      break;
    case 'btAll':
      try {
        ui.cmp = [];
        for (const st of STRATEGIES) ui.cmp.push({ name: st.name, r: await runBt(st.id) });
      } catch (e) {
        ui.cmp = null;
        toast((e as Error).message);
      }
      render();
      break;
  }
});

function useBackend(b: Backend): void {
  if (S === b) return;
  S.listeners.delete(onEmit);
  if (S.kind === 'server') S.dispose();
  else LOCAL.pause();
  S = b;
  S.listeners.add(onEmit);
  primeAlerts();
  ui.hover = null;
}

async function connectServer(): Promise<void> {
  if (ui.srv.busy) return;
  ui.srv.busy = true;
  ui.srv.status = 'Connecting…';
  render();
  let token = ui.srv.token;
  let signedIn = '';
  try {
    if (ui.srv.user) {
      const lg = await RemoteSession.login(ui.srv.url, ui.srv.user, ui.srv.pass);
      token = lg.token;
      signedIn = `${lg.name} (${lg.role})`;
      ui.srv.pass = '';
    }
  } catch (e) {
    ui.srv.status = (e as Error).message;
    ui.srv.busy = false;
    render();
    return;
  }
  const rs = new RemoteSession(ui.srv.url, token, LOCAL.data);
  rs.onNotice = toast;
  try {
    await rs.connect();
    if (S.kind === 'server') S.dispose();
    useBackend(rs);
    ui.srv.status = 'Connected to ' + ui.srv.url + (rs.who && rs.who.name !== 'local' ? ` as ${rs.who.name} (${rs.who.role})` : '');
    void signedIn;
    try {
      localStorage.setItem('glasstrader.server', ui.srv.url);
    } catch (e) {
      /* ignore */
    }
    toast('Connected to the Python server.');
  } catch (e) {
    rs.dispose();
    ui.srv.status = (e as Error).message;
  }
  ui.srv.busy = false;
  render();
}

async function runBt(id: string, split = false): Promise<BacktestResult> {
  const b = ui.bt;
  if (S.backtest) {
    const out = await S.backtest({ symbol: b.symbol, strategy: id, params: id === b.strategy ? b.params : defaultParams(strategyById(id)), allocPct: b.alloc, stopPct: b.stop, split });
    lastSplit = out.split || null;
    return out.r as BacktestResult;
  }
  return runBtLocal(id);
}
let lastSplit: { train: any; test: any } | null = null;

async function doBacktest(): Promise<void> {
  const b = ui.bt;
  let r: BacktestResult;
  try {
    r = await runBt(b.strategy, true);
  } catch (e) {
    toast((e as Error).message);
    return;
  }
  if (S.backtest && lastSplit) {
    ui.btRes = { r, split: { ...lastSplit, splitAt: 0 } as any, label: `${strategyById(b.strategy).name} on ${b.symbol}` };
    return;
  }
  const o = {
    symbol: b.symbol,
    rules: S.rules(b.symbol),
    candles: S.data[b.symbol],
    candleMs: H,
    strategyId: b.strategy,
    params: b.params,
    allocPct: b.alloc,
    stopPct: b.stop,
    paper: S.ex.cfg,
    risk: S.eng.risk.limits,
  };
  ui.btRes = { r, split: runSplit(o), label: `${strategyById(b.strategy).name} on ${b.symbol}` };
}

document.addEventListener('input', (ev) => {
  const el = ev.target as HTMLInputElement;
  const f = el.dataset?.f;
  if (f === 'srv-url') ui.srv.url = el.value.trim();
  else if (f === 'srv-token') {
    ui.srv.token = el.value;
    try {
      sessionStorage.setItem('glasstrader.token', el.value);
    } catch (e) {
      /* ignore */
    }
  } else if (f === 'srv-user') ui.srv.user = el.value.trim();
  else if (f === 'srv-pass') ui.srv.pass = el.value;
  else if (f === 'tk-sl') ui.tk.sl = el.value;
  else if (f === 'tk-tp') ui.tk.tp = el.value;
  else if (f === 'tk-qty') {
    ui.tk.qty = el.value;
    paintEstimate();
  } else if (f === 'tk-price') {
    ui.tk.price = el.value;
    paintEstimate();
  }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target as HTMLInputElement;
  const f = el.dataset?.f;
  if (!f) return;
  if (f === 'nb-strategy') {
    ui.newBot.strategy = el.value;
    render();
  } else if (f === 'nb-symbol') ui.newBot.symbol = el.value;
  else if (f === 'bt-strategy') {
    ui.bt.strategy = el.value;
    ui.bt.params = defaultParams(strategyById(el.value));
    render();
  } else if (f === 'bt-symbol') ui.bt.symbol = el.value;
  else if (f === 'bt-alloc') ui.bt.alloc = clampInput(el);
  else if (f === 'bt-stop') ui.bt.stop = clampInput(el);
  else if (f === 'bt-p') ui.bt.params[el.dataset.k!] = clampInput(el);
  else if (f.startsWith('b:') && !/^b:[^:]+p$/.test(f)) {
    const [, id, what] = f.split(':');
    const e = await S.patchBot(id, what === 'alloc' ? { allocPct: clampInput(el) } : { stopPct: clampInput(el) });
    if (e) toast(e);
  } else if (f.startsWith('r-')) {
    await S.setLimit(f.slice(2), clampInput(el));
  } else if (f.startsWith('c-')) {
    const k = f.slice(2);
    await S.setCost(k, clampInput(el));
    if (k === 'startingCash') toast('Applies when you reset the account.');
  } else if (f === 'mode') {
    if (el.value !== S.mode) {
      try {
        await S.reset(el.value as 'replay' | 'synthetic' | 'live');
        toast('Switched data. Account reset.');
      } catch (e) {
        toast((e as Error).message);
      }
      render();
    }
  }
});
// Bot param inputs carry data-f like "b:bot1p": normalise to the same handler.
document.addEventListener('change', async (ev) => {
  const el = ev.target as HTMLInputElement;
  if (el.dataset?.f && /^b:[^:]+p$/.test(el.dataset.f)) {
    const id = el.dataset.f.slice(2, -1);
    const e = await S.patchBot(id, { params: { [el.dataset.k!]: clampInput(el) } });
    if (e) toast(e);
  }
});

function hoverAt(ev: PointerEvent): void {
  const cv = ev.target as HTMLElement;
  if (cv.id !== 'cv' || !ui.geom) return;
  const rect = cv.getBoundingClientRect();
  const i = Math.floor((ev.clientX - rect.left - ui.geom.x0) / ui.geom.step);
  ui.hover = i >= 0 && i < ui.geom.n ? i : null;
  paint();
}
document.addEventListener('pointermove', hoverAt);
document.addEventListener('pointerleave', () => {
  ui.hover = null;
  paint();
}, true);

function applyTheme(): void {
  const r = document.documentElement;
  if (ui.theme === 'auto') r.removeAttribute('data-theme');
  else r.setAttribute('data-theme', ui.theme);
  try {
    localStorage.setItem('glasstrader.theme', ui.theme);
  } catch (e) {
    /* storage unavailable */
  }
  requestAnimationFrame(() => {
    th = readTheme(document.documentElement);
    paint();
  });
}
window.addEventListener('resize', () => paint());
window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => applyTheme());
window.addEventListener('pagehide', () => S.save(true));

// ---------- boot
try {
  const u = localStorage.getItem('glasstrader.server');
  if (u) ui.srv.url = u;
  ui.srv.token = sessionStorage.getItem('glasstrader.token') || '';
} catch (e) {
  /* ignore */
}
try {
  const t = localStorage.getItem('glasstrader.theme');
  if (t === 'dark' || t === 'light') ui.theme = t;
} catch (e) {
  /* ignore */
}
shell();
if (!LOCAL.load()) LOCAL.reset('replay', 1);
if (ui.theme !== 'auto') document.documentElement.setAttribute('data-theme', ui.theme);
th = readTheme(document.documentElement);
primeAlerts();
render();
void bootServed();
Object.defineProperty(window, '__gt', { get: () => ({ S, ui }) });

/** When this page is served by the Python server itself, connect to it automatically. */
async function bootServed(): Promise<void> {
  if (!location.protocol.startsWith('http') || location.origin === 'null') return;
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(location.origin + '/api/health', { signal: ctl.signal });
    clearTimeout(to);
    const j = await r.json();
    if (!r.ok || !j.ok) return;
    ui.srv.url = location.origin;
    await connectServer();
  } catch (e) {
    /* not served by Glass Trader: stay in this page */
  }
}

// Installable app: only where service workers exist (not inside the Claude preview).
try {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && location.origin !== 'null') {
    navigator.serviceWorker.register('sw.js') // relative: works at the server's root and under /crypto-trader/ on GitHub Pages.catch(() => {});
  }
} catch (e) {
  /* ignore */
}

// ---------- chart: tap to set the ticket price
document.addEventListener('click', (ev) => {
  const cv = ev.target as HTMLElement;
  if (cv.id !== 'cv' || !ui.geom) return;
  const rect = cv.getBoundingClientRect();
  const px = ui.geom.priceAt(ev.clientY - rect.top);
  if (!(px > 0)) return;
  const r = S.rules();
  ui.tk.price = String(Math.round(px / r.priceStep) * r.priceStep).replace(/(\.\d{1,8})\d*$/, '$1');
  if (ui.tk.type === 'market') ui.tk.type = 'limit';
  const mark = S.ex.mark(S.symbol);
  if (ui.tk.type === 'limit' && mark != null) ui.tk.side = px < mark ? 'buy' : 'sell';
  render();
  toast(`${ui.tk.side === 'buy' ? 'Buy' : 'Sell'} ${ui.tk.type} price set to ${usd(px, r.priceStep < 0.01 ? 3 : 2)}`);
});

// ---------- stats tab
let lastStats = 0;
let statsBusy = false;
function statsView(): string {
  return `<div class="stack">
    <section class="glass card stack"><h3>Session results</h3><div id="statsBody"><div class="empty">Loading…</div></div></section>
    <section class="glass card stack"><h3>Equity curve</h3><canvas class="chart" id="cv3" role="img" aria-label="Account equity over time" style="height:220px"></canvas></section>
    <section class="glass card stack"><h3>Export</h3>
      <p class="sub" style="margin:0">Spreadsheet-ready files of everything this account has done.</p>
      <div class="ctrl"><button class="btn" data-act="exportFills">Fills (CSV)</button><button class="btn" data-act="exportSummary">Summary (CSV)</button></div>
    </section></div>`;
}
const gstat = (g: { key: string; trades: number; realized: number; fees: number; winRatePct: number | null }, name: (k: string) => string) =>
  `<tr><td>${esc(name(g.key))}</td><td class="num r">${g.trades}</td><td class="num r">${g.winRatePct == null ? 'n/a' : g.winRatePct.toFixed(0) + '%'}</td><td class="num r">${pnl(g.realized)}</td><td class="num r">${usd(g.fees)}</td></tr>`;
function statsHtml(st: Stats, fills: Fill[] = []): string {
  const tile = (l: string, v: string) => `<div class="tile"><small>${l}</small><b>${v}</b></div>`;
  const syms = S.symbols();
  const holds = syms.map((sy) => {
    const m0 = S.startMarks[sy],
      m1 = S.ex.mark(sy);
    return m0 && m1 ? { sy, p: (m1 / m0 - 1) * 100 } : null;
  }).filter(Boolean) as { sy: string; p: number }[];
  const eqw = holds.length ? holds.reduce((s, h) => s + h.p, 0) / holds.length : null;
  const money = (x: number | null) => (x == null ? 'n/a' : usd(x));
  const sample = st.trades < 30 ? `<p class="sub" style="margin:0;color:var(--warn)">${st.trades} closed trade${st.trades === 1 ? '' : 's'} so far. That is too few to say whether any strategy works. Averages below will swing a lot.</p>` : '';
  const name = (k: string) => (k === 'manual' ? 'You' : S.eng.bot(k)?.cfg.name || k);
  return `${sample}
    <div class="tiles">
      ${tile('Your return', pct(st.returnPct))}
      ${tile('Just holding', eqw == null ? 'n/a' : pct(eqw))}
      ${tile('Worst drawdown', st.maxDrawdownPct.toFixed(1) + '%')}
      ${tile('Realized P&L', pnl(st.realized))}
      ${tile('Fees paid', usd(st.feesPaid))}
      ${tile('Closed trades', String(st.trades))}
      ${tile('Win rate', st.winRatePct == null ? 'n/a' : st.winRatePct.toFixed(0) + '%')}
      ${tile('Profit factor', st.profitFactor == null ? 'n/a' : st.profitFactor.toFixed(2))}
      ${tile('Avg win', money(st.avgWin))}
      ${tile('Avg loss', money(st.avgLoss))}
      ${tile('Per trade (avg)', st.expectancy == null ? 'n/a' : pnl(st.expectancy))}
      ${tile('Best / worst', st.best == null ? 'n/a' : `${sgnUsd(st.best)} / ${sgnUsd(st.worst!)}`)}
    </div>
    <p class="sub faint" style="margin:0;font-size:12px">"Just holding" is the average of buying BTC, ETH and SOL equally at the start${holds.length ? ' (' + holds.map((h) => `${h.sy.split('-')[0]} ${sgn(h.p, 1)}%`).join(', ') + ')' : ''}. Beat that after fees or the trading wasn't worth it.</p>
    <h3 style="margin-top:6px">By bot</h3>
    <div class="tw"><table><thead><tr><th>Who</th><th class="r">Trades</th><th class="r">Win rate</th><th class="r">Realized</th><th class="r">Fees</th></tr></thead><tbody>${st.bySource.map((g) => gstat(g, name)).join('') || '<tr><td colspan="5" class="faint">Nothing yet.</td></tr>'}</tbody></table></div>
    <h3 style="margin-top:6px">By coin</h3>
    <div class="tw"><table><thead><tr><th>Coin</th><th class="r">Trades</th><th class="r">Win rate</th><th class="r">Realized</th><th class="r">Fees</th></tr></thead><tbody>${st.bySymbol.map((g) => gstat(g, (k) => k)).join('') || '<tr><td colspan="5" class="faint">Nothing yet.</td></tr>'}</tbody></table></div>
    ${Object.keys(S.journal).length ? `<h3 style="margin-top:6px">By journal tag</h3>
    <div class="tw"><table><thead><tr><th>Tag</th><th class="r">Trades</th><th class="r">Win rate</th><th class="r">Realized</th><th class="r">Fees</th></tr></thead><tbody>${statsByTag(fills, S.journal).map((g) => gstat(g, (k) => k)).join('')}</tbody></table></div>` : `<p class="sub faint" style="margin:0;font-size:12px">Tag your fills in the Fills list to see which reasons for trading actually made money.</p>`}`;
}
function paintStats(): void {
  const cv = $<HTMLCanvasElement>('cv3');
  if (cv) drawLines(cv, [{ name: 'Equity', pts: S.eng.equityLog.slice(-800), color: th.accent }], th, { base: S.ex.cfg.startingCash, money: true });
  if (statsBusy || Date.now() - lastStats < 1500) return;
  statsBusy = true;
  Promise.all([S.stats(), S.allFills()])
    .then(([st, fl]) => setHtml($('statsBody'), statsHtml(st, fl)))
    .catch((e) => setHtml($('statsBody'), `<div class="banner bad">${esc((e as Error).message)}</div>`))
    .finally(() => {
      lastStats = Date.now();
      statsBusy = false;
    });
}

// ---------- export
const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
async function exportFile(filename: string, text: string): Promise<void> {
  // Inside the Claude preview the page may only offer a download through the downloads capability.
  try {
    const c = (window as any).claude;
    if (c && typeof c.use === 'function') {
      const dl = await c.use('downloads');
      if (dl) {
        await dl.save({ filename, data: text });
        toast('Saved ' + filename);
        return;
      }
    }
  } catch (e) {
    if ((e as any)?.code === 'declined') return;
  }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Downloaded ' + filename);
  } catch (e) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Could not download here, so the CSV was copied to your clipboard.');
    } catch (e2) {
      toast('Export is not available in this view.');
    }
  }
}
async function exportFills(): Promise<void> {
  const fills: Fill[] = await S.allFills();
  const rows: unknown[][] = [['time_utc', 'symbol', 'side', 'quantity', 'price', 'value', 'fee', 'realized_profit', 'order_type', 'source', 'maker', 'tag', 'note']];
  const types = new Map(S.ex.orders.map((o) => [o.id, o.type]));
  for (const f of fills) rows.push([new Date(f.t).toISOString(), f.symbol, f.side, f.qty, f.price, +(f.qty * f.price).toFixed(2), +f.fee.toFixed(4), f.side === 'sell' ? +f.realized.toFixed(4) : '', types.get(f.orderId) ?? '', f.source === 'manual' ? 'you' : S.eng.bot(f.source)?.cfg.name || f.source, f.maker ? 'yes' : 'no', S.journal[f.id]?.tag ?? '', S.journal[f.id]?.note ?? '']);
  await exportFile('glass-trader-fills.csv', toCsv(rows));
}
async function exportSummary(): Promise<void> {
  const st = await S.stats();
  const rows: unknown[][] = [['metric', 'value']];
  const add = (k: string, v: unknown) => rows.push([k, v == null ? '' : typeof v === 'number' ? +v.toFixed(4) : v]);
  add('starting_cash', st.startCash); add('equity', st.equity); add('return_pct', st.returnPct); add('max_drawdown_pct', st.maxDrawdownPct);
  add('realized_profit', st.realized); add('fees_paid', st.feesPaid); add('closed_trades', st.trades); add('win_rate_pct', st.winRatePct);
  add('profit_factor', st.profitFactor); add('avg_win', st.avgWin); add('avg_loss', st.avgLoss); add('avg_per_trade', st.expectancy); add('best_trade', st.best); add('worst_trade', st.worst);
  for (const g of st.bySource) rows.push(['source:' + g.key, `trades ${g.trades}; realized ${g.realized.toFixed(2)}; fees ${g.fees.toFixed(2)}`]);
  for (const g of st.bySymbol) rows.push(['coin:' + g.key, `trades ${g.trades}; realized ${g.realized.toFixed(2)}; fees ${g.fees.toFixed(2)}`]);
  rows.push(['mode', S.mode], ['exported_at_utc', new Date().toISOString()]);
  await exportFile('glass-trader-summary.csv', toCsv(rows));
}
