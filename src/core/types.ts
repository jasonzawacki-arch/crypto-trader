// Shared types. Spot market, long-only: no margin, no shorting.
export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';
export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'rejected';

export interface Candle {
  t: number; // open time, ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // base volume
}

export interface Tick {
  symbol: string;
  t: number;
  price: number;
  /** Base-currency volume of the bar this tick belongs to. Scales market impact and the volume bars. */
  vol: number;
}

export interface SymbolRules {
  symbol: string; // "BTC-USD"
  base: string;
  quote: string;
  minQty: number;
  qtyStep: number;
  priceStep: number;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  /** Limit price for limit orders, trigger price for stop orders. */
  price?: number;
  source?: string; // 'manual' or a bot id
  /** Orders sharing a group are one-cancels-other and share a single reservation of the position. */
  group?: string;
  /** On a buy: once it fills, place a protective stop and/or a take-profit as one OCO pair. Percentages, 0 = off. */
  bracket?: { stopPct: number; tpPct: number };
}

export interface Order extends OrderRequest {
  id: string;
  status: OrderStatus;
  createdAt: number;
  filledAt?: number;
  fillPrice?: number;
  fee?: number;
  reason?: string;
  /** Cash held for an open buy order, in quote currency. */
  reserve?: number;
  source: string;
}

export interface Fill {
  id: string;
  orderId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  fee: number;
  t: number;
  source: string;
  maker: boolean;
  /** Realized profit of a sell, net of fees and cost basis. 0 for buys. */
  realized: number;
}

export interface Position {
  symbol: string;
  qty: number;
  /** Total cost of the open quantity, including buy fees. */
  cost: number;
}

export interface Exchange {
  readonly name: string;
  readonly live: boolean;
  rules(symbol: string): SymbolRules;
  placeOrder(req: OrderRequest): Promise<Order>;
  cancelOrder(id: string): Promise<boolean>;
  openOrders(): Order[];
}

export type Signal =
  | { type: 'hold'; note?: string }
  | { type: 'buy'; note: string }
  | { type: 'sell'; note: string };

export interface StrategyContext {
  candles: Candle[]; // closed candles only, oldest first, last one just closed
  inPosition: boolean;
  entryPrice: number | null;
}

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
}

export interface Strategy {
  id: string;
  name: string;
  blurb: string;
  params: ParamDef[];
  /** Lets the bot keep buying while it already holds (dollar-cost averaging). No protective stop is attached. */
  accumulate?: boolean;
  warmup(p: Record<string, number>): number;
  onCandle(p: Record<string, number>, ctx: StrategyContext): Signal;
}
