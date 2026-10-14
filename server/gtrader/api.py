"""HTTP API (Starlette). The browser is a thin client: it sends commands and reads state.

Run:  GT_TOKEN=secret uvicorn gtrader.api:app --host 127.0.0.1 --port 8000
Without GT_TOKEN (or users) the API is open, so it then answers only to requests addressed to localhost.
Changes (POST, PUT, PATCH, DELETE) must be JSON and must not come from another website unless it is listed in
GT_CORS, so a page you happen to visit cannot place orders on a server running on your computer.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import os
from dataclasses import asdict, replace
from typing import Optional
from urllib.parse import urlparse

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from pathlib import Path

from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Route
from sse_starlette.sse import EventSourceResponse

from .auth import ROLES, Auth, needed_role, summarize
from .backtest import BacktestOptions, run_backtest, run_split, run_sweep
from .exchange import make_exchange_guard
from .gemini import GeminiReadOnly, reconcile
from .session import H, Session
from .stats import compute_stats
from .strategies import STRATEGIES, default_params, strategy_by_id
from .types import OrderRequest

PAPER_KEYS = {"starting_cash", "taker_bps", "maker_bps", "spread_bps", "impact_coef", "max_impact_bps"}
RISK_KEYS = {"max_order_pct", "max_position_pct", "max_daily_loss_pct", "max_drawdown_pct", "min_notional"}
TOKEN = os.environ.get("GT_TOKEN", "")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]"}


def host_name(host: str) -> str:
    """The name part of a Host header: 'localhost:8000' -> 'localhost', '[::1]:8000' -> '[::1]'."""
    host = host.strip().lower()
    if host.startswith("["):
        return host[: host.find("]") + 1]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def err(msg: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": msg}, status_code=status)


async def body(req: Request) -> dict:
    try:
        b = await req.json()
    except Exception:
        return {}
    return b if isinstance(b, dict) else {}


def num(b: dict, key: str, default=None):
    v = b.get(key, default)
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{key} must be a number")
    return v


def make_app(session: Optional[Session] = None, token: str = TOKEN, venue: Optional[GeminiReadOnly] = None,
             static_dir: Optional[str] = None) -> Starlette:
    from .alerts import Notifier
    S = session or Session(notifier=Notifier.from_env())
    V = venue or GeminiReadOnly.from_env()
    make_exchange_guard()
    if os.environ.get("GT_LIVE") == "1" and S.feed_client is None:
        S.feed_client = V
        S.poll_s = float(os.environ.get("GT_LIVE_POLL", S.poll_s))
        S.stale_after_s = float(os.environ.get("GT_STALE_AFTER", S.stale_after_s))
    S.save(True)

    from .store import Store
    A = Auth(S.store or Store(":memory:"), token)
    if os.environ.get("GT_ADMIN_USER") and os.environ.get("GT_ADMIN_PASSWORD") and not A.store.users():
        A.add_user(os.environ["GT_ADMIN_USER"], os.environ["GT_ADMIN_PASSWORD"], "admin")
    MUTATING = ("POST", "PUT", "PATCH", "DELETE")
    cors_origins = [o for o in os.environ.get("GT_CORS", "").split(",") if o]
    extra_hosts = {h.strip().lower() for h in os.environ.get("GT_HOSTS", "").split(",") if h.strip()}

    if "*" in cors_origins and not A.enabled:
        print("WARNING: GT_CORS=* without a password lets any website you visit control this server. "
              "Set GT_TOKEN, or list only the sites you use in GT_CORS.", flush=True)

    def refuse(request: Request, method: str) -> Optional[JSONResponse]:
        """Blocks other websites from driving the API through your browser (cross-site requests and DNS rebinding)."""
        host = request.headers.get("host", "")
        if not A.enabled and host_name(host) not in LOCAL_HOSTS | extra_hosts:
            return err("This server has no password, so it only answers on localhost. Set GT_TOKEN or add users, "
                       "or list this host name in GT_HOSTS.", 403)
        if method in MUTATING:
            origin = request.headers.get("origin")
            if origin and "*" not in cors_origins and origin not in cors_origins and urlparse(origin).netloc.lower() != host.lower():
                return err("Requests from other websites are refused. Add the site to GT_CORS to allow it.", 403)
            if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
                return err("Send JSON (Content-Type: application/json).", 415)
        return None

    async def auth(request: Request, call_next):
        path, method = request.url.path, request.method
        if method == "OPTIONS" or not path.startswith("/api"):
            return await call_next(request)  # the static app files are public; the API is not
        blocked = refuse(request, method)
        if blocked:
            return blocked
        need = needed_role(method, path)
        who = ("local", "admin")  # no token and no users configured: open, which is only safe on localhost
        if need and A.enabled:
            sent = request.headers.get("authorization", "")
            # A password in the address only for the live stream: EventSource cannot send headers, and addresses end up in logs.
            bearer = sent[7:] if sent.lower().startswith("bearer ") else (request.query_params.get("token", "") if path == "/api/stream" else "")
            who = A.identify(bearer)
            if not who:
                return err("Unauthorized", 401)
            if ROLES[who[1]] < ROLES[need]:
                A.audit(who[0], who[1], method, path, 403, "refused: needs " + need)
                return err(f"Your role ({who[1]}) cannot do this. It needs {need}.", 403)
        request.state.user = who
        detail = ""
        if method in MUTATING:
            try:
                raw = await request.body()
                detail = summarize(path, json.loads(raw) if raw else {})
            except Exception:
                detail = ""
        resp = await call_next(request)
        if method in MUTATING:
            S.save(True)
            if path != "/api/login":  # login records its own, with the outcome
                A.audit(who[0], who[1], method, path, resp.status_code, detail)
        return resp

    async def login(request):
        b = await body(request)
        name, pw = str(b.get("name", "")), str(b.get("password", ""))
        client = request.client.host if request.client else ""
        try:
            out = A.login(name, pw, client)
        except PermissionError as e:
            A.audit(name[:32] or "?", "", "POST", "/api/login", 429, "throttled")
            return err(str(e), 429)
        if not out:
            A.audit(name[:32] or "?", "", "POST", "/api/login", 401, "bad name or password")
            return err("Wrong name or password", 401)
        A.audit(out["name"], out["role"], "POST", "/api/login", 200, "signed in")
        return JSONResponse(out)

    async def me(request):
        n, r = request.state.user
        return JSONResponse({"name": n, "role": r})

    async def list_users(request):
        return JSONResponse({"users": A.store.users()})

    async def add_user(request):
        b = await body(request)
        try:
            A.add_user(str(b.get("name", "")), str(b.get("password", "")), str(b.get("role", "")))
        except ValueError as e:
            return err(str(e))
        return JSONResponse({"users": A.store.users()}, status_code=201)

    async def remove_user(request):
        try:
            A.remove_user(request.path_params["name"])
        except KeyError as e:
            return err(str(e).strip("'"), 404)
        except ValueError as e:
            return err(str(e), 409)
        return JSONResponse({"users": A.store.users()})

    async def audit_log(request):
        try:
            n = max(1, min(500, int(request.query_params.get("limit", 100))))
        except ValueError:
            return err("limit must be a number")
        return JSONResponse({"audit": A.store.audit(n)})

    async def health(request):
        return JSONResponse({"ok": True, "exchange": S.ex.name, "live": S.ex.live, "login": bool(A.store.users())})

    async def state(request):
        return JSONResponse(S.state())

    async def candles(request):
        sym = request.query_params.get("symbol", S.symbol)
        if sym not in S.symbols():
            return err("Unknown symbol")
        return JSONResponse({"symbol": sym, "candles": S.candles(sym, int(request.query_params.get("limit", 300)))})

    async def strategies(request):
        return JSONResponse([{"id": s.id, "name": s.name, "blurb": s.blurb, "params": [asdict(p) for p in s.params]} for s in STRATEGIES])

    async def control(request):
        action = request.path_params["action"]
        b = await body(request)
        try:
            if action == "play":
                S.play()
            elif action == "pause":
                S.pause()
            elif action == "step":
                S.step_bar()
            elif action == "speed":
                S.set_speed(int(b.get("speed", 0)))
            elif action == "symbol":
                if b.get("symbol") not in S.symbols():
                    return err("Unknown symbol")
                S.symbol = b["symbol"]
                S.version += 1
            elif action == "reset":
                paper = b.get("paper")
                if paper and not set(paper) <= PAPER_KEYS:
                    return err("Unknown paper setting")
                S.reset(b.get("mode"), b.get("seed"), paper if paper is None else {**asdict(S.ex.cfg), **paper})
            else:
                return err("Unknown action", 404)
        except (ValueError, TypeError) as e:
            return err(str(e))
        return JSONResponse(S.state())

    async def place_order(request):
        b = await body(request)
        try:
            req = OrderRequest(str(b.get("symbol", S.symbol)), str(b.get("side", "")), str(b.get("type", "market")),
                               float(num(b, "qty", 0) or 0), num(b, "price"))
            br = b.get("bracket")
            if br:
                if req.side != "buy" or not isinstance(br, dict):
                    raise ValueError("bracket applies to buy orders only")
                sp, tp = float(num(br, "stop_pct", 0) or 0), float(num(br, "tp_pct", 0) or 0)
                if not (0 <= sp <= 50 and 0 <= tp <= 500):
                    raise ValueError("stop_pct must be 0-50 and tp_pct 0-500")
                req.bracket = {"stop_pct": sp, "tp_pct": tp}
        except ValueError as e:
            return err(str(e))
        ok, res = S.eng.place_manual(req)
        S.version += 1
        if not ok:
            return err(str(res), 422)
        return JSONResponse({"order": asdict(res)}, status_code=201)

    async def stats(request):
        ex = S.ex
        return JSONResponse(compute_stats(ex.fills, S.eng.equity_log, ex.cfg.starting_cash, ex.equity()))

    async def all_fills(request):
        return JSONResponse({"fills": [asdict(f) for f in S.ex.fills]})

    async def cancel_order(request):
        ok = S.ex.cancel(request.path_params["oid"])
        S.version += 1
        return JSONResponse({"cancelled": ok}, status_code=200 if ok else 404)

    async def put_journal(request):
        b = await body(request)
        try:
            S.set_journal(request.path_params["fid"], b.get("tag", ""), b.get("note", ""))
        except KeyError:
            return err("Unknown fill", 404)
        return JSONResponse({"journal": S.journal})

    def bot_fields(b: dict) -> dict:
        out = {}
        if "params" in b:
            if not isinstance(b["params"], dict):
                raise ValueError("params must be an object")
            out["params"] = {k: float(v) for k, v in b["params"].items()}
        for k, lo, hi in (("alloc_pct", 1, 40), ("stop_pct", 0, 30)):
            if k in b:
                v = num(b, k)
                if not lo <= v <= hi:
                    raise ValueError(f"{k} must be between {lo} and {hi}")
                out[k] = v
        return out

    async def add_bot(request):
        b = await body(request)
        try:
            sid, sym = b.get("strategy"), b.get("symbol", S.symbol)
            strategy_by_id(str(sid))
            if sym not in S.symbols():
                return err("Unknown symbol")
            f = bot_fields(b)
        except (KeyError, ValueError) as e:
            return err(str(e).strip("'"))
        bid = S.eng.add_bot(sid, sym, name=b.get("name"), **f)
        S.version += 1
        return JSONResponse({"id": bid}, status_code=201)

    async def patch_bot(request):
        bot = S.eng.bot(request.path_params["bid"])
        if not bot:
            return err("No such bot", 404)
        b = await body(request)
        try:
            f = bot_fields(b)
            if "enabled" in b:
                if b["enabled"] and S.eng.risk.blocked():
                    return err("Resume trading first: " + S.eng.risk.blocked(), 409)
                bot.cfg.enabled = bool(b["enabled"])
            if "params" in f:
                bot.cfg.params.update(f["params"])
            if "alloc_pct" in f:
                bot.cfg.alloc_pct = f["alloc_pct"]
            if "stop_pct" in f:
                bot.cfg.stop_pct = f["stop_pct"]
        except ValueError as e:
            return err(str(e))
        S.version += 1
        return JSONResponse({"ok": True})

    async def delete_bot(request):
        if not S.eng.bot(request.path_params["bid"]):
            return err("No such bot", 404)
        S.eng.remove_bot(request.path_params["bid"])
        S.version += 1
        return JSONResponse({"ok": True})

    async def risk_action(request):
        a = request.path_params["action"]
        if a == "kill":
            S.eng.kill(S.ex.now)
        elif a == "resume":
            S.eng.risk.reset(S.ex.equity())
            S.eng.note(S.ex.now, "info", "Trading resumed. Bots stay stopped until you start them.")
        else:
            return err("Unknown action", 404)
        S.version += 1
        return JSONResponse(S.state()["risk"])

    async def config(request):
        b = await body(request)
        paper, risk = b.get("paper", {}), b.get("risk", {})
        if not set(paper) <= PAPER_KEYS or not set(risk) <= RISK_KEYS:
            return err("Unknown setting")
        try:
            for k, v in paper.items():
                if not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0:
                    raise ValueError(f"{k} must be a non-negative number")
                setattr(S.ex.cfg, k, v)
            for k, v in risk.items():
                if not isinstance(v, (int, float)) or isinstance(v, bool) or v <= 0:
                    raise ValueError(f"{k} must be a positive number")
                setattr(S.eng.risk.limits, k, v)
        except ValueError as e:
            return err(str(e))
        S.version += 1
        return JSONResponse(S.state()["config"] | {"risk": asdict(S.eng.risk.limits)})

    def bt_options(b: dict) -> BacktestOptions:
        sym = b.get("symbol", "BTC-USD")
        if sym not in S.symbols():
            raise ValueError("Unknown symbol")
        strat = strategy_by_id(str(b.get("strategy", "")))
        params = {**default_params(strat), **{k: float(v) for k, v in (b.get("params") or {}).items()}}
        return BacktestOptions(sym, S.rules(sym), S.data[sym], H, strat.id, params, float(b.get("alloc_pct", 20)),
                               float(b.get("stop_pct", 5)), asdict(S.ex.cfg), asdict(S.eng.risk.limits))

    def trim(r: dict) -> dict:
        return {**r, "fills": [asdict(f) for f in r["fills"][-60:]]}

    async def backtest(request):
        b = await body(request)
        try:
            o = bt_options(b)
        except (KeyError, ValueError) as e:
            return err(str(e).strip("'"))
        out = trim(run_backtest(o))
        if b.get("split", True):
            sp = run_split(o)
            out["split"] = {"train": trim(sp["train"]) | {"equity": [], "hold": []}, "test": trim(sp["test"]) | {"equity": [], "hold": []}, "splitAt": sp["splitAt"]}
        return JSONResponse(out)

    async def sweep(request):
        b = await body(request)
        try:
            o = bt_options(b)
        except (KeyError, ValueError) as e:
            return err(str(e).strip("'"))
        return JSONResponse(run_sweep(o))

    async def stream(request):
        async def gen():
            last = -1
            while not await request.is_disconnected():
                if S.version != last:
                    last = S.version
                    yield {"event": "state", "data": json.dumps(S.state())}
                await asyncio.sleep(0.25)
        return EventSourceResponse(gen())

    async def calibration(request):
        try:
            return JSONResponse(S.calibration())
        except ValueError as e:
            return err(str(e), 409)

    async def venue_status(request):
        out = {"venue": "gemini", "readOnly": True, "keysConfigured": V.configured, "tradingEnabled": False}
        if V.configured and request.query_params.get("check") == "1":
            try:
                snap = V.snapshot()
                held = {p.symbol.split("-")[0]: p.qty for p in S.ex.positions.values()}
                held["USD"] = S.ex.cash
                out["account"] = snap
                out["differences"] = reconcile(held, snap["balances"])
                out["note"] = "Differences compare the paper account with your real Gemini balances. They are expected while you only paper trade."
            except Exception as e:
                return err(f"Gemini check failed: {e}", 502)
        return JSONResponse(out)

    static = Path(static_dir or os.environ.get("GT_STATIC", Path(__file__).parent.parent.parent / "dist"))
    STATIC_FILES = {"/": "index.html", "/index.html": "index.html", "/manifest.webmanifest": "manifest.webmanifest",
                    "/sw.js": "sw.js", "/icon-192.png": "icon-192.png", "/icon-512.png": "icon-512.png"}

    async def serve_static(request):
        name = STATIC_FILES.get(request.url.path)
        f = static / name if name else None
        if not f or not f.is_file():
            return Response("Not found", status_code=404)
        headers = {"Cache-Control": "no-cache"}
        if name == "sw.js":
            headers["Service-Worker-Allowed"] = "/"
        return FileResponse(f, headers=headers)

    routes = [
        Route("/api/venue", venue_status),
        Route("/api/calibration", calibration),
        Route("/api/health", health),
        Route("/api/login", login, methods=["POST"]),
        Route("/api/me", me),
        Route("/api/users", list_users),
        Route("/api/users", add_user, methods=["POST"]),
        Route("/api/users/{name}", remove_user, methods=["DELETE"]),
        Route("/api/audit", audit_log),
        Route("/api/state", state),
        Route("/api/stats", stats),
        Route("/api/fills", all_fills),
        Route("/api/candles", candles),
        Route("/api/strategies", strategies),
        Route("/api/control/{action}", control, methods=["POST"]),
        Route("/api/orders", place_order, methods=["POST"]),
        Route("/api/orders/{oid}", cancel_order, methods=["DELETE"]),
        Route("/api/bots", add_bot, methods=["POST"]),
        Route("/api/bots/{bid}", patch_bot, methods=["PATCH"]),
        Route("/api/bots/{bid}", delete_bot, methods=["DELETE"]),
        Route("/api/risk/{action}", risk_action, methods=["POST"]),
        Route("/api/config", config, methods=["PUT"]),
        Route("/api/journal/{fid}", put_journal, methods=["PUT"]),
        Route("/api/backtest", backtest, methods=["POST"]),
        Route("/api/sweep", sweep, methods=["POST"]),
        Route("/api/stream", stream),
    ] + [Route(p, serve_static) for p in STATIC_FILES]
    mw = [Middleware(CORSMiddleware, allow_origins=cors_origins, allow_methods=["*"], allow_headers=["*"])] if cors_origins else []
    # CORS must be outermost so even 401 responses carry its headers.
    app = Starlette(routes=routes, middleware=mw + [Middleware(BaseHTTPMiddleware, dispatch=auth)])
    app.state.session = S
    return app


def _default_app() -> Starlette:
    from .alerts import Notifier
    from .store import Store
    db = os.environ.get("GT_DB")
    return make_app(Session(store=Store(db) if db else None, notifier=Notifier.from_env()))


app = _default_app()
