"""Build a longer candle history than the 60 days bundled with the app.

Two sources:
  import  OHLCV CSV files from any exchange or data site (columns found by name, time as seconds, ms or ISO text)
  fetch   Gemini's public candles (about the last 60 days per call). Run it on a schedule and each run adds to the file,
          so the history grows over time.

The app needs every symbol on the same hourly timestamps, so `align` keeps only times present for all symbols.
Output matches data/candles.json and is picked up with GT_DATA=path.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

HOUR = 3600000
NAMES = {
    "t": ("time", "timestamp", "date", "unix", "open time", "open_time", "t"),
    "o": ("open", "o"), "h": ("high", "h"), "l": ("low", "l"), "c": ("close", "c"),
    "v": ("volume", "vol", "volume btc", "volume (base)", "base volume", "v"),
}


def parse_time(x: str) -> int:
    x = x.strip()
    try:
        n = float(x)
        return int(n if n > 1e11 else n * 1000)  # milliseconds vs seconds
    except ValueError:
        d = datetime.fromisoformat(x.replace("Z", "+00:00").replace(" UTC", ""))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return int(d.timestamp() * 1000)


def from_csv(path: str) -> list[list[float]]:
    with open(path, newline="") as f:
        lines = [ln for ln in f if ln.strip() and not ln.startswith("#") and not ln.lower().startswith("http")]
    rd = csv.DictReader(lines)
    cols = {k.strip().lower(): k for k in (rd.fieldnames or [])}
    pick = {}
    for key, options in NAMES.items():
        hit = next((cols[o] for o in options if o in cols), None)
        if hit is None and key != "v":
            raise ValueError(f"No column for {key!r}. Found: {list(cols)}")
        pick[key] = hit
    rows = []
    for r in rd:
        rows.append([parse_time(r[pick["t"]]), float(r[pick["o"]]), float(r[pick["h"]]), float(r[pick["l"]]),
                     float(r[pick["c"]]), float(r[pick["v"]]) if pick["v"] else 0.0])
    return sorted(rows, key=lambda r: r[0])


def merge(old: list[list[float]], new: list[list[float]]) -> list[list[float]]:
    """Newer data wins on a repeated timestamp."""
    by = {int(r[0]): r for r in old}
    by.update({int(r[0]): r for r in new})
    return [by[t] for t in sorted(by)]


def validate(rows: list[list[float]], step: int = HOUR) -> dict:
    bad = [int(r[0]) for r in rows if not (r[2] >= max(r[1], r[4]) - 1e-9 and r[3] <= min(r[1], r[4]) + 1e-9 and r[3] > 0)]
    gaps = [(int(a[0]), int(b[0])) for a, b in zip(rows, rows[1:]) if b[0] - a[0] != step]
    return {"count": len(rows), "from": int(rows[0][0]) if rows else None, "to": int(rows[-1][0]) if rows else None,
            "badCandles": bad, "gaps": gaps, "days": len(rows) * step / 86400000}


def align(series: dict[str, list[list[float]]]) -> dict[str, list[list[float]]]:
    common = set.intersection(*(set(int(r[0]) for r in rows) for rows in series.values())) if series else set()
    return {s: [r for r in rows if int(r[0]) in common] for s, rows in series.items()}


def read(path: str) -> dict[str, list[list[float]]]:
    p = Path(path)
    return json.loads(p.read_text())["candles"] if p.exists() else {}


def write(path: str, series: dict[str, list[list[float]]], source: str) -> None:
    Path(path).write_text(json.dumps({"tf": "1hr", "source": source, "candles": series}, separators=(",", ":")))


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m gtrader.history")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("import", help="add an OHLCV CSV for one symbol")
    a.add_argument("symbol"), a.add_argument("csv"), a.add_argument("--out", default="data/candles.json")
    f = sub.add_parser("fetch", help="add Gemini's latest public hourly candles")
    f.add_argument("--out", default="data/candles.json"), f.add_argument("--symbols", default="BTC-USD,ETH-USD,SOL-USD")
    c = sub.add_parser("check", help="report gaps and bad candles")
    c.add_argument("file")
    args = ap.parse_args(argv)

    if args.cmd == "check":
        for sym, rows in read(args.file).items():
            v = validate(rows)
            print(f"{sym}: {v['count']} candles, {v['days']:.0f} days, {len(v['gaps'])} gaps, {len(v['badCandles'])} bad")
        return 0
    data = read(args.out)
    if args.cmd == "import":
        data[args.symbol] = merge(data.get(args.symbol, []), from_csv(args.csv))
        src = "imported CSV"
    else:
        from .gemini import GeminiReadOnly
        g = GeminiReadOnly()
        for sym in args.symbols.split(","):
            data[sym] = merge(data.get(sym, []), g.candles(sym, "1hr"))
        src = "Gemini public candles"
    aligned = align(data)
    dropped = {s: len(data[s]) - len(aligned[s]) for s in data}
    write(args.out, aligned, src)
    for sym, rows in aligned.items():
        v = validate(rows)
        print(f"{sym}: {v['count']} candles, {v['days']:.0f} days, {len(v['gaps'])} gaps, {len(v['badCandles'])} bad (dropped {dropped[sym]} unaligned)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
