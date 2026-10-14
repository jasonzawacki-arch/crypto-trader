export const sma = (v: number[], n: number, end = v.length): number | null => {
  if (n <= 0 || end < n) return null;
  let s = 0;
  for (let i = end - n; i < end; i++) s += v[i];
  return s / n;
};
export function smaSeries(v: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= n) s -= v[i - n];
    out.push(i >= n - 1 ? s / n : null);
  }
  return out;
}
/** Wilder RSI over the last values; null until n+1 closes exist. */
export function rsi(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d;
    else l -= d;
  }
  g /= n;
  l /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (n - 1) + (d > 0 ? d : 0)) / n;
    l = (l * (n - 1) + (d < 0 ? -d : 0)) / n;
  }
  if (l === 0) return g === 0 ? 50 : 100;
  return 100 - 100 / (1 + g / l);
}
/** Average true range: mean of the last n true ranges (needs n+1 candles). */
export function atr(c: { h: number; l: number; c: number }[], n: number, end = c.length): number | null {
  if (end < n + 1) return null;
  let s = 0;
  for (let i = end - n; i < end; i++) s += Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
  return s / n;
}
/** Population standard deviation of the last n values. */
export function stdev(v: number[], n: number, end = v.length): number | null {
  if (end < n || n <= 0) return null;
  let m = 0;
  for (let i = end - n; i < end; i++) m += v[i];
  m /= n;
  let q = 0;
  for (let i = end - n; i < end; i++) q += (v[i] - m) * (v[i] - m);
  return Math.sqrt(q / n);
}
export const highest = (v: number[], n: number, end = v.length): number | null =>
  end < n ? null : Math.max(...v.slice(end - n, end));
export const lowest = (v: number[], n: number, end = v.length): number | null =>
  end < n ? null : Math.min(...v.slice(end - n, end));
