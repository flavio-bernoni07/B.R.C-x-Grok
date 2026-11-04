"""One `decide()` for the sign-off desk, whatever the row.

The CRM screen lists `core.signoff.pending()` and calls this. It records the
person's decision and then runs what the decision means in that row:

- order confirm      -> ORDRSP, then the hand-over to Shipping
- order price / EDI  -> a manual EDI goes back to Parse, otherwise the order is parked
- order stock short -> a revised order goes back to Parse, otherwise the desk follows up
- shipping case      -> the employee's decision, then the approved action runs once
- shipping invoice   -> approved: the held invoice goes out as is; rejected: it stays held
- dispute verdict    -> the credit note or reply is written, the Playbook learns
- inbox message      -> the message goes to the lane the person picked
- quality lot check  -> approved: the lot is used as reported and its hold released; rejected: refused
"""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

from core import signoff
from core.erp import Erp


def decide(
    erp: Erp,
    case_id: str,
    *,
    approve: bool,
    by: str,
    reason: str,
    role: str | None = None,
    manual_edi: str | None = None,
    lane: str | None = None,
    playbook_path: Path | str | None = None,
    out_dir: Path | str | None = None,
) -> dict[str, Any]:
    case = erp.signoff(case_id)
    if not case:
        raise KeyError(case_id)
    if case["status"] != "pending":
        raise signoff.SignoffError(f"{case_id} is already {case['status']}")
    row, kind = case["row"], case["kind"]

    if row == "order" and kind == "confirm":
        from order.service import confirm_order, reject_order
        from shipping.service import ingest_confirmed_order

        if not approve:
            reject_order(erp, case_id, by=by, reason=reason)
            return {"case_id": case_id, "done": "order rejected"}
        handoff = confirm_order(erp, case_id, by=by, reason=reason)
        ingest_confirmed_order(erp, handoff)
        return {"case_id": case_id, "done": "ORDRSP sent, order handed to Shipping", "ordrsp": handoff["ordrsp_ref"]}

    if row == "order" and kind == "stock_short":
        from order.service import receive_order

        signoff.decide(erp, case_id, approve=approve, by=by, reason=reason)
        if approve and manual_edi:
            return {"case_id": case_id, "done": "revised order parsed again",
                    "result": receive_order(erp, manual_edi, source_name=f"revised order for {case['subject_ref']}")}
        return {"case_id": case_id, "done": "noted: the order desk agrees a new quantity or date with the retailer"}

    if row == "order":
        from order.service import reject_order, resolve_price_case

        if not approve:
            reject_order(erp, case_id, by=by, reason=reason)
            return {"case_id": case_id, "done": "order rejected"}
        result = resolve_price_case(erp, case_id, by=by, reason=reason, manual_edi=manual_edi)
        return {"case_id": case_id, "done": "manual EDI parsed again" if manual_edi else "order parked as pending",
                "result": result}

    if row == "shipping" and kind == "exception_case":
        from shipping import cases

        exc_id = case["proposal"]["exception_case"]
        exc = cases.view_exception_case(erp, exc_id)
        cases.decide_resolution(erp, exc_id, employee_id=by, role=role or exc["role"],
                                decision="approve" if approve else "reject", reason=reason)
        if not approve:
            return {"case_id": case_id, "done": "proposal rejected, case open again"}
        done = cases.execute_resolution(erp, exc_id)
        return {"case_id": case_id, "done": "approved action ran once", "result": done,
                "recheck": cases.recheck_exception_case(erp, exc_id)}

    if row == "shipping" and kind == "reconcile":
        signoff.decide(erp, case_id, approve=approve, by=by, reason=reason)
        if not approve:
            return {"case_id": case_id, "done": "invoice stays held for correction"}
        for ref in case["proposal"].get("invoices") or []:
            erp.set_invoice_status(ref, "sent")
            erp.log(f"person:{by}", "shipping.invoice_sent_after_review", case["subject_ref"], source_doc=case_id)
        erp.set_order(case["subject_ref"], status="invoiced")
        return {"case_id": case_id, "done": "invoice sent after review"}

    if row == "dispute":
        from dispute.service import approve_verdict, reject_verdict
        from dispute.verdict import DEFAULT_PLAYBOOK

        book = playbook_path or DEFAULT_PLAYBOOK
        if approve:
            res = approve_verdict(erp, case_id, by=by, reason=reason, playbook_path=book, issue_date=date.today())
            return {"case_id": case_id, "done": f"{res['outcome']['kind']} written", "result": res}
        res = reject_verdict(erp, case_id, by=by, reason=reason, playbook_path=book)
        return {"case_id": case_id, "done": "verdict overturned, claim reopened", "result": res}

    if row == "quality":
        from core.stock import record_event

        signoff.decide(erp, case_id, approve=approve, by=by, reason=reason)
        batch = case["proposal"].get("batch")
        report = case["proposal"]["report"]
        if approve:
            if batch:
                record_event(erp, "hold_released", batch=batch, note=f"lab confirmed lot {report['lot']}: {reason}")
            return {"case_id": case_id, "done": f"lot accepted: {report['destination']}, "
                                                f"price cut €{report['price_cut_eur_t']:.2f}/t"}
        return {"case_id": case_id, "done": "lot refused: it stays on hold"}

    if row == "inbox":
        from crm.inbox import dispatch

        signoff.decide(erp, case_id, approve=approve, by=by, reason=reason, edits={"lane": lane} if lane else None)
        if not approve:
            return {"case_id": case_id, "done": "message filed, no action"}
        chosen = lane or case["proposal"].get("lane")
        return {"case_id": case_id, "done": f"sent to {chosen}",
                "result": dispatch(erp, case["proposal"]["message"], chosen, refs=case["proposal"].get("refs") or {},
                                   out_dir=out_dir)}

    raise ValueError(f"no action for row {row!r}, kind {kind!r}")
