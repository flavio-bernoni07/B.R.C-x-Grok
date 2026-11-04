"""Dispute row on the shared Mini ERP.

    handle_claim()     claim email -> Grok reads it -> facts from the Mini ERP (+ the
                       Dispute fixtures) -> Grok verdict -> outcome, or a sign-off
    approve_verdict()  a person signs off an ambiguous verdict; the outcome is written
                       and the case is added to the Playbook's past cases
    reject_verdict()   the person overturns Grok; nothing is sent, the claim is reopened

Grok decides and explains, code writes every document and amount (dispute-dec.md).
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import date
from pathlib import Path
from typing import Any, Callable

from agent import learning
from core import signoff
from core.erp import Erp
from dispute.claim_reader import ClaimType, parse_extraction, read_claim
from dispute.mini_erp import MiniErpStore
from dispute.outcome import emit_outcome
from dispute.pull_facts import pull_facts
from dispute.verdict import DEFAULT_PLAYBOOK, collect_known_amounts, decide_verdict, parse_verdict_payload
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
    same = [c for c in erp.claims() if c["claim_id"] != claim_id and c["order_ref"] == order_ref
            and c["status"] not in {"reopened", "received"}
            and (c["extraction"] or {}).get("claim_type") == extraction.claim_type.value
            and (c["extraction"] or {}).get("invoice_ref") == extraction.invoice_ref]
    checks["earlier_claims_same_order_and_type"] = [c["claim_id"] for c in same]
    for c in same:
        reasons.append(f"claim {c['claim_id']} on the same order, invoice and type is already {c['status']}")
    return checks, reasons


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
    It is used as given, claim type included, instead of reading the text."""
    doc_id = erp.add_document("claim email", None, email_text, path=source_name)
    claim_id = erp.next_id("claim", "CLM-")
    erp.save_claim(claim_id=claim_id, source_doc=doc_id, status="received")
    erp.log("retailer", "dispute.claim_received", claim_id, source_doc=doc_id)

    structured = extraction
    if structured is not None:
        extraction = replace(parse_extraction(structured), claim_type=ClaimType(structured["claim_type"]))
        erp.log("code", "dispute.claim_from_document", claim_id, source_doc=doc_id, detail=extraction.to_dict())
    else:
        extraction = read_claim(email_text, grok_caller=read_caller)
        erp.log("grok", "dispute.claim_read", claim_id, source_doc=doc_id, detail=extraction.to_dict())
    facts = pull_facts(extraction, store=_store(erp, include_fixtures))
    erp.log("code", "dispute.facts_pulled", claim_id, detail={
        "misses": [m.to_dict() for m in facts.misses],
        "threeway": facts.threeway.summary if facts.threeway else None,
        "reconcile": ({"status": facts.reconcile.status, "causes": facts.reconcile.causes}
                      if facts.reconcile else None),
    })
    facts_dict = facts.to_dict()
    checks, check_reasons = claim_checks(erp, claim_id, extraction, facts_dict, received_on or date.today())
    facts_dict["checks"] = checks
    signature = learning.dispute_signature(extraction.to_dict(), facts_dict)
    rule = learning.match_rule(erp, signature)
    precedents: list[dict[str, Any]] = []
    if rule:
        verdict = _verdict_from_rule(rule, extraction, facts_dict)
        # A person already approved this exact fingerprint (or an active rule from 3 alike
        # decisions). Ambiguity for the pattern is settled; only operational checks remain
        # (late complaint window, duplicate claim on the same order).
        reasons = list(check_reasons)
        erp.log("code", "dispute.rule_applied", claim_id, source_doc=rule["rule_id"], detail=rule["text"])
    else:
        precedents = learning.similar(erp, signature)
        facts_dict["precedents"] = precedents
        verdict = decide_verdict(extraction, facts_dict, grok_caller=verdict_caller)
        reasons = verdict.sign_off_reasons + [r for r in check_reasons if r not in verdict.sign_off_reasons]
    verdict_dict = verdict.to_dict() | {"claim": extraction.to_dict(), "checks": checks,
                                        "sign_off_reasons": reasons, "needs_sign_off": bool(reasons)}
    erp.log("grok", "dispute.verdict", claim_id, detail={"decision": verdict.decision.value, "amount": verdict.amount,
                                                          "sign_off_reasons": reasons})
    erp.set_claim(claim_id, order_ref=(facts.order or {}).get("order_ref") or extraction.order_ref,
                  invoice_ref=(facts.invoice or {}).get("invoice_ref") or extraction.invoice_ref,
                  extraction=extraction.to_dict(), verdict=verdict_dict)

    learning.log_case(erp, task="dispute.verdict", subject_ref=claim_id, signature=signature,
                      proposal={"decision": verdict.decision.value, "amount": verdict.amount},
                      confidence=verdict.confidence, asked_person=bool(reasons), why_person=reasons,
                      decided_by=None if reasons else ("rule" if rule else "grok"),
                      decision=None if reasons else verdict.decision.value,
                      rule_id=rule["rule_id"] if rule else None, precedents=[p["case_id"] for p in precedents])
    if reasons:
        case_id = signoff.request(
            erp, row="dispute", kind="verdict", subject_ref=claim_id,
            title=f"Claim {claim_id} on {extraction.order_ref or 'an unknown order'}: Grok proposes {verdict.decision.value}",
            proposal={"verdict": verdict_dict, "facts": facts_dict, "out_dir": str(out_dir)},
            reasons=reasons,
        )
        erp.set_claim(claim_id, status="awaiting_sign_off")
        return {"status": "awaiting_person", "claim_id": claim_id, "case_id": case_id, "verdict": verdict_dict}

    # A learned rule was already signed by a person: pass them as approved_by so outcome
    # does not re-block on the same ambiguity the rule settled.
    approved = (rule.get("approved_by") if rule else None) or None
    outcome = emit_outcome(verdict_dict, facts=facts_dict, out_dir=out_dir, issue_date=issue_date,
                           approved_by=approved)
    _save_outcome(erp, claim_id, outcome)
    return {"status": "closed", "claim_id": claim_id, "verdict": verdict_dict, "outcome": outcome.to_dict()}


