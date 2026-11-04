"""Every action traceable to its source document: the chain behind one order.

    python -m core.trace data/demo.sqlite ESS-GOLD-001

The chain goes ORDERS -> sign-off -> ORDRSP -> production batches -> truck and
pallets -> DESADV + DDT -> invoice (FatturaPA + INVOIC) -> proof of delivery ->
claims -> verdict -> credit note or reply. `gaps()` lists any output that cannot
be walked back to the document it came from; the demo must have none.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from core.erp import Erp


def _events_for_batches(erp: Erp, batch_ids: set[str]) -> list[dict[str, Any]]:
    names = set(batch_ids) | {b.removesuffix("-HOLD") for b in batch_ids} | {f"{b}-HOLD" for b in batch_ids}
    if not names:
        return []
    marks = ",".join("?" for _ in names)
    return erp._all(f"SELECT * FROM production_events WHERE batch IN ({marks}) ORDER BY event_id", tuple(names))


def chain(erp: Erp, order_ref: str) -> dict[str, Any]:
    order = erp.order(order_ref)
    if not order:
        raise KeyError(f"no order {order_ref}")
    orders_doc = erp.document(order["source_doc"]) if order["source_doc"] else None
    signoffs = [s for s in erp.signoffs() if s["subject_ref"] == order_ref]
    shipments = erp.shipments(order_ref)
    batch_ids = {l["batch"] for s in shipments for l in s["lines"] if l.get("batch")}
    invoices = erp.invoices(order_ref)
    claims = [c for c in erp.claims() if c["order_ref"] == order_ref]
    claim_signoffs = [s for s in erp.signoffs() if s["subject_ref"] in {c["claim_id"] for c in claims}]
    exception_cases: list[dict[str, Any]] = []
    try:
        rows = erp._all("SELECT data FROM si_exception_cases")
        exception_cases = [c for c in (json.loads(r["data"]) for r in rows) if c.get("order_ref") == order_ref]
    except Exception:  # noqa: BLE001 - the shipping tables exist only once a truck was planned
        pass
    payments: list[dict[str, Any]] = []
    deductions: list[dict[str, Any]] = []
    try:
        refs = [i["invoice_ref"] for i in invoices]
        if refs:
            marks = ",".join("?" for _ in refs)
            payments = erp._all(f"SELECT p.payment_id, p.remittance_ref, p.value_date, p.source_doc, l.invoice_ref, "
                                f"l.amount_paid FROM payment_lines l JOIN payments p USING(payment_id) "
                                f"WHERE l.invoice_ref IN ({marks}) ORDER BY p.payment_id", tuple(refs))
            deductions = erp._all(f"SELECT * FROM deductions WHERE invoice_ref IN ({marks}) ORDER BY deduction_id", tuple(refs))
    except Exception:  # noqa: BLE001 - finance tables exist once a remittance was recorded
        pass
    return {
        "payments": payments,
        "deductions": [{k: d[k] for k in ("deduction_id", "amount", "reason_code", "note", "status", "credit_ref", "claim_id")}
                       for d in deductions],
        "order": {"order_ref": order_ref, "status": order["status"], "buyer": order["buyer_gln"],
                  "orders_doc": order["source_doc"], "orders_file": (orders_doc or {}).get("path"),
                  "ordrsp_doc": order["ordrsp_ref"]},
        "signoffs": [{k: s[k] for k in ("case_id", "kind", "status", "decided_by", "decision_reason")} for s in signoffs],
        "production": [{k: e[k] for k in ("event_id", "kind", "batch", "qty", "note")} for e in _events_for_batches(erp, batch_ids)],
        "exception_cases": [{"case_id": c["case_id"], "type": c["type"], "status": c["status"],
                             "approved_by": next((h["actor"] for h in c["history"] if h["event"] == "approve"), None)}
                            for c in exception_cases],
        "shipments": [{"desadv": s["desadv_ref"], "desadv_doc": s["source_doc"], "ddt": s["ddt_ref"],
                       "ship_date": s["ship_date"], "batches": sorted({l["batch"] for l in s["lines"] if l.get("batch")}),
                       "qty": sum(l["qty"] for l in s["lines"]), "notes": s["notes"]} for s in shipments],
        "invoices": [{"invoice": i["invoice_ref"], "desadv": i["desadv_ref"], "fatturapa_doc": i["source_doc"],
                      "status": i["status"], "total": i["total"]} for i in invoices],
        "proofs": [{"doc_id": p["doc_id"], "kind": p["kind"], "summary": p["summary"]} for p in erp.proofs(order_ref)],
        "claims": [{"claim_id": c["claim_id"], "email_doc": c["source_doc"], "status": c["status"],
                    "decision": (c["verdict"] or {}).get("decision"), "amount": (c["verdict"] or {}).get("amount"),
                    "sources": [p["source"]["ref"] for p in (c["verdict"] or {}).get("points", [])],
                    "outputs": [d["doc_id"] + " " + d["kind"] for d in erp.documents(ref=c["claim_id"])]}
                   for c in claims],
        "claim_signoffs": [{k: s[k] for k in ("case_id", "status", "decided_by", "decision_reason")} for s in claim_signoffs],
        "audit": [{k: a[k] for k in ("at", "actor", "action", "source_doc")}
                  for a in erp.audit() if a["subject_ref"] in {order_ref, *(c["claim_id"] for c in claims)}],
    }


def gaps(erp: Erp) -> list[str]:
    """Outputs that cannot be walked back to their source. Empty means fully traceable."""
    problems = []
    for order in erp.orders():
        ref = order["order_ref"]
        if not order["source_doc"] or not erp.document(order["source_doc"]):
            problems.append(f"{ref}: no ORDERS document")
        if order["status"] in {"confirmed", "ready_to_ship", "shipped", "invoiced"} and not order["ordrsp_ref"]:
            problems.append(f"{ref}: confirmed without an ORDRSP")
        for s in erp.shipments(ref):
            if not s["source_doc"] or not erp.document(s["source_doc"]):
                problems.append(f"{s['desadv_ref']}: no DESADV document")
            for line in s["lines"]:
                if not line.get("batch"):
                    problems.append(f"{s['desadv_ref']}: a line has no batch")
        for inv in erp.invoices(ref):
            if not inv["source_doc"] or not erp.document(inv["source_doc"]):
                problems.append(f"{inv['invoice_ref']}: no FatturaPA document")
            if not erp.shipment(inv["desadv_ref"]):
                problems.append(f"{inv['invoice_ref']}: invoices a shipment that does not exist")
    for claim in erp.claims():
        if not erp.document(claim["source_doc"]):
            problems.append(f"{claim['claim_id']}: no claim email")
        if claim["status"] == "closed" and not erp.documents(ref=claim["claim_id"]):
            problems.append(f"{claim['claim_id']}: closed with no outcome document")
    try:
        for pay in erp._all("SELECT * FROM payments"):
            if not erp.document(pay["source_doc"]):
                problems.append(f"{pay['payment_id']}: no remittance document")
    except Exception:  # noqa: BLE001
        pass
    for case in erp.signoffs():
        if case["status"] != "pending" and not case["decision_reason"]:
            problems.append(f"{case['case_id']}: decided without a reason")
    return problems


def render(c: dict[str, Any]) -> str:
    o = c["order"]
    out = [f"Order {o['order_ref']} ({o['status']}), buyer {o['buyer']}",
           f"  ORDERS   {o['orders_doc']} from {o['orders_file']}"]
    for s in c["signoffs"]:
        out.append(f"  sign-off {s['case_id']} {s['kind']}: {s['status']} by {s['decided_by']}: {s['decision_reason']}")
    out.append(f"  ORDRSP   {o['ordrsp_doc']}")
    for e in c["production"]:
        out.append(f"  batch    {e['batch']}: {e['kind']} {e['qty'] or ''} ({e['event_id']}) {e['note'] or ''}".rstrip())
    for x in c["exception_cases"]:
        out.append(f"  case     {x['case_id']} {x['type']}: {x['status']}, approved by {x['approved_by']}")
    for s in c["shipments"]:
        out.append(f"  DESADV   {s['desadv']} ({s['desadv_doc']}), DDT {s['ddt']}, {s['qty']:g} units from "
                   f"{', '.join(s['batches'])}{' | ' + s['notes'] if s['notes'] else ''}")
    for i in c["invoices"]:
        out.append(f"  invoice  {i['invoice']} for {i['desadv']} ({i['fatturapa_doc']}): {i['status']}, €{i['total']:,.2f}")
    for p in c["proofs"]:
        out.append(f"  proof    {p['doc_id']}: {p['summary']}")
    for cl in c["claims"]:
        out.append(f"  claim    {cl['claim_id']} ({cl['email_doc']}): {cl['decision']} {cl['amount']}, "
                   f"sources {', '.join(cl['sources'])}; {cl['status']}; outputs {', '.join(cl['outputs'])}")
    for p in c["payments"]:
        out.append(f"  payment  {p['payment_id']} ({p['source_doc']}, remittance {p['remittance_ref']}, {p['value_date']}): "
                   f"€{p['amount_paid']:,.2f} on {p['invoice_ref']}")
    for d in c["deductions"]:
        out.append(f"  deducted €{d['amount']:,.2f} {d['reason_code']} {d['note']}: {d['status']}"
                   + (f" (credit note {d['credit_ref']})" if d["credit_ref"] else f" (claim {d['claim_id']})"))
    for s in c["claim_signoffs"]:
        out.append(f"  sign-off {s['case_id']}: {s['status']} by {s['decided_by']}: {s['decision_reason']}")
    out.append(f"  {len(c['audit'])} logged actions: "
               + ", ".join(f"{k} {v}" for k, v in _count(a["actor"].split(":")[0] for a in c["audit"]).items()))
    return "\n".join(out)


def _count(items) -> dict[str, int]:
    out: dict[str, int] = {}
    for item in items:
        out[item] = out.get(item, 0) + 1
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Print the document chain behind an order")
    parser.add_argument("db", help="Mini ERP file, e.g. data/demo.sqlite (python demo.py --db data/demo.sqlite)")
    parser.add_argument("order_ref", nargs="?", help="order to trace; omit to check the whole database")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    erp = Erp(args.db)
    if args.order_ref:
        c = chain(erp, args.order_ref)
        sys.stdout.write((json.dumps(c, indent=2, default=str) if args.json else render(c)) + "\n")
    problems = gaps(erp)
    sys.stdout.write("Traceability: every output links back to its source document.\n" if not problems
                     else "Untraceable:\n" + "\n".join(f"- {p}" for p in problems) + "\n")
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
