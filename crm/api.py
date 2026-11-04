"""JSON API for the CRM dashboard, on the Mini ERP file. Standard library only.

    python demo.py --db data/demo.sqlite      # fill a database
    python -m crm.api --db data/demo.sqlite   # serve it on http://127.0.0.1:8765

GET  /api/health
GET  /api/numbers                      KPIs
GET  /api/waiting                      cases for a person, each with its three-line briefing
POST /api/waiting/<case_id>/decide     {"approve": bool, "by": str, "reason": str, "role"?, "manual_edi"?, "lane"?}
GET  /api/orders?status=&retailer=
GET  /api/orders/<order_ref>/trace
POST /api/orders                       {"edi": str}  a new ORDERS message
GET  /api/invoices?status=
GET  /api/claims?status=
GET  /api/receivables?as_of=YYYY-MM-DD
GET  /api/stock
GET  /api/projection?item_code=CAR-1KG&start=YYYY-MM-DD
GET  /api/advice                       this week's buy-or-wait call per paddy variety
GET  /api/digest
POST /api/ask                          {"question": str}  the chatbot
POST /api/inbox                        {"text": str, "source"?: str}
"""

from __future__ import annotations

import argparse
import json
import tempfile
import traceback
from datetime import date
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from core.erp import Erp


class Api:
    def __init__(self, db: str, out_dir: str | None = None) -> None:
        self.db = db
        self.out_dir = out_dir or tempfile.mkdtemp(prefix="brc-crm-")

    def erp(self) -> Erp:
        return Erp(self.db)

    def get(self, path: str, query: dict[str, str]) -> Any:
        from crm.ask import _claims, _invoices, _orders, _stock
        from crm.briefing import brief
        from core.digest import build_digest, kpis

        erp = self.erp()
        parts = [unquote(p) for p in path.strip("/").split("/")]
        if parts == ["api", "health"]:
            return {"ok": True, "db": self.db}
        if parts == ["api", "numbers"]:
            return kpis(erp)
        if parts == ["api", "waiting"]:
            return [brief(erp, s["case_id"]) | {"title": s["title"], "created_at": s["created_at"]}
                    for s in erp.signoffs(status="pending")]
        if parts == ["api", "orders"]:
            return _orders(erp, query.get("status"), query.get("retailer"))
        if len(parts) == 4 and parts[:2] == ["api", "orders"] and parts[3] == "trace":
            from core.trace import chain, render

            c = chain(erp, parts[2])
            return c | {"text": render(c)}
        if parts == ["api", "invoices"]:
            return _invoices(erp, query.get("status"))
        if parts == ["api", "claims"]:
            return _claims(erp, query.get("status"))
        if parts == ["api", "receivables"]:
            from finance.receivables import aging

            return aging(erp, date.fromisoformat(query.get("as_of") or date.today().isoformat()))
        if parts == ["api", "stock"]:
            return _stock(erp)
        if parts == ["api", "projection"]:
            from crm.ask import _projection

            return _projection(erp, query.get("item_code") or "CAR-1KG", query.get("start"))
        if parts == ["api", "advice"]:
            from forecast_quality.advisor import advice

            return advice()
        if parts == ["api", "digest"]:
            return {"markdown": build_digest(erp)}
        raise LookupError(path)

    def post(self, path: str, body: dict[str, Any]) -> Any:
        erp = self.erp()
        parts = [unquote(p) for p in path.strip("/").split("/")]
        if len(parts) == 4 and parts[:2] == ["api", "waiting"] and parts[3] == "decide":
            from crm.actions import decide

            return decide(erp, parts[2], approve=bool(body.get("approve")), by=str(body.get("by") or ""),
                          reason=str(body.get("reason") or ""), role=body.get("role"),
                          manual_edi=body.get("manual_edi"), lane=body.get("lane"), out_dir=self.out_dir)
        if parts == ["api", "orders"]:
            from order.service import receive_order

            return receive_order(erp, str(body["edi"]), source_name=str(body.get("source") or "API"))
        if parts == ["api", "ask"]:
            from crm.ask import ask

            return ask(erp, str(body["question"]))
        if parts == ["api", "inbox"]:
            from crm.inbox import route

            return route(erp, str(body["text"]), source_name=str(body.get("source") or "API"), out_dir=self.out_dir)
        raise LookupError(path)


def make_handler(api: Api) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, payload: Any) -> None:
            data = json.dumps(payload, default=str, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()
            self.wfile.write(data)

        def _run(self, fn) -> None:  # noqa: ANN001
            try:
                self._send(200, fn())  # each call opens its own connection and lets it go
            except LookupError as exc:
                self._send(404, {"error": f"not found: {exc}"})
            except (ValueError, TypeError) as exc:
                self._send(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                self._send(500, {"error": str(exc), "trace": traceback.format_exc(limit=3)})

        def do_OPTIONS(self) -> None:  # noqa: N802
            self._send(204, {})

        def do_GET(self) -> None:  # noqa: N802
            url = urlparse(self.path)
            query = {k: v[0] for k, v in parse_qs(url.query).items()}
            self._run(lambda: api.get(url.path, query))

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            self._run(lambda: api.post(urlparse(self.path).path, body))

        def log_message(self, *args: Any) -> None:  # quiet
            pass

    return Handler


def serve(db: str, host: str = "127.0.0.1", port: int = 8765) -> HTTPServer:
    if not Path(db).exists():
        raise SystemExit(f"{db} does not exist: run python demo.py --db {db} first")
    return HTTPServer((host, port), make_handler(Api(db)))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Serve the CRM JSON API")
    parser.add_argument("--db", default="data/demo.sqlite")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    server = serve(args.db, port=args.port)
    print(f"CRM API on http://127.0.0.1:{args.port}/api/health (database {args.db})")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
