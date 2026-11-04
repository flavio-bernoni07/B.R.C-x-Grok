"""Ask the CRM in plain words (grok-agent-dec.md, CRM use 4): the chatbot.

Grok never touches the database. It picks one of a fixed set of read-only views
and its filters; code checks the choice, runs the view, and Grok writes the answer
from the rows, with every figure taken from them and the records linked. Without
a key, a keyword reader picks the view and code writes a plain answer.
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable

from agent import grok
from agent.checks import unknown_amounts
from core.erp import Erp


def _orders(erp: Erp, status: str | None = None, retailer: str | None = None) -> list[dict[str, Any]]:
    out = []
    for o in erp.orders(status):
        name = (erp.retailer(o["buyer_gln"]) or {}).get("name") or o["buyer_gln"]
        if retailer and retailer.lower() not in (name or "").lower():
            continue
        out.append({"order_ref": o["order_ref"], "retailer": name, "status": o["status"],
                    "lines": [f"{(erp.product(gtin=l['gtin']) or {}).get('item_code', l['gtin'])} x "
                              f"{(l['qty_confirmed'] if l['qty_confirmed'] is not None else l['qty_ordered']):g}"
                              for l in o["lines"]],
                    "short": (o["notes"] or {}).get("fulfilment_gap")})
    return out


def _invoices(erp: Erp, status: str | None = None, order_ref: str | None = None) -> list[dict[str, Any]]:
    return [{"invoice_ref": i["invoice_ref"], "order_ref": i["order_ref"], "status": i["status"], "total": i["total"]}
            for i in erp.invoices(order_ref) if not status or i["status"] == status]


def _claims(erp: Erp, status: str | None = None, order_ref: str | None = None) -> list[dict[str, Any]]:
    return [{"claim_id": c["claim_id"], "order_ref": c["order_ref"], "status": c["status"],
             "type": (c["extraction"] or {}).get("claim_type"), "decision": (c["verdict"] or {}).get("decision"),
             "amount": (c["verdict"] or {}).get("amount")}
            for c in erp.claims() if (not status or c["status"] == status) and (not order_ref or c["order_ref"] == order_ref)]


def _waiting(erp: Erp, row: str | None = None) -> list[dict[str, Any]]:
    return [{"case_id": s["case_id"], "row": s["row"], "title": s["title"], "why": s["reasons"]}
            for s in erp.signoffs(status="pending", row=row)]


def _deductions(erp: Erp) -> list[dict[str, Any]]:
    from finance.receivables import ensure_schema

    ensure_schema(erp)
    return erp._all("SELECT deduction_id, invoice_ref, amount, reason_code, note, status, claim_id FROM deductions "
                    "WHERE status IN ('claim_opened', 'disputed') ORDER BY deduction_id")


def _stock(erp: Erp, item_code: str | None = None) -> list[dict[str, Any]]:
    from core.stock import available_to_promise

    out = []
    for p in erp.products():
        if item_code and p["item_code"].upper() != item_code.upper():
            continue
        a = available_to_promise(erp, p["gtin"])
        out.append({"item_code": p["item_code"], "released": a["released"], "planned": a["planned"], "held": a["held"],
                    "committed": a["committed"], "available_to_promise": a["atp"]})
    return out


def _projection(erp: Erp, item_code: str = "CAR-1KG", start: str | None = None) -> list[dict[str, Any]]:
    from datetime import date

    from planning.demand import production_suggestion, stock_projection

    product = erp.product(item_code=item_code)
    if not product:
        raise KeyError(item_code)
    rows = stock_projection(erp, product["gtin"], start=date.fromisoformat(start) if start else date.today())
    tip = production_suggestion(rows)
    return [r | {"item_code": item_code} for r in rows] + ([{"suggestion": tip}] if tip else [])


def _trace(erp: Erp, order_ref: str) -> list[dict[str, Any]]:
    from core.trace import chain, render

    return [{"order_ref": order_ref, "trace": render(chain(erp, order_ref))}]


def _numbers(erp: Erp) -> list[dict[str, Any]]:
    from core.digest import kpis

    return [kpis(erp)]


VIEWS: dict[str, tuple[Callable[..., list[dict[str, Any]]], set[str], str]] = {
    "orders": (_orders, {"status", "retailer"}, "orders with retailer, status, lines and any short delivery"),
    "invoices": (_invoices, {"status", "order_ref"}, "invoices with status and total"),
    "claims": (_claims, {"status", "order_ref"}, "claims with type, Grok's decision and amount"),
    "waiting": (_waiting, {"row"}, "cases waiting for a person on the sign-off desk"),
    "deductions": (_deductions, set(), "deductions retailers took that we are disputing"),
    "stock": (_stock, {"item_code"}, "stock per product: released, planned, held, committed, available"),
    "trace": (_trace, {"order_ref"}, "every document and decision behind one order"),
    "projection": (_projection, {"item_code", "start"}, "stock per week for the next 8 weeks and a production suggestion"),
    "numbers": (_numbers, set(), "the KPIs: share handled with no person, fill rate, cash, credits"),
}

KEYWORD_VIEWS = [
    ("waiting", ["waiting", "sign-off", "sign off", "approve", "pending", "attesa"]),
    ("deductions", ["deduction", "trattenut", "short pay"]),
    ("stock", ["stock", "available", "magazzino", "disponibil", "hold"]),
    ("claims", ["claim", "reclam", "dispute"]),
    ("invoices", ["invoice", "fattur"]),
    ("trace", ["trace", "why", "history", "chain"]),
    ("projection", ["run out", "projection", "next weeks", "production", "esaur"]),
    ("numbers", ["kpi", "numbers", "fill rate", "how much", "cash", "zero-touch", "no person"]),
    ("orders", ["order", "ordin"]),
]


def plan_by_code(erp: Erp, question: str) -> dict[str, Any]:
    low = question.lower()
    view = next((v for v, words in KEYWORD_VIEWS if any(w in low for w in words)), "numbers")
    filters: dict[str, Any] = {}
    ref = re.search(r"\b(?:ESS|RS|PO|ORD)[-A-Z0-9/]{3,}\b", question, re.I)
    if ref and view in {"trace", "claims", "invoices"}:
        filters["order_ref"] = ref.group(0).upper()
    if view == "trace" and "order_ref" not in filters:
        view = "orders"
    for r in ("Esselunga", "Coop", "Conad", "Carrefour", "Auchan"):
        if r.lower() in low and view == "orders":
            filters["retailer"] = r
    return {"view": view, "filters": filters}


def ask(erp: Erp, question: str, *, caller: Any = None) -> dict[str, Any]:
    live = caller is not None or grok.has_key()
    plan = plan_by_code(erp, question)
    if live:
        catalog = {name: {"filters": sorted(keys), "what": what} for name, (_, keys, what) in VIEWS.items()}
        messages = [
            {"role": "system", "content": (
                "You answer questions about the Riso Scotti back office by choosing ONE read-only view and its "
                f"filters from this catalog: {json.dumps(catalog)}. Return one JSON object: "
                '{"view": name, "filters": {name: value}}.')},
            {"role": "user", "content": question},
        ]

        def check_plan(payload: dict[str, Any]) -> list[str]:
            view = payload.get("view")
            if view not in VIEWS:
                return [f"view must be one of {sorted(VIEWS)}"]
            bad = set(payload.get("filters") or {}) - VIEWS[view][1]
            return [f"{view} has no filters {sorted(bad)}"] if bad else []

        try:
            plan = grok.chat_json(messages, task="crm.ask_plan", validate=check_plan, caller=caller)
            plan["filters"] = plan.get("filters") or {}
        except (grok.GrokAnswerRejected, grok.MissingApiKeyError, RuntimeError):
            live = False
    fn, _, _ = VIEWS[plan["view"]]
    try:
        rows = fn(erp, **plan["filters"])
    except KeyError as exc:
        rows = []
        plan["error"] = f"not found: {exc}"
    facts = json.dumps(rows, default=str)
    answer, by = _code_answer(plan["view"], rows), "code"
    if live:
        messages = [
            {"role": "system", "content": (
                "Answer the question in two or three plain sentences using only these rows. Every figure must come "
                'from the rows. Return one JSON object: {"answer": string}.')},
            {"role": "user", "content": f"Question: {question}\nRows: {facts}"},
        ]

        def check_answer(payload: dict[str, Any]) -> list[str]:
            extra = unknown_amounts(str(payload.get("answer") or ""), facts + " " + question)
            return [f"figures not in the rows: {sorted(extra)}"] if extra else []

        try:
            answer = grok.chat_json(messages, task="crm.ask_answer", validate=check_answer, caller=caller)["answer"]
            by = "grok"
        except (grok.GrokAnswerRejected, grok.MissingApiKeyError, RuntimeError, KeyError):
            pass
    links = sorted({str(r.get(k)) for r in rows for k in ("order_ref", "invoice_ref", "claim_id", "case_id",
                                                          "deduction_id") if r.get(k)})
    return {"question": question, "view": plan["view"], "filters": plan["filters"], "rows": rows,
            "answer": answer, "answered_by": by, "links": links}


def _code_answer(view: str, rows: list[dict[str, Any]]) -> str:
    if not rows:
        return "Nothing matches."
    if view == "waiting":
        return f"{len(rows)} case(s) wait for a person: " + "; ".join(f"{r['case_id']} {r['title']}" for r in rows)
    if view == "numbers":
        k = rows[0]
        share = f"{k['no_person_share']:.0%}" if k["no_person_share"] is not None else "n/a"
        return (f"Handled with no person: {share}. Fill rate: "
                f"{(k['fill_rate'] or 0):.1%}. Invoiced €{k['invoiced']:,.2f}, collected €{k['collected']:,.2f}, "
                f"open €{k['open_receivables']:,.2f}.")
    if view == "trace":
        return rows[0]["trace"]
    return f"{len(rows)} record(s): " + "; ".join(
        ", ".join(f"{k} {v}" for k, v in r.items() if v not in (None, [], "")) for r in rows[:5])
