import type { SweepResult } from '../core/backtest.js';
import type { JournalEntry } from '../core/stats.js';
import type { Candle, Fill, Order, OrderRequest } from '../core/types.js';
import type { Stats } from '../core/stats.js';
import { PaperExchange } from '../core/paper.js';
import { RiskManager } from '../core/risk.js';
import { Engine } from '../core/engine.js';
import { H, RULES, SPEEDS, type Backend, type Calibration, type FeedStatus, type BotPatch, type BtRequest, type Mode, type PlaceResult } from './session.js';
import type { SymbolRules } from '../core/types.js';

const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const snake = (k: string) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
/** Server JSON uses snake_case; the UI's engine types use camelCase. Only keys change, values do not. */
function camelize(v: any): any {
  if (Array.isArray(v)) return v.map(camelize);
  if (v && typeof v === 'object') {
    const o: any = {};
    for (const k of Object.keys(v)) o[camel(k)] = camelize(v[k]);
    return o;
  }
  return v;
}

/**
 * The same surface as Session, but every command goes to the Python server and the engine objects
 * are mirrors rebuilt from the server's state. The server owns the account.
 */
export class RemoteSession implements Backend {
  readonly kind = 'server' as const;
  eng!: Engine;
  mode: Mode = 'replay';
  seed = 1;
  speed = 4;
  playing = false;
  ended = false;
  symbol = 'BTC-USD';
  error: string | null = null;
  startMarks: Record<string, number> = {};
  listeners = new Set<() => void>();
  private timer = 0;
  private stopped = false;
  private busy = false;
  private lastCandles = 0;
  private candleSym = '';

  constructor(
    private url: string,
    private token: string,
    public data: Record<string, Candle[]>,
  ) {
    this.url = url.replace(/\/+$/, '');
    const ex = new PaperExchange({}, RULES);
    this.eng = new Engine(ex, new RiskManager({}, ex.cfg.startingCash), H);
  }
  get ex(): PaperExchange {
    return this.eng.ex;
  }
  rules(sym = this.symbol): SymbolRules {
    return RULES.find((r) => r.symbol === sym)!;
  }
  symbols(): string[] {
    return RULES.map((r) => r.symbol);
  }
  emit(): void {
    this.listeners.forEach((f) => f());
  }
  save(): void {}

  who: { name: string; role: string } | null = null;
  onNotice: ((msg: string) => void) | null = null;