def _verdict_from_rule(rule: dict[str, Any], extraction: Any, facts: dict[str, Any]):
    """An approved rule decides: no Grok call. Amounts still come only from the documents."""
    decision = rule["action"]["decision"]
    amount = extraction.amount if decision in {"accept", "partial"} else None
    who = f"approved by {rule['approved_by']}" if rule.get("approved_by") else "approved"
    support = rule.get("support") or []
    points = [{"text": rule["text"], "amount": amount,
               "source": {"kind": "playbook", "ref": rule["rule_id"], "detail": who}}]
    for proof in facts.get("proofs") or []:
        points.append({"text": proof.get("summary") or proof.get("kind"), "amount": None,
                       "source": {"kind": proof.get("kind") or "other", "ref": proof.get("ref") or proof.get("doc_id"),
                                  "detail": proof.get("doc_id") or ""}})
    learned = f", learned from {', '.join(support)}" if support else ""
    payload = {"decision": decision, "amount": amount, "confidence": 1.0, "needs_sign_off": False,
               "summary": f"Decided by rule {rule['rule_id']} ({who}{learned}).",
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
    verdict = proposal["verdict"]
    facts = proposal.get("facts") or {}
    outcome = emit_outcome(verdict, facts=facts, out_dir=proposal["out_dir"],
                           issue_date=issue_date, approved_by=by)
    _save_outcome(erp, case["subject_ref"], outcome)
    claim = verdict.get("claim") or {}
    learning.record_person_decision(erp, case["subject_ref"], decided_by=by, decision=verdict["decision"],
                                    reason=reason, overturned=False)
    agent_case = learning.case_for(erp, case["subject_ref"])
    signature = (agent_case or {}).get("signature") or learning.dispute_signature(claim, facts)
    rule_id = learning.activate_from_person(
        erp, signature, verdict["decision"], by=by, reason=reason,
        support_case_id=(agent_case or {}).get("case_id"),
    )
    signoff.record_past_case(playbook_path, when=(issue_date or date.today()).isoformat(),
                             order_ref=claim.get("order_ref") or "—", case_type=claim.get("claim_type") or "other",
                             decision=f"{verdict['decision']} (approved)", amount=verdict.get("amount"),
                             notes=f"{by}: {reason}")
    return {"status": "closed", "claim_id": case["subject_ref"], "outcome": outcome.to_dict(),
            "learned_rule_id": rule_id}


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
