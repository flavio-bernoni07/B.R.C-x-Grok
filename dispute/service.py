"""Dispute row on the shared Mini ERP.

    handle_claim()     claim email -> Grok reads it -> facts from the Mini ERP (+ the
                       Dispute fixtures) -> per-issue Grok verdict -> combined outcome,
                       or one sign-off pack for ambiguous leftovers
    approve_verdict()  a person signs off the pending issue pack; the outcome is written
                       and a learned rule is activated per approved issue type
    reject_verdict()   the person overturns Grok; nothing is sent, the claim is reopened

Grok decides and explains, code writes every document and amount (dispute-dec.md).
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any, Callable

from agent import learning
from core import signoff
from core.erp import Erp
from dispute.claim_reader import (
    ClaimExtraction,
    ClaimIssue,
    parse_extraction,
    read_claim,
    scoped_extraction,
)
from dispute.mini_erp import MiniErpStore
from dispute.outcome import emit_outcome
from dispute.pull_facts import pull_facts
from dispute.verdict import (
    DEFAULT_PLAYBOOK,
    collect_known_amounts,
    decide_verdict,
    parse_verdict_payload,
)
from shipping.service import export_for_dispute

OUTCOME_KINDS = {
    "td04_xml": "FatturaPA TD04",
    "edi_invoic_381": "INVOIC 381",
    "reject_reply": "claim reply",
    "outcome_json": "outcome",
}


def _store(erp: Erp, include_fixtures: bool) -> MiniErpStore:
    live = MiniErpStore.from_dict(export_for_dispute(erp), label="Mini ERP (core/erp.py)")
    return live.merged_with(MiniErpStore.load()) if include_fixtures else live


def _save_outcome(erp: Erp, claim_id: str, outcome: Any) -> None:
    for key, path in outcome.paths.items():
        body = Path(path).read_text(encoding="utf-8") if Path(path).is_file() else None
        doc_id = erp.add_document(OUTCOME_KINDS.get(key, key), claim_id, body, path=path)
        erp.log("code", f"dispute.{key}", claim_id, source_doc=doc_id)
    erp.set_claim(claim_id, status="closed" if outcome.kind != "awaiting_sign_off" else "awaiting_sign_off",
                  outcome=outcome.to_dict())
    if outcome.kind != "awaiting_sign_off":
        from finance.receivables import on_claim_closed

        on_claim_closed(erp, claim_id, outcome.decision)


COMPLAINT_WINDOW_DAYS = 30  # contract_excerpt.md §4


def _iso_date(value: str | None) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def _types_from_extraction_dict(data: dict[str, Any] | None) -> set[str]:
    if not data:
        return set()
    issues = data.get("issues")
    if isinstance(issues, list) and issues:
        return {
            str(i.get("claim_type"))
            for i in issues
            if isinstance(i, dict) and i.get("claim_type")
        }
    claim_type = data.get("claim_type")
    return {str(claim_type)} if claim_type else set()


def claim_checks(erp: Erp, claim_id: str, extraction: Any, facts: dict[str, Any],
                 received_on: date) -> tuple[dict[str, Any], list[str]]:
    """Facts code can settle on its own: the complaint window and duplicate claims.
    Each failed check is a reason for a person; all of them go to Grok as facts."""
    order = facts.get("order") or {}
    order_ref = order.get("order_ref") or extraction.order_ref
    delivered = [_iso_date(p.get("at")) for p in facts.get("proofs") or [] if p.get("kind") in {"pod", "recadv"}]
    delivered = [d for d in delivered if d]
    shipped = _iso_date((facts.get("desadv") or {}).get("ship_date"))
    delivered_on = min(delivered) if delivered else shipped
    checks: dict[str, Any] = {"received_on": received_on.isoformat(),
                              "delivered_on": delivered_on.isoformat() if delivered_on else None,
                              "complaint_window_days": COMPLAINT_WINDOW_DAYS}
    reasons: list[str] = []
    if delivered_on:
        days = (received_on - delivered_on).days
        checks["days_after_delivery"] = days
        checks["inside_complaint_window"] = days <= COMPLAINT_WINDOW_DAYS
        if days > COMPLAINT_WINDOW_DAYS:
            reasons.append(f"the claim arrived {days} days after delivery; the contract allows "
                           f"{COMPLAINT_WINDOW_DAYS} (§4)")
    our_types = {i.claim_type.value for i in extraction.issues}
    same = []
    for c in erp.claims():
        if c["claim_id"] == claim_id or c["order_ref"] != order_ref:
            continue
        if c["status"] in {"reopened", "received"}:
            continue
        if (c["extraction"] or {}).get("invoice_ref") != extraction.invoice_ref:
            continue
        their_types = _types_from_extraction_dict(c.get("extraction") or {})
        if our_types & their_types:
            same.append(c)
    checks["earlier_claims_same_order_and_type"] = [c["claim_id"] for c in same]
    for c in same:
        reasons.append(f"claim {c['claim_id']} on the same order, invoice and type is already {c['status']}")
    return checks, reasons


def _issue_subject_ref(claim_id: str, issue: ClaimIssue, *, issue_count: int) -> str:
    """Single-issue claims keep claim_id as subject_ref (learning / desk lookups)."""
    if issue_count <= 1:
        return claim_id
    return f"{claim_id}:{issue.claim_type.value}"


def _decide_one_issue(
    erp: Erp,
    claim_id: str,
    full_extraction: ClaimExtraction,
    issue: ClaimIssue,
    facts_dict: dict[str, Any],
    check_reasons: list[str],
    *,
    verdict_caller: Callable[[list[dict[str, str]]], dict[str, Any]] | None,
    issue_count: int,
) -> dict[str, Any]:
    """Run rule match / Grok verdict for one issue. Returns a result pack."""
    scoped = scoped_extraction(full_extraction, issue)
    scoped_dict = scoped.to_dict()
    issue_facts = dict(facts_dict)
    # Prefer issue-scoped claim fields for Playbook / known amounts; keep shared docs.
    issue_facts["claim"] = {**(facts_dict.get("claim") or {}), **scoped_dict, "issues": [issue.to_dict()]}
    signature = learning.dispute_signature(scoped_dict, issue_facts)
    rule = learning.match_rule(erp, signature)
    precedents: list[dict[str, Any]] = []
    rule_skipped: dict[str, Any] | None = None
    if rule:
        applies, failures = learning.reason_still_applies(rule, issue_facts)
        if applies:
            verdict = _verdict_from_rule(rule, scoped, issue_facts)
            reasons = list(check_reasons)
            erp.log(
                "code",
                "dispute.rule_applied",
                claim_id,
                source_doc=rule["rule_id"],
                detail={
                    "issue_type": issue.claim_type.value,
                    "text": rule["text"],
                    "reason": rule.get("approved_reason"),
                    "when": (rule.get("action") or {}).get("when"),
                },
            )
        else:
            rule_skipped = {
                "rule_id": rule["rule_id"],
                "reason": rule.get("approved_reason"),
                "failures": failures,
            }
            issue_facts["rule_skipped"] = rule_skipped
            erp.log(
                "code",
                "dispute.rule_skipped",
                claim_id,
                source_doc=rule["rule_id"],
                detail={**rule_skipped, "issue_type": issue.claim_type.value},
            )
            rule = None
    if not rule:
        precedents = learning.similar(erp, signature)
        issue_facts["precedents"] = precedents
        verdict = decide_verdict(scoped, issue_facts, grok_caller=verdict_caller)
        reasons = verdict.sign_off_reasons + [r for r in check_reasons if r not in verdict.sign_off_reasons]
        if rule_skipped:
            for fail in rule_skipped["failures"]:
                if fail not in reasons:
                    reasons.append(fail)

    verdict_dict = verdict.to_dict()
    verdict_dict["claim"] = scoped_dict
    verdict_dict["sign_off_reasons"] = reasons
    verdict_dict["needs_sign_off"] = bool(reasons)
    erp.log(
        "grok",
        "dispute.verdict",
        claim_id,
        detail={
            "issue_type": issue.claim_type.value,
            "decision": verdict.decision.value,
            "amount": verdict.amount,
            "sign_off_reasons": reasons,
        },
    )
    subject_ref = _issue_subject_ref(claim_id, issue, issue_count=issue_count)
    learning.log_case(
        erp,
        task="dispute.verdict",
        subject_ref=subject_ref,
        signature=signature,
        proposal={"decision": verdict.decision.value, "amount": verdict.amount,
                  "issue_type": issue.claim_type.value},
        confidence=verdict.confidence,
        asked_person=bool(reasons),
        why_person=reasons,
        decided_by=None if reasons else ("rule" if rule else "grok"),
        decision=None if reasons else verdict.decision.value,
        rule_id=rule["rule_id"] if rule else None,
        precedents=[p["case_id"] for p in precedents],
    )
    return {
        "issue": issue.to_dict(),
        "verdict": verdict_dict,
        "reasons": reasons,
        "signature": signature,
        "rule": rule,
        "settled": not bool(reasons),
        "approved_by": (rule.get("approved_by") if rule else None) or None,
        "subject_ref": subject_ref,
    }


def combine_issue_verdicts(
    extraction: ClaimExtraction,
    issue_results: list[dict[str, Any]],
    checks: dict[str, Any],
) -> dict[str, Any]:
    """Merge per-issue verdicts into one parent verdict for outcome / storage."""
    points: list[dict[str, Any]] = []
    credit_amounts: list[float] = []
    decisions: list[str] = []
    summaries: list[str] = []
    confidences: list[float] = []
    amount_notes: list[str] = []
    known_amounts: list[float] = []
    pending_reasons: list[str] = []
    multi = len(issue_results) > 1

    for result in issue_results:
        issue = result["issue"]
        issue_type = str(issue.get("claim_type") or "other")
        verd = result["verdict"]
        decisions.append(str(verd.get("decision") or "reject"))
        confidences.append(float(verd.get("confidence") or 0.0))
        summary = (verd.get("summary") or "").strip()
        if summary:
            summaries.append(f"[{issue_type}] {summary}" if multi else summary)
        for point in verd.get("points") or []:
            if not isinstance(point, dict):
                continue
            text = str(point.get("text") or "").strip()
            if multi and text and not text.lower().startswith(f"[{issue_type}]"):
                text = f"[{issue_type}] {text}"
            points.append({**point, "text": text})
        decision = verd.get("decision")
        amount = verd.get("amount")
        if decision in {"accept", "partial"} and amount is not None:
            credit_amounts.append(float(amount))
        amount_notes.extend(str(n) for n in (verd.get("amount_notes") or []))
        for known in verd.get("known_amounts") or []:
            try:
                known_amounts.append(round(abs(float(known)), 2))
            except (TypeError, ValueError):
                continue
        if not result.get("settled"):
            for reason in result.get("reasons") or []:
                tagged = f"[{issue_type}] {reason}" if multi else reason
                if tagged not in pending_reasons:
                    pending_reasons.append(tagged)

    if decisions and all(d == "accept" for d in decisions):
        parent_decision = "accept"
    elif decisions and all(d == "reject" for d in decisions):
        parent_decision = "reject"
    else:
        parent_decision = "partial"

    total: float | None
    if parent_decision == "reject":
        total = None
    elif credit_amounts:
        total = round(sum(credit_amounts), 2)
    else:
        total = None

    if total is not None:
        known_amounts.append(round(abs(total), 2))
    for part in credit_amounts:
        known_amounts.append(round(abs(part), 2))

    return {
        "decision": parent_decision,
        "amount": total,
        "confidence": min(confidences) if confidences else 0.0,
        "needs_sign_off": bool(pending_reasons),
        "summary": " ".join(summaries) if summaries else "Multi-issue claim.",
        "points": points,
        "playbook_path": next(
            (r["verdict"].get("playbook_path") for r in issue_results if r["verdict"].get("playbook_path")),
            str(DEFAULT_PLAYBOOK),
        ),
        "contract_path": next(
            (r["verdict"].get("contract_path") for r in issue_results if r["verdict"].get("contract_path")),
            None,
        ),
        "amount_notes": amount_notes,
        "known_amounts": sorted(set(known_amounts)),
        "sign_off_reasons": pending_reasons,
        "claim": extraction.to_dict(),
        "checks": checks,
        "issue_verdicts": [
            {
                "issue": r["issue"],
                "decision": r["verdict"].get("decision"),
                "amount": r["verdict"].get("amount"),
                "needs_sign_off": not bool(r.get("settled")),
                "sign_off_reasons": r.get("reasons") or [],
                "summary": r["verdict"].get("summary"),
                "settled": bool(r.get("settled")),
            }
            for r in issue_results
        ],
    }


def handle_claim(
    erp: Erp,
    email_text: str,
    *,
    out_dir: Path | str,
    source_name: str = "claim email",
    read_caller: Callable[[str], dict[str, Any]] | None = None,
    verdict_caller: Callable[[list[dict[str, str]]], dict[str, Any]] | None = None,
    include_fixtures: bool = True,
    issue_date: date | None = None,
    received_on: date | None = None,
    extraction: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """`extraction`: a claim already structured by code from a document (a REMADV deduction).
    It is used as given, claim type included, instead of reading the text.

    Multi-issue emails: facts are pulled once; each issue gets its own verdict; clear
    issues auto-settle; ambiguous leftovers share one desk sign-off; one outcome at the end.
    """
    doc_id = erp.add_document("claim email", None, email_text, path=source_name)
    claim_id = erp.next_id("claim", "CLM-")
    erp.save_claim(claim_id=claim_id, source_doc=doc_id, status="received")
    erp.log("retailer", "dispute.claim_received", claim_id, source_doc=doc_id)

    structured = extraction
    if structured is not None:
        extraction_obj = parse_extraction(structured)
        erp.log("code", "dispute.claim_from_document", claim_id, source_doc=doc_id,
                detail=extraction_obj.to_dict())
    else:
        extraction_obj = read_claim(email_text, grok_caller=read_caller)
        erp.log("grok", "dispute.claim_read", claim_id, source_doc=doc_id,
                detail=extraction_obj.to_dict())

    facts = pull_facts(extraction_obj, store=_store(erp, include_fixtures))
    erp.log("code", "dispute.facts_pulled", claim_id, detail={
        "misses": [m.to_dict() for m in facts.misses],
        "threeway": facts.threeway.summary if facts.threeway else None,
        "reconcile": ({"status": facts.reconcile.status, "causes": facts.reconcile.causes}
                      if facts.reconcile else None),
    })
    facts_dict = facts.to_dict()
    # Re-parse so threeway/reconcile pricing upgrades on issues are visible to the loop.
    extraction_obj = parse_extraction(facts_dict.get("claim") or extraction_obj.to_dict())
    checks, check_reasons = claim_checks(
        erp, claim_id, extraction_obj, facts_dict, received_on or date.today()
    )
    facts_dict["checks"] = checks

    issue_count = len(extraction_obj.issues)
    issue_results = [
        _decide_one_issue(
            erp,
            claim_id,
            extraction_obj,
            issue,
            facts_dict,
            check_reasons,
            verdict_caller=verdict_caller,
            issue_count=issue_count,
        )
        for issue in extraction_obj.issues
    ]

    combined = combine_issue_verdicts(extraction_obj, issue_results, checks)
    erp.set_claim(
        claim_id,
        order_ref=(facts.order or {}).get("order_ref") or extraction_obj.order_ref,
        invoice_ref=(facts.invoice or {}).get("invoice_ref") or extraction_obj.invoice_ref,
        extraction=extraction_obj.to_dict(),
        verdict=combined,
    )

    pending = [r for r in issue_results if not r["settled"]]
    n_issues = len(issue_results)
    if pending:
        pending_types = ", ".join(r["issue"]["claim_type"] for r in pending)
        title = (
            f"Claim {claim_id} on {extraction_obj.order_ref or 'an unknown order'}: "
            f"{n_issues} issue(s), person needed for {pending_types}"
        )
        case_id = signoff.request(
            erp,
            row="dispute",
            kind="verdict",
            subject_ref=claim_id,
            title=title,
            proposal={
                "verdict": combined,
                "facts": facts_dict,
                "out_dir": str(out_dir),
                "pending_issues": pending,
                "auto_issues": [r for r in issue_results if r["settled"]],
            },
            reasons=combined["sign_off_reasons"],
        )
        erp.set_claim(claim_id, status="awaiting_sign_off")
        return {
            "status": "awaiting_person",
            "claim_id": claim_id,
            "case_id": case_id,
            "verdict": combined,
        }

    approved = next((r.get("approved_by") for r in issue_results if r.get("approved_by")), None)
    outcome = emit_outcome(
        combined, facts=facts_dict, out_dir=out_dir, issue_date=issue_date, approved_by=approved
    )
    _save_outcome(erp, claim_id, outcome)
    return {
        "status": "closed",
        "claim_id": claim_id,
        "verdict": combined,
        "outcome": outcome.to_dict(),
    }


def _verdict_from_rule(rule: dict[str, Any], extraction: Any, facts: dict[str, Any]):
    """An approved rule decides: no Grok call. Amounts still come only from the documents."""
    decision = rule["action"]["decision"]
    amount = extraction.amount if decision in {"accept", "partial"} else None
    who = f"approved by {rule['approved_by']}" if rule.get("approved_by") else "approved"
    support = rule.get("support") or []
    why = rule.get("approved_reason") or (rule.get("action") or {}).get("when", {}).get("reason") or ""
    points = [{"text": rule["text"], "amount": amount,
               "source": {"kind": "playbook", "ref": rule["rule_id"],
                          "detail": f"{who}" + (f"; because: {why}" if why else "")}}]
    for proof in facts.get("proofs") or []:
        points.append({"text": proof.get("summary") or proof.get("kind"), "amount": None,
                       "source": {"kind": proof.get("kind") or "other", "ref": proof.get("ref") or proof.get("doc_id"),
                                  "detail": proof.get("doc_id") or ""}})
    learned = f", learned from {', '.join(support)}" if support else ""
    because = f" Because: {why}." if why else ""
    payload = {"decision": decision, "amount": amount, "confidence": 1.0, "needs_sign_off": False,
               "summary": f"Decided by rule {rule['rule_id']} ({who}{learned}).{because}",
               "points": points}
    return parse_verdict_payload(payload, known_amounts=collect_known_amounts(extraction, facts),
                                 playbook_path=str(DEFAULT_PLAYBOOK), claim=extraction, facts=facts)


def approve_verdict(erp: Erp, case_id: str, *, by: str, reason: str,
                    playbook_path: Path | str = DEFAULT_PLAYBOOK, issue_date: date | None = None) -> dict[str, Any]:
    case = erp.signoff(case_id)
    if not case or case["row"] != "dispute":
        raise ValueError(f"{case_id} is not a dispute sign-off")
    signoff.decide(erp, case_id, approve=True, by=by, reason=reason)
    proposal = case["proposal"]
    facts = proposal.get("facts") or {}
    pending = list(proposal.get("pending_issues") or [])
    auto = list(proposal.get("auto_issues") or [])

    if pending:
        # Person approved Grok's proposed decisions for every leftover issue.
        for item in pending:
            item["settled"] = True
            item["approved_by"] = by
            verd = item.get("verdict") or {}
            verd["needs_sign_off"] = False
            verd["sign_off_reasons"] = []
            item["reasons"] = []
            item["verdict"] = verd
        issue_results = auto + pending
        claim_payload = (proposal.get("verdict") or {}).get("claim") or {}
        extraction_obj = parse_extraction(claim_payload)
        checks = (proposal.get("verdict") or {}).get("checks") or facts.get("checks") or {}
        combined = combine_issue_verdicts(extraction_obj, issue_results, checks)
    else:
        # Legacy single-verdict sign-off (no pending_issues pack).
        combined = proposal["verdict"]
        pending = [{
            "issue": {
                "claim_type": (combined.get("claim") or {}).get("claim_type") or "other",
            },
            "verdict": combined,
            "signature": None,
            "settled": True,
        }]

    outcome = emit_outcome(
        combined, facts=facts, out_dir=proposal["out_dir"], issue_date=issue_date, approved_by=by
    )
    _save_outcome(erp, case["subject_ref"], outcome)
    erp.set_claim(case["subject_ref"], verdict=combined)

    claim = combined.get("claim") or {}
    parent_decision = combined.get("decision")
    learned_ids: list[str] = []
    for item in pending:
        issue = item.get("issue") or {}
        verd = item.get("verdict") or {}
        signature = item.get("signature")
        if not signature:
            scoped_claim = {
                **claim,
                "claim_type": issue.get("claim_type") or claim.get("claim_type") or "other",
                "product": issue.get("product", claim.get("product")),
                "quantity": issue.get("quantity", claim.get("quantity")),
                "amount": issue.get("amount", claim.get("amount")),
            }
            signature = learning.dispute_signature(scoped_claim, facts)
        subject = item.get("subject_ref") or case["subject_ref"]
        learning.record_person_decision(
            erp,
            subject,
            decided_by=by,
            decision=verd.get("decision") or parent_decision,
            reason=reason,
            overturned=False,
        )
        agent_case = learning.case_for(erp, subject) or learning.case_for(erp, case["subject_ref"])
        rule_id = learning.activate_from_person(
            erp,
            signature,
            verd.get("decision") or parent_decision,
            by=by,
            reason=reason,
            support_case_id=(agent_case or {}).get("case_id"),
            facts=facts,
        )
        if rule_id:
            learned_ids.append(rule_id)
        signoff.record_past_case(
            playbook_path,
            when=(issue_date or date.today()).isoformat(),
            order_ref=claim.get("order_ref") or "—",
            case_type=issue.get("claim_type") or claim.get("claim_type") or "other",
            decision=f"{verd.get('decision') or parent_decision} (approved)",
            amount=verd.get("amount", combined.get("amount")),
            notes=f"{by}: {reason}",
        )

    return {
        "status": "closed",
        "claim_id": case["subject_ref"],
        "outcome": outcome.to_dict(),
        "learned_rule_id": learned_ids[0] if learned_ids else None,
        "learned_rule_ids": learned_ids,
        "verdict": combined,
    }


def reject_verdict(erp: Erp, case_id: str, *, by: str, reason: str,
                   playbook_path: Path | str = DEFAULT_PLAYBOOK) -> dict[str, Any]:
    case = erp.signoff(case_id)
    if not case or case["row"] != "dispute":
        raise ValueError(f"{case_id} is not a dispute sign-off")
    signoff.decide(erp, case_id, approve=False, by=by, reason=reason)
    verdict = case["proposal"]["verdict"]
    claim = verdict.get("claim") or {}
    erp.set_claim(case["subject_ref"], status="reopened")
    learning.record_person_decision(erp, case["subject_ref"], decided_by=by, decision=f"not {verdict['decision']}",
                                    reason=reason, overturned=True)
    signoff.record_past_case(playbook_path, when=date.today().isoformat(), order_ref=claim.get("order_ref") or "—",
                             case_type=claim.get("claim_type") or "other",
                             decision=f"{verdict['decision']} overturned", amount=verdict.get("amount"),
                             notes=f"{by}: {reason}")
    return {"status": "reopened", "claim_id": case["subject_ref"]}


def offline_callers(path: Path | str) -> tuple[Callable, Callable]:
    """Recorded Grok answers (for a demo with the network off). Same code checks apply."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return (lambda _text: dict(data["read_claim"])), (lambda _messages: json.loads(json.dumps(data["verdict"])))


