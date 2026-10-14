export interface StatFill {
  side: string;
  symbol: string;
  source: string;
  realized: number;
  fee: number;
}
export interface StatsInput {
  fills: StatFill[];
  equityLog: { t: number; e: number }[];
  startCash: number;
  equity: number;
}
export interface GroupStat {
  key: string;
  trades: number;
  realized: number;
  fees: number;
  winRatePct: number | null;
}
export interface Stats {
  startCash: number;
  equity: number;
  returnPct: number;
  maxDrawdownPct: number;
  feesPaid: number;
  realized: number;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  best: number | null;
  worst: number | null;
  bySource: GroupStat[];
  bySymbol: GroupStat[];
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

function group(fills: StatFill[], keyOf: (f: StatFill) => string): GroupStat[] {
  const m = new Map<string, { trades: number; wins: number; realized: number; fees: number }>();
  for (const f of fills) {
    const k = keyOf(f);
    const g = m.get(k) ?? { trades: 0, wins: 0, realized: 0, fees: 0 };
    g.fees += f.fee;
    if (f.side === 'sell') {
      g.trades++;
      g.realized += f.realized;
      if (f.realized > 0) g.wins++;
    }
    m.set(k, g);
  }
  return [...m.entries()]
    .map(([key, g]) => ({ key, trades: g.trades, realized: g.realized, fees: g.fees, winRatePct: g.trades ? (g.wins / g.trades) * 100 : null }))
    .sort((a, b) => b.realized - a.realized || (a.key < b.key ? -1 : 1));
}

export interface JournalEntry {
  tag: string;
  note: string;
}
export const JOURNAL_TAGS = ['Plan', 'Breakout', 'Dip buy', 'News', 'Hunch', 'FOMO', 'Panic', 'Test'];
/**
 * Results grouped by tag. A closed trade (a sell) takes its own tag, or else the tag of the latest tagged buy of the
 * same coin before it, so you can label the reason for entering and still see how that reason performed.
 */
export function statsByTag(fills: (StatFill & { id: string })[], journal: Record<string, JournalEntry>): GroupStat[] {
  const entry = new Map<string, string>();
  const tagOf = new Map<string, string>();
  for (const f of fills) {
    const own = journal[f.id]?.tag;
    if (f.side === 'buy') {
      if (own) entry.set(f.symbol, own);
      tagOf.set(f.id, own || entry.get(f.symbol) || 'Untagged');
    } else {
      tagOf.set(f.id, own || entry.get(f.symbol) || 'Untagged');
    }
  }
  return group(fills, (f) => tagOf.get((f as unknown as { id: string }).id) || 'Untagged');
}

/** Session statistics from fills and the equity curve. A closed trade is a sell; realized profit is already net of fees. */
export function computeStats(i: StatsInput): Stats {
  const sells = i.fills.filter((f) => f.side === 'sell');
  const wins = sells.filter((f) => f.realized > 0).map((f) => f.realized);
  const losses = sells.filter((f) => f.realized < 0).map((f) => -f.realized);
  const gw = wins.reduce((s, x) => s + x, 0);
  const gl = losses.reduce((s, x) => s + x, 0);
  let peak = i.startCash,
    dd = 0;
  for (const p of [...i.equityLog.map((x) => x.e), i.equity]) {
    peak = Math.max(peak, p);
    dd = Math.max(dd, (peak - p) / peak);
  }
  const rs = sells.map((f) => f.realized);
  return {
    startCash: i.startCash,
    equity: i.equity,
    returnPct: (i.equity / i.startCash - 1) * 100,
    maxDrawdownPct: dd * 100,
    feesPaid: i.fills.reduce((s, f) => s + f.fee, 0),
    realized: rs.reduce((s, x) => s + x, 0),
    trades: sells.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: sells.length ? (wins.length / sells.length) * 100 : null,
    avgWin: mean(wins),
    avgLoss: mean(losses),
    expectancy: mean(rs),
    profitFactor: gl > 0 ? gw / gl : null,
    best: rs.length ? Math.max(...rs) : null,
    worst: rs.length ? Math.min(...rs) : null,
    bySource: group(i.fills, (f) => f.source),
    bySymbol: group(i.fills, (f) => f.symbol),
  };
}
