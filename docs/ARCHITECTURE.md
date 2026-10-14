# Glass Trader: architecture and the path to live

Paper only today. Spot, long-only, BTC/ETH/SOL vs USD.

## Layers
- `core/` pure TypeScript, no DOM: types, PaperExchange, RiskManager, Engine (candles, bots, stops, kill switch), strategies, backtester, feeds.
- `ui/` Session (playback, persistence), chart (canvas), app (views).
- Backtests and the live paper session use the same Engine, exchange and risk code.

## Two implementations, one behaviour
The browser needs the logic in TypeScript so it works with no server. The server needs it in Python. There is no honest way to run one copy in both places from a static page, so the two are kept identical by tests: `tests/golden.mjs` runs the TypeScript core and writes `server/tests/golden.json`; `server/tests/test_parity.py` replays the same backtests, sweeps, stats, synthetic bars and seeded random order scenarios in Python and requires matches to 1e-9. Change a rule in one place and CI fails until the other follows. Indicators that must match bit for bit use explicit loops, and `js_round`, `floor_to` and `round_to` mimic JavaScript.

## Server layers
`api` (Starlette, auth middleware, audit) over `session` (account, feed, persistence) over `engine`, `paper`, `risk`. `store` is SQLite: snapshot, append-only fills, events, users, audit, signing secret. `live` polls public Gemini quotes. `gemini` is a read-only client that refuses any endpoint outside a short allow-list. `auth` has scrypt passwords, HMAC-signed expiring tokens and role checks.

## Live prices (still paper)
`GT_LIVE=1` lets a session use real Gemini quotes: hourly candles warm up the indicators, the public ticker is polled every few seconds, and orders fill against the simulated exchange. If any coin's quote is older than `GT_STALE_AFTER` seconds the risk manager blocks new buys (sells and protective stops still work), a risk alert fires, and it clears when quotes return. Each paper market-style fill is compared with the quoted bid and ask at that moment, and spread samples are kept, so you can see whether the cost settings are realistic. That compares costs with quotes only. It cannot show queue position, partial fills or price movement caused by your own order.

## Honest-simulation rules
Costs on by default (40 bps taker, 20 maker, 6 spread, size impact). Limit orders fill only when price trades through. Bots act on closed candles and fill at the next bar (no look-ahead). Reservations stop double-spending cash or coins. Tests check the equity = cash + holdings invariant.

## Wiring a real exchange
1. Backend proxy (you host it) holds API keys: trade-only, no withdrawals, IP-allowlisted. Browser never sees keys.
2. Implement `Exchange` (placeOrder, cancelOrder, openOrders, rules) against it. Add a live tick/candle source using the exchange's websocket.
3. Reconcile balances and open orders on start and on every reconnect; the exchange is the source of truth.
4. Repeat risk limits server-side (order size, position, daily loss, drawdown) plus an out-of-band kill switch.
5. Run paper alongside live on the same feed, compare fills, and start with trivially small size.
Not done: partial fills, fee tiers, rate limits, order-status polling, idempotent client order ids.