def main(argv: list[str] | None = None) -> int:
    """Jury / Mini-ERP claim runner: no fixture catalog merge unless --with-fixtures."""
    import argparse
    import sys

    parser = argparse.ArgumentParser(
        description=(
            "Run one claim on the shared Mini ERP (Order→Shipping docs already there). "
            "Default: include_fixtures=False so lookup misses are real."
        )
    )
    parser.add_argument("--db", required=True, help="Mini ERP SQLite (e.g. data/demo.sqlite)")
    parser.add_argument("claim", type=Path, help="Claim email / remittance text file")
    parser.add_argument("--out-dir", type=Path, required=True, help="Where to write TD04 / reply")
    parser.add_argument(
        "--with-fixtures",
        action="store_true",
        help="Also merge data/disputes/erp/catalog.json (demo convenience; off for jury)",
    )
    parser.add_argument(
        "--offline",
        type=Path,
        default=None,
        help="JSON with recorded read_claim + verdict (skips live Grok)",
    )
    parser.add_argument("--issue-date", default=None, help="ISO date for documents")
    parser.add_argument(
        "--extraction",
        type=Path,
        default=None,
        help="Skip claim_reader: use this extraction JSON (and optional --verdict)",
    )
    parser.add_argument(
        "--verdict",
        type=Path,
        default=None,
        help="With --extraction: recorded verdict JSON for offline path",
    )
    args = parser.parse_args(argv)

    if not args.claim.is_file():
        print(f"error: claim file not found: {args.claim}", file=sys.stderr)
        return 2

    erp = Erp(args.db)
    email = args.claim.read_text(encoding="utf-8")
    issue = date.fromisoformat(args.issue_date) if args.issue_date else None
    read_c = verdict_c = None
    extraction = None

    if args.offline:
        read_c, verdict_c = offline_callers(args.offline)
    if args.extraction:
        extraction = json.loads(args.extraction.read_text(encoding="utf-8"))
    if args.verdict:
        verd_payload = json.loads(args.verdict.read_text(encoding="utf-8"))
        for key in ("claim", "playbook_path", "contract_path", "amount_notes", "known_amounts"):
            verd_payload.pop(key, None)
        verdict_c = lambda _m, v=verd_payload: json.loads(json.dumps(v))

    result = handle_claim(
        erp,
        email,
        out_dir=args.out_dir,
        source_name=str(args.claim),
        read_caller=read_c,
        verdict_caller=verdict_c,
        include_fixtures=bool(args.with_fixtures),
        issue_date=issue,
        extraction=extraction,
    )

    claim_row = erp.claim(result["claim_id"]) or {}
    verd = claim_row.get("verdict") or result.get("verdict") or {}
    summary: dict[str, Any] = {
        "status": result["status"],
        "claim_id": result["claim_id"],
        "case_id": result.get("case_id"),
        "include_fixtures": bool(args.with_fixtures),
        "decision": verd.get("decision"),
        "amount": verd.get("amount"),
        "outcome": (result.get("outcome") or {}).get("kind"),
        "sign_off_reasons": verd.get("sign_off_reasons"),
        "issue_verdicts": verd.get("issue_verdicts"),
    }
    if result.get("status") == "awaiting_person":
        case = erp.signoff(result["case_id"]) or {}
        facts = (case.get("proposal") or {}).get("facts") or {}
        summary["misses"] = facts.get("misses")
        summary["reconcile"] = facts.get("reconcile")
        if facts.get("misses") and not args.with_fixtures:
            print(
                "warning: Mini ERP lookup misses (no fixture merge): "
                + json.dumps(facts["misses"], ensure_ascii=False),
                file=sys.stderr,
            )
        summary["hint"] = (
            f"Person needed. Approve with: python -m dispute.desk --db {args.db} "
            f"approve {result['case_id']} --by NAME --reason '…'"
        )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
