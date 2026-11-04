"""Weekly digest for the accountant and managers, written from the Mini ERP.

    python -m core.digest data/erp.sqlite
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from typing import Any

from core.erp import Erp


def kpis(erp: Erp) -> dict[str, Any]:
    """The numbers Riso Scotti watches: people's time, service level, cash."""
    from finance.receivables import balance, ensure_schema

    ensure_schema(erp)
    decided = {s["subject_ref"]: s for s in erp.signoffs()}
    orders = [o for o in erp.orders() if o["status"] not in {"pending_price", "pending_manual_edi", "awaiting_confirmation"}]
    invoices = [i for i in erp.invoices() if i["status"] == "sent"]
    claims = [c for c in erp.claims() if c["status"] == "closed"]
    held = {s["subject_ref"] for s in erp.signoffs(row="shipping")}
    deductions = erp._all("SELECT * FROM deductions")
    touch = {
        "orders": (sum(1 for o in orders if o["order_ref"] not in decided), len(orders)),
        "invoices": (sum(1 for i in invoices if i["order_ref"] not in held), len(invoices)),
        "claims": (sum(1 for c in claims if c["claim_id"] not in decided), len(claims)),
        "deductions": (sum(1 for d in deductions if d["status"] == "matched_credit"), len(deductions)),
    }
    done = sum(n for n, _ in touch.values())
    total = sum(t for _, t in touch.values())
    confirmed = shipped = 0.0
    for o in erp.orders():
        if not erp.shipments(o["order_ref"]):
            continue
        confirmed += sum((l["qty_confirmed"] if l["qty_confirmed"] is not None else l["qty_ordered"]) or 0 for l in o["lines"])
        shipped += sum(l["qty"] for s in erp.shipments(o["order_ref"]) for l in s["lines"])
    balances = [balance(erp, i["invoice_ref"]) for i in invoices]
    credit_total = sum(float((c.get("outcome") or {}).get("amount") or 0) for c in erp.claims()
                       if (c.get("outcome") or {}).get("kind") == "credit_note")
    return {
        "no_person": {k: {"done": n, "of": t} for k, (n, t) in touch.items()},
        "no_person_share": round(done / total, 3) if total else None,
        "fill_rate": round(shipped / confirmed, 4) if confirmed else None,
        "invoiced": round(sum(i["total"] for i in invoices), 2),
        "collected": round(sum(b["paid"] for b in balances), 2),
        "open_receivables": round(sum(b["open"] for b in balances), 2),
        "deductions_open": round(sum(d["amount"] for d in deductions if d["status"] in {"claim_opened", "disputed"}), 2),
        "credit_notes": round(credit_total, 2),
        "waiting_for_a_person": len(erp.signoffs(status="pending")),
    }


def build_digest(erp: Erp, *, title: str = "Weekly digest") -> str:
    orders = erp.orders()
    invoices = erp.invoices()
    claims = erp.claims()
    signoffs = erp.signoffs()
    credit_docs = erp.documents(kind="FatturaPA TD04")

    sent = [i for i in invoices if i["status"] == "sent"]
    held = [i for i in invoices if i["status"] != "sent"]
    net = sum(i["total_net"] or 0 for i in sent)
    gross = sum(i["total"] or 0 for i in sent)
    status_count = Counter(o["status"] for o in orders)
    pending = [s for s in signoffs if s["status"] == "pending"]
    decided = [s for s in signoffs if s["status"] != "pending"]

    lines = [f"# {title}", ""]
    lines.append(f"- Orders received: {len(orders)} ({', '.join(f'{k} {v}' for k, v in sorted(status_count.items())) or 'none'})")
    lines.append(f"- Invoices sent: {len(sent)}, net €{net:,.2f}, with VAT €{gross:,.2f}")
    if held:
        lines.append(f"- Invoices held back: {len(held)} ({', '.join(i['invoice_ref'] for i in held)})")
    lines.append(f"- Claims: {len(claims)}; credit notes issued: {len(credit_docs)}")
    lines.append(f"- Sign-offs: {len(decided)} decided, {len(pending)} waiting")
    k = kpis(erp)
    lines.append("")
    lines.append("## The numbers")
    share = f"{k['no_person_share']:.0%}" if k["no_person_share"] is not None else "n/a"
    parts = ", ".join(f"{name} {v['done']}/{v['of']}" for name, v in k["no_person"].items())
    lines.append(f"- Handled with no person: {share} ({parts})")
    if k["fill_rate"] is not None:
        lines.append(f"- Fill rate: {k['fill_rate']:.1%} of confirmed quantity shipped")
    lines.append(f"- Invoiced €{k['invoiced']:,.2f}, collected €{k['collected']:,.2f}, still open €{k['open_receivables']:,.2f}")
    lines.append(f"- Credit notes €{k['credit_notes']:,.2f}; deductions being disputed €{k['deductions_open']:,.2f}")
    if pending:
        lines.append("")
        lines.append("## Waiting for a person")
        for case in pending:
            lines.append(f"- {case['case_id']} ({case['row']}): {case['title']}. Why: {'; '.join(case['reasons'] or [])}")
    if decided:
        lines.append("")
        lines.append("## Decided by a person")
        for case in decided:
            lines.append(f"- {case['case_id']} ({case['row']}): {case['status']} by {case['decided_by']}: {case['decision_reason']}")
    gaps = [o for o in orders if (o.get("notes") or {}).get("fulfilment_gap")]
    if gaps:
        lines.append("")
        lines.append("## Short deliveries to follow up")
        for order in gaps:
            lines.append(f"- {order['order_ref']}: {order['notes']['fulfilment_gap']}")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Print the weekly digest from a Mini ERP database")
    parser.add_argument("db", help="path to the SQLite file, e.g. data/erp.sqlite")
    args = parser.parse_args(argv)
    sys.stdout.write(build_digest(Erp(args.db)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
