"""Weekly digest for the accountant and managers, written from the Mini ERP.

    python -m core.digest data/erp.sqlite
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter

from core.erp import Erp


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