  /** Exchanges a user name and password for a signed token (the password is never stored). */
  static async login(url: string, name: string, password: string): Promise<{ token: string; name: string; role: string }> {
    let r: Response;
    try {
      r = await fetch(url.replace(/\/+$/, '') + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password }) });
    } catch (e) {
      throw new Error('Could not reach the server. Check the address and that it is running.');
    }
    const j = await r.json().catch(() => ({}));
    if (r.status !== 200) throw new Error(j.error || 'Sign-in failed (' + r.status + ')');
    return j;
  }
  async audit(): Promise<any[]> {
    const r = await this.api('GET', '/api/audit?limit=60');
    if (r.status !== 200) throw new Error(r.json.error || 'Could not load the audit log');
    return r.json.audit;
  }

  private async api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(this.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
      let json: any = {};
      try {
        json = await r.json();
      } catch (e) {
        /* empty body */
      }
      return { status: r.status, json };
    } finally {
      clearTimeout(to);
    }
  }

  /** Throws with a readable message when the server cannot be used. */
  async connect(): Promise<void> {
    let h;
    try {
      h = await this.api('GET', '/api/health');
    } catch (e) {
      throw new Error('Could not reach the server. Check the address and that it is running. (The Claude preview blocks outside connections.)');
    }
    if (h.status !== 200 || !h.json.ok) throw new Error('That address did not answer like a Crypto Trader server.');
    if (h.json.live) throw new Error('This server reports a LIVE exchange. This build only supports paper trading, so it will not connect.');
    const s = await this.api('GET', '/api/state');
    if (s.status === 401) throw new Error(this.token ? 'The server rejected the token or sign-in.' : 'This server needs a sign-in or token.');
    if (s.status !== 200) throw new Error('The server returned an error (' + s.status + ').');
    await this.hydrate(s.json);
    const me = await this.api('GET', '/api/me');
    if (me.status === 200) this.who = me.json;
    this.poll();
  }

  private async hydrate(st: any): Promise<void> {
    const c = camelize(st);
    const snap = c.snapshot;
    const ex = this.eng.ex;
    ex.restore(snap);
    ex.now = st.time;
    this.eng.risk.limits = c.risk.limits === undefined ? this.eng.risk.limits : c.risk.limits;
    this.eng.risk.s = c.riskState;
    this.eng.bots = c.bots;
    this.eng.log = c.log;
    this.eng.equityLog = c.equityLog;
    this.startMarks = st.startMarks || {};
    this.journal = st.journal || {};
    this.feed = st.feed || null;
    this.mode = st.mode;
    this.seed = st.seed;
    this.speed = st.speed;
    this.playing = st.playing;
    this.ended = st.ended;
    this.symbol = st.symbol;
    const sym = this.symbol;
    if (this.candleSym !== sym || Date.now() - this.lastCandles > 1000) {
      const r = await this.api('GET', `/api/candles?symbol=${sym}&limit=400`);
      if (r.status === 200 && r.json.candles.length) {
        const cs: Candle[] = r.json.candles;
        this.eng.series[sym] = cs.slice(0, -1);
        this.eng.cur[sym] = cs[cs.length - 1];
        this.candleSym = sym;
        this.lastCandles = Date.now();
      }
    }
    this.error = null;
    this.emit();
  }

  private poll(): void {
    if (this.stopped) return;
    this.timer = window.setTimeout(async () => {
      await this.refresh(true);
      this.poll();
    }, this.playing ? 250 : 1200);
  }
  private fails = 0;
  async refresh(quiet = false): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const s = await this.api('GET', '/api/state');
      if (s.status === 401) {
        this.error = 'Your sign-in expired. Sign in again on the Risk tab.';
        this.emit();
        return;
      }
      if (s.status !== 200) throw new Error('status ' + s.status);
      this.fails = 0;
      await this.hydrate(s.json);
    } catch (e) {
      if (++this.fails >= 3 || !quiet) {
        this.error = 'Lost contact with the server. Retrying…';
        this.emit();
      }
    } finally {
      this.busy = false;
    }
  }

  private async cmd(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    let r;
    try {
      r = await this.api(method, path, body);
    } catch (e) {
      this.error = 'Could not reach the server.';
      this.emit();
      return { status: 0, json: { error: this.error } };
    }
    if ((r.status === 401 || r.status === 403) && this.onNotice) this.onNotice(r.json.error || 'Not allowed');
    await this.refresh();
    return r;
  }

  play(): Promise<void> {
    this.playing = true;
    this.emit();
    return this.cmd('POST', '/api/control/play').then(() => {});
  }
  pause(): Promise<void> {
    this.playing = false;
    return this.cmd('POST', '/api/control/pause').then(() => {});
  }
  stepBar(): Promise<void> {
    return this.cmd('POST', '/api/control/step').then(() => {});
  }
  setSpeed(s: number): Promise<void> {
    if (!SPEEDS.includes(s)) return Promise.resolve();
    return this.cmd('POST', '/api/control/speed', { speed: s }).then(() => {});
  }
  setSymbol(s: string): Promise<void> {
    return this.cmd('POST', '/api/control/symbol', { symbol: s }).then(() => {});
  }
  reset(mode?: Mode, seed?: number): Promise<void> {
    return this.cmd('POST', '/api/control/reset', { mode, seed }).then(() => {});
  }
  async placeOrder(req: OrderRequest): Promise<PlaceResult> {
    const r = await this.cmd('POST', '/api/orders', { symbol: req.symbol, side: req.side, type: req.type, qty: req.qty, price: req.price ?? null, bracket: req.bracket ? { stop_pct: req.bracket.stopPct, tp_pct: req.bracket.tpPct } : undefined });
    if (r.status === 201) return { ok: true, order: camelize(r.json.order) as Order };
    return { ok: false, reason: r.json.error || 'Order failed' };
  }
  cancelOrder(id: string): Promise<void> {
    return this.cmd('DELETE', '/api/orders/' + encodeURIComponent(id)).then(() => {});
  }
  killSwitch(): Promise<void> {
    return this.cmd('POST', '/api/risk/kill').then(() => {});
  }
  resumeTrading(): Promise<void> {
    return this.cmd('POST', '/api/risk/resume').then(() => {});
  }
  addBot(strategyId: string, symbol: string): Promise<void> {
    return this.cmd('POST', '/api/bots', { strategy: strategyId, symbol }).then(() => {});
  }
  removeBot(id: string): Promise<void> {
    return this.cmd('DELETE', '/api/bots/' + encodeURIComponent(id)).then(() => {});
  }
  async patchBot(id: string, p: BotPatch): Promise<string | null> {
    const body: any = {};
    if (p.enabled != null) body.enabled = p.enabled;
    if (p.params) body.params = p.params;
    if (p.allocPct != null) body.alloc_pct = p.allocPct;
    if (p.stopPct != null) body.stop_pct = p.stopPct;
    const r = await this.cmd('PATCH', '/api/bots/' + encodeURIComponent(id), body);
    return r.status === 200 ? null : r.json.error || 'Update failed';
  }
  async setLimit(key: string, v: number): Promise<void> {
    await this.cmd('PUT', '/api/config', { risk: { [snake(key)]: v } });
  }
  async setCost(key: string, v: number): Promise<void> {
    await this.cmd('PUT', '/api/config', { paper: { [snake(key)]: v } });
  }
  async backtest(o: BtRequest): Promise<{ r: any; split?: { train: any; test: any } }> {
    const res = await this.api('POST', '/api/backtest', { symbol: o.symbol, strategy: o.strategy, params: o.params, alloc_pct: o.allocPct, stop_pct: o.stopPct, split: o.split });
    if (res.status !== 200) throw new Error(res.json.error || 'Backtest failed');
    const j = res.json;
    return { r: { metrics: j.metrics, equity: j.equity, hold: j.hold, fills: [], warnings: j.warnings }, split: j.split && { train: j.split.train, test: j.split.test } };
  }
  journal: Record<string, JournalEntry> = {};
  feed: FeedStatus | null = null;
  async calibration(): Promise<Calibration> {
    const r = await this.api('GET', '/api/calibration');
    if (r.status !== 200) throw new Error(r.json.error || 'Could not load the comparison');
    return r.json as Calibration;
  }
  async setJournal(fillId: string, tag: string, note: string): Promise<void> {
    const r = await this.cmd('PUT', '/api/journal/' + encodeURIComponent(fillId), { tag, note });
    if (r.status !== 200) throw new Error(r.json.error || 'Could not save the note');
  }
  async sweep(o: BtRequest): Promise<SweepResult> {
    const res = await this.api('POST', '/api/sweep', { symbol: o.symbol, strategy: o.strategy, params: o.params, alloc_pct: o.allocPct, stop_pct: o.stopPct });
    if (res.status !== 200) throw new Error(res.json.error || 'Stress test failed');
    return res.json as SweepResult;
  }
  async stats(): Promise<Stats> {
    const r = await this.api('GET', '/api/stats');
    if (r.status !== 200) throw new Error(r.json.error || 'Could not load stats');
    return r.json as Stats;
  }
  async allFills(): Promise<Fill[]> {
    const r = await this.api('GET', '/api/fills');
    if (r.status !== 200) throw new Error(r.json.error || 'Could not load fills');
    return camelize(r.json.fills) as Fill[];
  }
  dispose(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
