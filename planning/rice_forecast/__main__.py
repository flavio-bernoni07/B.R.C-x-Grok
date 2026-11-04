"""CLI that prints JSON on stdout. The Rice Agent's tools and the web UI both call it.

    uv run python -m rice_forecast fetch
    uv run python -m rice_forecast varieties
    uv run python -m rice_forecast market
    uv run python -m rice_forecast forecast --variety Carnaroli --horizon 8
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(prog="rice_forecast")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch", help="download all sources into data/raw/")
    sub.add_parser("varieties", help="paddy varieties with enough history")
    sub.add_parser("market", help="latest paddy and world prices")
    fc = sub.add_parser("forecast", help="Prophet baseline and backtest for one variety")
    fc.add_argument("--variety", required=True)
    fc.add_argument("--horizon", type=int, default=8)
    args = parser.parse_args()

    from . import model, sources

    noise = io.StringIO()
    try:
        # Prophet and cmdstan print progress; keep stdout clean JSON.
        with contextlib.redirect_stdout(noise):
            if args.cmd == "fetch":
                result = sources.fetch_all()
            else:
                if not sources.raw_ready():
                    sources.fetch_all()
                if args.cmd == "varieties":
                    result = model.available_varieties()
                elif args.cmd == "market":
                    result = model.market()
                else:
                    result = model.forecast(args.variety, max(1, min(args.horizon, 26)))
    except Exception as exc:  # report as JSON so callers can show it
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
