# Glass Trader server (Python)

The server owns the account, exchange connection, risk limits and kill switch. The browser is a thin client.

```
pip install -e ".[dev]"          # starlette, uvicorn, sse-starlette (+ pytest, httpx for dev)
GT_TOKEN=change-me uvicorn gtrader.api:app --host 127.0.0.1 --port 8000
python -m unittest discover -s tests -t .        # or: pytest
```

- Paper exchange only. `GT_EXCHANGE=live` refuses to start; a live adapter must implement `types.Exchange`.
- `GT_TOKEN` enables bearer auth (`Authorization: Bearer ...`; `?token=` only for the event stream, which cannot send headers). Keep it set anywhere but localhost.
- Without a password (no `GT_TOKEN`, no users) the server answers only to requests addressed to localhost, so a website you visit cannot reach it through DNS tricks. `GT_HOSTS=name1,name2` adds host names for that case; with a password set, any host name works.
- Changes must be JSON (`Content-Type: application/json`) and must come from the app's own page or a site listed in `GT_CORS`, so other websites cannot place orders through your browser.
- `GT_DB=gt.sqlite3` saves the account (orders, fills, bots, risk state) so a restart resumes where it stopped; fills are also journaled append-only. Without it, state is in memory only.
- `GT_CORS=https://your.site` allows a browser page on another origin (to read and to make changes). `GT_CORS=*` allows every site; use it only with a password, since without one any website you visit could control the server (it prints a warning). `GT_DATA` points at a candles file.
- Endpoints: `GET /api/health|state|candles|strategies|stream` (SSE), `POST /api/control/{play,pause,step,speed,symbol,reset}`,
  `POST /api/orders`, `DELETE /api/orders/{id}`, `POST/PATCH/DELETE /api/bots`, `POST /api/risk/{kill,resume}`, `PUT /api/config`, `POST /api/backtest`, `POST /api/sweep`, `PUT /api/journal/{id}`, `GET /api/calibration`, `POST /api/login`, `GET /api/me|users|audit`.
- `tests/test_parity.py` checks this core against the TypeScript core's results (`tests/golden.json`, regenerate with `node tests/golden.mjs` from the repo root).

## Running it for real use

```
# one process serves the API and the installable app (build the UI first: `npm run build` in the repo root)
GT_TOKEN=change-me GT_DB=gt.sqlite3 GT_STATIC=../dist uvicorn gtrader.api:app --host 127.0.0.1 --port 8000
```
Open http://127.0.0.1:8000. The page connects to the server on its own, and your browser offers "Install app".
Put it behind HTTPS (Caddy or nginx) before exposing it beyond your machine; keep `GT_TOKEN` set.

## Live prices (paper money)
`GT_LIVE=1` adds "Live prices" to the Market data choices. It reads Gemini's public candles and ticker (no keys needed); orders are still simulated.
`GT_LIVE_POLL=5` seconds between polls, `GT_STALE_AFTER=30` seconds before buying pauses and an alert fires. `GET /api/calibration` and the Risk tab compare paper fills with the live bid/ask.
Tested with a fake client only, including outage and recovery; run it on your own machine and watch it for a while before trusting it.

## Logins and audit
Single user: `GT_TOKEN` works as before and counts as an admin.
Several people: create users, then sign in from the Risk tab with a name and password (tokens last 12 hours).
```
GT_DB=gt.sqlite3 python -m gtrader.users add alice trader     # prompts for the password; roles: viewer, trader, admin
GT_ADMIN_USER=root GT_ADMIN_PASSWORD=...                       # optional: creates the first admin when there are no users
```
viewer reads and runs backtests; trader also trades, runs bots, plays the market, uses the kill switch and journal; admin also changes limits and costs, resets the account, manages users and reads `GET /api/audit`.
Every change and every sign-in attempt is recorded with who, what and the result (passwords never). Five wrong passwords lock a name and address out for five minutes.
Role changes and removals apply immediately. Set `GT_SECRET` to keep tokens valid across database changes. Use HTTPS beyond localhost. All users share one paper account.

## Stress test and journal
`POST /api/sweep` (viewer role) runs the what-if set on the server's own data. `PUT /api/journal/{fillId}` stores a tag and note on a fill.

## Alerts
`GT_ALERT_URL=https://ntfy.sh/your-secret-topic` sends risk halts, the kill switch and fills to your phone.
`GT_ALERT_FORMAT=json` for Slack/Discord webhooks, `GT_ALERT_KINDS=risk,fill,warn` to choose what is sent. At most 20 per minute.

## Gemini (read-only)
`GT_GEMINI_KEY` / `GT_GEMINI_SECRET`: create the key at Gemini with **no trading and no withdrawal permission**.
`GET /api/venue` shows whether keys are set; `GET /api/venue?check=1` fetches your balances and open orders and lists
differences from the paper account. The client has no way to place or cancel orders (tested). It follows Gemini's docs but
was only tested against a fake transport, so try it on your own machine before relying on it.

## Longer history
```
python -m gtrader.history fetch --out data/candles.json         # Gemini's last ~60 days, merged in; schedule it daily
python -m gtrader.history import BTC-USD btc.csv --out data/candles.json   # any OHLCV CSV (repeat per symbol)
python -m gtrader.history check data/candles.json
GT_DATA=data/candles.json uvicorn ...
```
Symbols are aligned to shared hourly timestamps. In server mode, backtests run on the server's data, so a multi-year
file is used without being sent to the browser.
