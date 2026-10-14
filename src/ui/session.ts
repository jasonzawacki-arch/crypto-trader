import type { SweepResult } from '../core/backtest.js';
import type { JournalEntry } from '../core/stats.js';
import type { Candle, Fill, Order, OrderRequest, SymbolRules, Tick } from '../core/types.js';
import { computeStats, type Stats } from '../core/stats.js';
import { PaperExchange, DEFAULT_PAPER, type PaperConfig } from '../core/paper.js';
import { RiskManager, DEFAULT_RISK } from '../core/risk.js';
import { Engine } from '../core/engine.js';
import { ReplaySource, SyntheticSource, ticksFor, type CandleSource } from '../core/feeds.js';

export const H = 3600000;
export const TICKS_PER_BAR = 10;
export const SPEEDS = [1, 4, 15, 60];
export type Mode = 'replay' | 'synthetic' | 'live';
export interface FeedStatus {
  symbols: Record<string, { ageS: number | null; bid: number | null; ask: number | null; last: number | null }>;
  stale: string | null;
  pollS: number;
  staleAfterS: number;
  errors: number;
  lastError: string | null;
}
export interface Calibration {
  takerFills: number;
  paperCostBps: number | null;
  liveHalfSpreadBps: number | null;
  modelSpreadBps: number;
  spreads: Record<string, { samples: number; meanBps: number; medianBps: number; p90Bps: number }>;
  notes: string[];
}
const KEY = 'glasstrader.v1';
const START = 400;

export const RULES: SymbolRules[] = [
  { symbol: 'BTC-USD', base: 'BTC', quote: 'USD', minQty: 0.00001, qtyStep: 0.00000001, priceStep: 0.01 },
  { symbol: 'ETH-USD', base: 'ETH', quote: 'USD', minQty: 0.001, qtyStep: 0.000001, priceStep: 0.01 },
  { symbol: 'SOL-USD', base: 'SOL', quote: 'USD', minQty: 0.001, qtyStep: 0.000001, priceStep: 0.001 },
];

export type RawData = Record<string, number[][]>;
export const toCandles = (rows: number[][]): Candle[] => rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));

export interface BotPatch {
  enabled?: boolean;
  params?: Record<string, number>;
  allocPct?: number;
  stopPct?: number;
}
export interface BtRequest {
  symbol: string;
  strategy: string;
  params: Record<string, number>;
  allocPct: number;
  stopPct: number;
  split: boolean;
}
export type PlaceResult = { ok: true; order: Order } | { ok: false; reason: string };

/** What the UI needs from a trading backend. Session runs everything in the page; RemoteSession talks to the Python server. */
export interface Backend {
  readonly kind: 'local' | 'server';
  data: Record<string, Candle[]>;
  eng: Engine;
  mode: Mode;
  seed: number;
  speed: number;
  playing: boolean;
  ended: boolean;
  symbol: string;
  listeners: Set<() => void>;
  readonly ex: PaperExchange;
  /** Prices when the account began, for the buy-and-hold comparison. */
  startMarks: Record<string, number>;
  stats(): Promise<Stats>;
  allFills(): Promise<Fill[]>;
  rules(sym?: string): SymbolRules;
  symbols(): string[];
  emit(): void;
  play(): void | Promise<void>;
  pause(): void | Promise<void>;
  stepBar(): void | Promise<void>;
  setSpeed(s: number): void | Promise<void>;
  setSymbol(s: string): void | Promise<void>;
  reset(mode?: Mode, seed?: number): void | Promise<void>;
  placeOrder(req: OrderRequest): Promise<PlaceResult>;
  cancelOrder(id: string): void | Promise<void>;
  killSwitch(): void | Promise<void>;
  resumeTrading(): void | Promise<void>;
  addBot(strategyId: string, symbol: string): void | Promise<void>;
  removeBot(id: string): void | Promise<void>;
  patchBot(id: string, p: BotPatch): string | null | Promise<string | null>;
  setLimit(key: string, v: number): void | Promise<void>;
  setCost(key: string, v: number): void | Promise<void>;
  journal: Record<string, JournalEntry>;
  setJournal(fillId: string, tag: string, note: string): void | Promise<void>;
  save(force?: boolean): void;
  dispose(): void;
  /** Present when the backend runs backtests itself (the server does, on its own data). */
  backtest?(o: BtRequest): Promise<{ r: any; split?: { train: any; test: any } }>;
  sweep?(o: BtRequest): Promise<SweepResult>;
  /** Live price feed status (server only, live mode). */
  feed?: FeedStatus | null;
  who?: { name: string; role: string } | null;
  audit?(): Promise<any[]>;
  calibration?(): Promise<Calibration>;
  error?: string | null;
}

