export const decimals = (step: number): number => {
  const s = String(step);
  if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
};
/** Round down to a step without floating point drift. */
export const floorTo = (x: number, step: number): number =>
  Number((Math.floor(x / step + 1e-9) * step).toFixed(decimals(step)));
export const roundTo = (x: number, step: number): number =>
  Number((Math.round(x / step) * step).toFixed(decimals(step)));

/** Small deterministic PRNG so replays, synthetic markets and tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gauss(r: () => number): number {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}
export const fmtUsd = (x: number, d = 2): string =>
  (x < 0 ? '-' : '') + '$' + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
