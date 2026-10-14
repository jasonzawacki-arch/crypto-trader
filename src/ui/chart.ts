import type { Candle, Fill, Order } from '../core/types.js';
import { smaSeries } from '../core/indicators.js';

export interface Theme {
  ink: string;
  mute: string;
  grid: string;
  up: string;
  down: string;
  accent: string;
  line: string;
  surface: string;
}
export function readTheme(el: Element): Theme {
  const cs = getComputedStyle(el);
  const g = (n: string) => cs.getPropertyValue(n).trim();
  return { ink: g('--ink'), mute: g('--mute'), grid: g('--grid'), up: g('--up'), down: g('--down'), accent: g('--accent'), line: g('--line'), surface: g('--surface') };
}

function fit(cv: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const r = cv.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(r.width * dpr),
    h = Math.round(r.height * dpr);
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  return { ctx, w: r.width, h: r.height };
}

const niceStep = (range: number, ticks: number): number => {
  const raw = range / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
};
const fmtP = (x: number, d: number) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtT = (t: number) => {
  const d = new Date(t);
  return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
};

export interface CandleOpts {
  candles: Candle[]; // closed candles plus the forming one at the end
  bars: number;
  decimals: number;
  fills: Fill[];
  orders: Order[];
  avgCost: number | null;
  sma: boolean;
  hover: number | null; // index within the visible slice
  /** The order being typed in the ticket, drawn as a dashed line so you can see where it would sit. */
  ticket?: { price: number; side: string; type: string } | null;
  th: Theme;
}
export interface CandleGeom {
  x0: number;
  step: number;
  n: number;
  start: number;
  /** Converts a y position (CSS px inside the canvas) to a price. */
  priceAt: (y: number) => number;
}