export class Session implements Backend {
  readonly kind = 'local' as const;
  error: string | null = null;
  data: Record<string, Candle[]> = {};
  startMarks: Record<string, number> = {};
  journal: Record<string, JournalEntry> = {};
  eng!: Engine;
  src!: CandleSource;
  mode: Mode = 'replay';
  seed = 1;
  speed = 4;
  playing = false;
  ended = false;
  symbol = 'BTC-USD';
  private q: Tick[] = [];
  private barOpen = false;
  private acc = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSave = 0;
  listeners = new Set<() => void>();
  storageOk = true;

  constructor(raw: RawData) {
    for (const [k, v] of Object.entries(raw)) this.data[k] = toCandles(v);
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

  private build(mode: Mode, seed: number, paper?: Partial<PaperConfig>, risk?: Partial<typeof DEFAULT_RISK>): void {
    this.mode = mode;
    this.seed = seed;
    const ex = new PaperExchange(paper || {}, RULES);
    const rm = new RiskManager(risk || {}, ex.cfg.startingCash);
    this.eng = new Engine(ex, rm, H);
    const syms = this.symbols();
    if (mode === 'replay') {
      this.src = new ReplaySource(this.data, START);
    } else {
      const last: Record<string, number> = {},
        vol: Record<string, number> = {};
      let t0 = 0;
      for (const s of syms) {
        const c = this.data[s];
        last[s] = c[c.length - 1].c;
        const vs = c.map((x) => x.v).sort((a, b) => a - b);
        vol[s] = vs[Math.floor(vs.length / 2)];
        t0 = c[c.length - 1].t + H;
      }
      this.src = new SyntheticSource(seed, last, vol, t0, H, 0);
    }
    const hist = this.history();
    for (const s of syms) this.eng.seed(s, hist[s]);
    this.q = [];
    this.barOpen = false;
    this.acc = 0;
    this.ended = false;
  }
  private history(): Record<string, Candle[]> {
    if (this.mode === 'replay') return this.src.history();
    return Object.fromEntries(this.symbols().map((s) => [s, this.data[s].slice(-START)]));
  }

  reset(mode: Mode = this.mode, seed = Math.floor(Math.random() * 1e6) + 1): void {
    const old = this.eng;
    this.pause();
    this.build(mode, seed, old ? old.ex.cfg : undefined, old ? old.risk.limits : undefined);
    // A fresh account keeps your cost and risk settings but starts from the configured cash.
    this.eng.risk.reset(this.eng.ex.cfg.startingCash);
    this.eng.note(0, 'info', `New ${mode === 'replay' ? 'replay of real Gemini hourly candles' : 'synthetic market, seed ' + seed}.`);
    this.prime();
    this.startMarks = { ...this.ex.marks };
    this.journal = {};
    this.save(true);
    this.emit();
  }
  setJournal(fillId: string, tag: string, note: string): void {
    tag = tag.trim().slice(0, 24);
    note = note.trim().slice(0, 500);
    if (tag || note) this.journal[fillId] = { tag, note };
    else delete this.journal[fillId];
    this.save(true);
    this.emit();
  }

  /** Plays the opening tick of every market so each one has a price to trade against. */
  private prime(): void {
    this.fillQueue();
    this.process(this.symbols().length);
  }

  private fillQueue(): boolean {
    const bars = this.src.next();
    if (!bars) {
      this.ended = true;
      return false;
    }
    const lists = this.symbols().map((s) => ticksFor(s, bars[s], TICKS_PER_BAR, H));
    const q: Tick[] = [];
    for (let i = 0; i < TICKS_PER_BAR; i++) for (const l of lists) q.push(l[i]);
    this.q = q;
    this.barOpen = true;
    return true;
  }

  private process(n: number): void {
    for (let i = 0; i < n; i++) {
      if (!this.q.length) {
        this.barOpen = false;
        if (!this.fillQueue()) {
          this.pause();
          this.eng.note(this.ex.now, 'info', 'End of the data. Press restart to run again.');
          break;
        }
      }
      const tk = this.q.shift()!;
      this.eng.tick(tk);
      if (!this.q.length) this.barOpen = false;
    }
  }

  play(): void {
    if (this.playing || this.ended) return;
    this.playing = true;
    this.timer = setInterval(() => this.frame(), 50);
    this.emit();
  }
  pause(): void {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.save(true);
    this.emit();
  }
  setSpeed(s: number): void {
    this.speed = s;
    this.emit();
  }
  /** Advance by one full bar. */
  stepBar(): void {
    const n = this.q.length || TICKS_PER_BAR;
    this.process(n);
    this.save();
    this.emit();
  }
  private frame(): void {
    this.acc += this.speed * TICKS_PER_BAR * 0.05;
    const n = Math.floor(this.acc);
    this.acc -= n;
    if (n > 0) this.process(n);
    this.emit();
    if (Date.now() - this.lastSave > 4000) this.save();
  }

  // ---- commands shared with RemoteSession
  async stats(): Promise<Stats> {
    return computeStats({ fills: this.ex.fills, equityLog: this.eng.equityLog, startCash: this.ex.cfg.startingCash, equity: this.ex.equity() });
  }
  async allFills(): Promise<Fill[]> {
    return this.ex.fills.slice();
  }
  setSymbol(s: string): void {
    this.symbol = s;
    this.save();
    this.emit();
  }
  async placeOrder(req: OrderRequest): Promise<PlaceResult> {
    const r = this.eng.placeManual(req);
    this.save(true);
    this.emit();
    return r.ok ? { ok: true, order: r.order } : { ok: false, reason: r.reason };
  }
  cancelOrder(id: string): void {
    this.ex.cancel(id);
    this.save();
    this.emit();
  }
  killSwitch(): void {
    this.eng.kill(this.ex.now);
    this.save(true);
    this.emit();
  }
  resumeTrading(): void {
    this.eng.risk.reset(this.ex.equity());
    this.eng.note(this.ex.now, 'info', 'Trading resumed. Bots stay stopped until you start them.');
    this.save(true);
    this.emit();
  }
  addBot(strategyId: string, symbol: string): void {
    this.eng.addBot({ strategyId, symbol });
    this.save(true);
    this.emit();
  }
  removeBot(id: string): void {
    this.eng.removeBot(id);
    this.save(true);
    this.emit();
  }
  patchBot(id: string, p: BotPatch): string | null {
    const b = this.eng.bot(id);
    if (!b) return 'No such bot';
    if (p.enabled && this.eng.risk.blocked()) return 'Resume trading on the Risk tab first.';
    if (p.enabled != null) b.cfg.enabled = p.enabled;
    if (p.params) Object.assign(b.cfg.params, p.params);
    if (p.allocPct != null) b.cfg.allocPct = p.allocPct;
    if (p.stopPct != null) b.cfg.stopPct = p.stopPct;
    this.save(true);
    this.emit();
    return null;
  }
  setLimit(key: string, v: number): void {
    (this.eng.risk.limits as any)[key] = v;
    this.save(true);
  }
  setCost(key: string, v: number): void {
    (this.ex.cfg as any)[key] = v;
    this.save(true);
  }
  dispose(): void {
    this.pause();
  }

  // ---- persistence
  private resumeIndex(): number {
    return this.src.index - (this.barOpen ? 1 : 0);
  }
  save(force = false): void {
    this.lastSave = Date.now();
    try {
      const s = this.eng.serialize();
      localStorage.setItem(
        KEY,
        JSON.stringify({ v: 1, startMarks: this.startMarks, journal: this.journal, mode: this.mode, seed: this.seed, speed: this.speed, symbol: this.symbol, resume: this.resumeIndex(), eng: s }),
      );
      this.storageOk = true;
    } catch (e) {
      this.storageOk = false;
    }
    void force;
  }
  load(): boolean {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch (e) {
      return false;
    }
    if (!raw) return false;
    try {
      const s = JSON.parse(raw);
      if (s.v !== 1) return false;
      this.build(s.mode, s.seed, s.eng.ex.cfg, s.eng.risk.limits);
      // Rebuild the market up to where the session stopped.
      const syms = this.symbols();
      const bars: Record<string, Candle[]> = Object.fromEntries(syms.map((x) => [x, []]));
      for (let i = this.src.index; i < s.resume; i++) {
        const b = this.src.next();
        if (!b) break;
        syms.forEach((x) => bars[x].push(b[x]));
      }
      for (const x of syms) this.eng.seed(x, this.history()[x].concat(bars[x]));
      this.eng.ex.restore(s.eng.ex);
      this.eng.risk.s = s.eng.risk.s;
      this.eng.bots = s.eng.bots;
      (this.eng as any).botSeq = s.eng.botSeq;
      this.eng.equityLog = s.eng.equityLog;
      this.eng.log = s.eng.log;
      this.speed = s.speed;
      this.symbol = s.symbol;
      this.journal = s.journal && typeof s.journal === 'object' ? s.journal : {};
      this.eng.ex.onFill = (f) => (this.eng as any).handleFill(f);
      this.eng.note(this.ex.now, 'info', 'Session restored. Playback is paused.');
      this.prime();
      this.startMarks = s.startMarks && Object.keys(s.startMarks).length ? s.startMarks : { ...this.ex.marks };
      return true;
    } catch (e) {
      return false;
    }
  }
}
