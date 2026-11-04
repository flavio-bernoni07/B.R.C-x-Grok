"""One sign-off queue for all three rows.

A row asks for a person with `request()`: what is proposed, and why a person is
needed. The person answers with `decide()`, and must write one line on why: that
line is what the Playbook and the Grok agent learn from. Deciding never runs the
action by itself; the row's own service runs it after an approval.

When the CRM screen is built, it lists `pending()` and calls `decide()`.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from core.erp import Erp, now_iso

ROWS = {"order", "shipping", "dispute", "inbox"}


class SignoffError(ValueError):
    pass


def request(
    erp: Erp,
    *,
    row: str,
    kind: str,
    subject_ref: str,
    title: str,
    proposal: dict[str, Any],
    reasons: list[str],
) -> str:
    if row not in ROWS:
        raise SignoffError(f"unknown row {row!r}")
    if not reasons:
        raise SignoffError("a sign-off needs at least one reason a person is asked")
    case_id = erp.next_id("signoff", "SO-")
    erp.insert_signoff(
        {
            "case_id": case_id,
            "row": row,
            "kind": kind,
            "subject_ref": subject_ref,
            "title": title,
            "proposal": proposal,
            "reasons": reasons,
            "status": "pending",
        }
    )
    erp.log("code", "signoff.requested", subject_ref, source_doc=case_id, detail={"kind": kind, "reasons": reasons})
    return case_id


def pending(erp: Erp, row: str | None = None) -> list[dict[str, Any]]:
    return erp.signoffs(status="pending", row=row)


def decide(
    erp: Erp,
    case_id: str,
    *,
    approve: bool,
    by: str,
    reason: str,
    edits: dict[str, Any] | None = None,
) -> dict[str, Any]:
    case = erp.signoff(case_id)
    if not case:
        raise SignoffError(f"no sign-off {case_id}")
    if case["status"] != "pending":
        raise SignoffError(f"{case_id} is already {case['status']}")
    if not by or not by.strip():
        raise SignoffError("say who decides")
    if not reason or not reason.strip():
        raise SignoffError("write one line on why: it is what the Playbook learns from")
    proposal = dict(case["proposal"] or {})
    if edits:
        proposal["edits"] = edits
    status = "approved" if approve else "rejected"
    erp.update_signoff(
        case_id,
        status=status,
        decided_by=by.strip(),
        decision_reason=reason.strip(),
        decided_at=now_iso(),
        proposal=proposal,
    )
    erp.log(f"person:{by.strip()}", f"signoff.{status}", case["subject_ref"], source_doc=case_id,
            detail={"reason": reason.strip(), "edits": edits})
    return erp.signoff(case_id)  # type: ignore[return-value]


def record_past_case(
    playbook_path: Path | str,
    *,
    when: str,
    order_ref: str,
    case_type: str,
    decision: str,
    amount: float | None,
    notes: str,
) -> None:
    """Append a decided case to the Playbook's past-cases table.

    The first real case replaces the "No past cases yet" placeholder row.
    """
    path = Path(playbook_path)
    text = path.read_text(encoding="utf-8")
    clean_notes = re.sub(r"\s+", " ", re.sub(r"[|\n]+", " ", notes)).strip()
    amount_txt = f"{amount:.2f}" if amount is not None else "—"
    row = f"| {when} | {order_ref} | {case_type} | {decision} | {amount_txt} | {clean_notes} |"
    placeholder = re.compile(r"^\| — \| — \| — \| — \| — \| No past cases yet \|\s*$", re.M)
    if placeholder.search(text):
        text = placeholder.sub(row, text, count=1)
    else:
        text = text.rstrip("\n") + "\n" + row + "\n"
    path.write_text(text, encoding="utf-8")