export function drawCandles(cv: HTMLCanvasElement, o: CandleOpts): CandleGeom | null {
  const f = fit(cv);
  if (!f) return null;
  const { ctx, w, h } = f;
  const th = o.th;
  const all = o.candles;
  const start = Math.max(0, all.length - o.bars);
  const vis = all.slice(start);
  if (!vis.length) return null;
  const padR = 62,
    padB = 22,
    volH = Math.round(h * 0.16);
  const plotW = w - padR,
    plotH = h - padB - volH - 6;
  let lo = Infinity,
    hi = -Infinity;
  for (const c of vis) {
    lo = Math.min(lo, c.l);
    hi = Math.max(hi, c.h);
  }
  const s20 = o.sma ? smaSeries(all.map((c) => c.c), 20).slice(start) : [];
  const s50 = o.sma ? smaSeries(all.map((c) => c.c), 50).slice(start) : [];
  for (const v of [...s20, ...s50]) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (o.avgCost) { lo = Math.min(lo, o.avgCost); hi = Math.max(hi, o.avgCost); }
  const padv = (hi - lo) * 0.06 || hi * 0.01;
  lo -= padv;
  hi += padv;
  const Y = (p: number) => 4 + (1 - (p - lo) / (hi - lo)) * plotH;
  const step = plotW / Math.max(vis.length, o.bars * 0.25);
  const X = (i: number) => 6 + i * step + step / 2;
  ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';
  ctx.textBaseline = 'middle';

  // grid and axis
  const ts = niceStep(hi - lo, 5);
  ctx.strokeStyle = th.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = th.mute;
  ctx.textAlign = 'left';
  for (let p = Math.ceil(lo / ts) * ts; p < hi; p += ts) {
    const y = Math.round(Y(p)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(plotW, y);
    ctx.stroke();
    ctx.fillText(fmtP(p, ts < 1 ? 2 : 0), plotW + 6, y);
  }
  // time labels
  ctx.textAlign = 'center';
  const every = Math.max(6, Math.ceil(120 / step / 6) * 6);
  for (let i = 0; i < vis.length; i += every) {
    const x = X(i);
    if (x > plotW - 40) break;
    if (x < 46) continue;
    ctx.fillText(fmtT(vis[i].t), x, h - 8);
  }
  // volume
  const vmax = Math.max(...vis.map((c) => c.v)) || 1;
  const bw = Math.max(1, Math.min(14, step * 0.64));
  for (let i = 0; i < vis.length; i++) {
    const c = vis[i];
    ctx.fillStyle = (c.c >= c.o ? th.up : th.down) + '55';
    const vh = (c.v / vmax) * volH;
    ctx.fillRect(X(i) - bw / 2, h - padB - vh, bw, vh);
  }
  // averages
  const drawLine = (arr: (number | null)[], color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let on = false;
    arr.forEach((v, i) => {
      if (v == null) return;
      if (!on) { ctx.moveTo(X(i), Y(v)); on = true; } else ctx.lineTo(X(i), Y(v));
    });
    ctx.stroke();
  };
  if (o.sma) {
    drawLine(s20, th.accent);
    drawLine(s50, th.mute);
  }
  // candles
  for (let i = 0; i < vis.length; i++) {
    const c = vis[i];
    const col = c.c >= c.o ? th.up : th.down;
    const x = Math.round(X(i)) + 0.5;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, Y(c.h));
    ctx.lineTo(x, Y(c.l));
    ctx.stroke();
    const top = Y(Math.max(c.o, c.c)),
      bot = Y(Math.min(c.o, c.c));
    ctx.fillRect(Math.round(x - bw / 2), top, Math.max(1, Math.round(bw)), Math.max(1, bot - top));
  }
  // average cost
  const dashed = (y: number, color: string, label: string) => {
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(plotW, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(label, 8, y - 7);
  };
  if (o.avgCost) dashed(Y(o.avgCost), th.accent, 'avg cost ' + fmtP(o.avgCost, o.decimals));
  for (const ord of o.orders) {
    if (ord.price) dashed(Y(ord.price), ord.side === 'buy' ? th.up : th.down, `${ord.type} ${ord.side} ${fmtP(ord.price, o.decimals)}`);
  }
  if (o.ticket && o.ticket.price > 0 && o.ticket.price > lo && o.ticket.price < hi) {
    dashed(Y(o.ticket.price), o.ticket.side === 'buy' ? th.up : th.down, `your ${o.ticket.type} ${o.ticket.side} ${fmtP(o.ticket.price, o.decimals)}`);
  }
  // fill markers
  const t0 = vis[0].t,
    ms = vis.length > 1 ? vis[1].t - vis[0].t : 3600000;
  for (const fl of o.fills.slice(-60)) {
    if (fl.t < t0) continue;
    const i = Math.min(vis.length - 1, Math.floor((fl.t - t0) / ms));
    const x = X(i),
      y = Y(fl.price);
    ctx.fillStyle = fl.side === 'buy' ? th.up : th.down;
    ctx.strokeStyle = th.surface;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (fl.side === 'buy') { ctx.moveTo(x, y - 3); ctx.lineTo(x - 6, y + 9); ctx.lineTo(x + 6, y + 9); }
    else { ctx.moveTo(x, y + 3); ctx.lineTo(x - 6, y - 9); ctx.lineTo(x + 6, y - 9); }
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
  }
  // last price tag
  const last = vis[vis.length - 1];
  const ly = Y(last.c);
  ctx.strokeStyle = th.mute;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(0, Math.round(ly) + 0.5);
  ctx.lineTo(plotW, Math.round(ly) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
  const up = last.c >= last.o;
  ctx.fillStyle = up ? th.up : th.down;
  ctx.fillRect(plotW + 1, ly - 9, padR - 1, 18);
  ctx.fillStyle = '#04110b';
  ctx.textAlign = 'left';
  ctx.fillText(fmtP(last.c, o.decimals), plotW + 6, ly);
  // crosshair
  if (o.hover != null && o.hover >= 0 && o.hover < vis.length) {
    const hx = X(o.hover);
    ctx.strokeStyle = th.mute;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hx, 0);
    ctx.lineTo(hx, plotH + 4);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  return { x0: 6, step, n: vis.length, start, priceAt: (y: number) => lo + (1 - (y - 4) / plotH) * (hi - lo) };
}

export interface Series {
  name: string;
  pts: { t: number; e: number }[];
  color: string;
  dash?: boolean;
}
/** Equity-style line chart: one shared y scale, values labelled at the right edge. */
export function drawLines(cv: HTMLCanvasElement, series: Series[], th: Theme, opts: { base?: number; mark?: number; money?: boolean } = {}): void {
  const f = fit(cv);
  if (!f) return;
  const { ctx, w, h } = f;
  const all = series.flatMap((s) => s.pts);
  if (all.length < 2) {
    ctx.fillStyle = th.mute;
    ctx.font = '12px Manrope, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('The curve appears after a few bars.', w / 2, h / 2);
    return;
  }
  const padR = 56,
    padB = 18,
    padT = 6;
  let lo = Math.min(...all.map((p) => p.e)),
    hi = Math.max(...all.map((p) => p.e));
  if (opts.base != null) { lo = Math.min(lo, opts.base); hi = Math.max(hi, opts.base); }
  const pad = (hi - lo) * 0.08 || hi * 0.002;
  lo -= pad;
  hi += pad;
  const t0 = Math.min(...all.map((p) => p.t)),
    t1 = Math.max(...all.map((p) => p.t));
  const X = (t: number) => ((t - t0) / (t1 - t0 || 1)) * (w - padR - 8) + 4;
  const Y = (e: number) => padT + (1 - (e - lo) / (hi - lo)) * (h - padB - padT);
  ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  const ts = niceStep(hi - lo, 3);
  ctx.strokeStyle = th.grid;
  ctx.fillStyle = th.mute;
  ctx.lineWidth = 1;
  ctx.textAlign = 'left';
  for (let p = Math.ceil(lo / ts) * ts; p < hi; p += ts) {
    const y = Math.round(Y(p)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText((opts.money === false ? '' : '$') + fmtP(p, 0), w - padR + 6, y);
  }
  if (opts.base != null) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = th.mute;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(Y(opts.base)) + 0.5);
    ctx.lineTo(w - padR, Math.round(Y(opts.base)) + 0.5);
    ctx.stroke();
    ctx.restore();
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = th.mute;
  const nl = w > 560 ? 3 : 2;
  for (let k = 0; k < nl; k++) {
    const t = t0 + ((t1 - t0) * (k + (nl === 2 ? 0.3 : 0))) / (nl === 3 ? 2.4 : 1.6);
    ctx.fillText(fmtT(t), Math.min(w - padR - 30, Math.max(46, X(t))), h - 7);
  }
  if (opts.mark != null) {
    const x = X(opts.mark);
    ctx.strokeStyle = th.mute;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, h - padB);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.dash ? 1.4 : 2;
    ctx.setLineDash(s.dash ? [5, 4] : []);
    ctx.beginPath();
    s.pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.e)) : ctx.moveTo(X(p.t), Y(p.e))));
    ctx.stroke();
    ctx.setLineDash([]);
    const lp = s.pts[s.pts.length - 1];
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(X(lp.t), Y(lp.e), 3, 0, 7);
    ctx.fill();
  }
}
