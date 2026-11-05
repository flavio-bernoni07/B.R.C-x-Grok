"""Dispute sign-off desk — facilitate the person, then learn from their decision.

When a case is handed off, the desk gathers everything we know in one place:
- why a person is needed (every sign-off reason)
- three-line briefing (what happened / proposal / the one question)
- evidence index (order, DESADV, invoice, DDT/POD, reconcile causes, misses)
- optional pack folder with those files so nothing is hunted across systems

Usage (from repo root):
  python -m dispute.desk --db data/demo.sqlite list
  python -m dispute.desk --db data/demo.sqlite show SO-0001
  python -m dispute.desk --db data/demo.sqlite show SO-0001 --pack-dir /tmp/case-SO-0001
  python -m dispute.desk --db data/demo.sqlite approve SO-0001 --by Sara --reason "Late gate-in"
  python -m dispute.desk --db data/demo.sqlite reject SO-0001 --by Sara --reason "Need receiving count"
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path
from typing import Any

from core import signoff
from core.erp import Erp
from crm.briefing import brief
from dispute.service import approve_verdict, reject_verdict
from dispute.verdict import DEFAULT_PLAYBOOK


def _doc_entry(kind: str, ref: str | None, detail: str | None = None, **extra: Any) -> dict[str, Any]:
    row = {"kind": kind, "ref": ref, "detail": detail}
    row.update({k: v for k, v in extra.items() if v is not None})
    return row


def evidence_index(facts: dict[str, Any], verdict: dict[str, Any]) -> list[dict[str, Any]]:
    """Flat list of every document / cause we already have for this claim."""
    entries: list[dict[str, Any]] = []
    order = facts.get("order") or {}
    if order.get("order_ref") or order.get("doc_id"):
        entries.append(_doc_entry(
            "order", order.get("order_ref") or order.get("doc_id"),
            f"customer={order.get('customer')}; lines={len(order.get('lines') or [])}",
            doc_id=order.get("doc_id"),
        ))
    desadv = facts.get("desadv") or {}
    if desadv.get("desadv_ref") or desadv.get("doc_id"):
        entries.append(_doc_entry(
            "desadv", desadv.get("desadv_ref") or desadv.get("doc_id"),
            f"ship_date={desadv.get('ship_date')}; lines={len(desadv.get('lines') or [])}",
            doc_id=desadv.get("doc_id"),
        ))
    invoice = facts.get("invoice") or {}
    if invoice.get("invoice_ref") or invoice.get("doc_id"):
        entries.append(_doc_entry(
            "invoice", invoice.get("invoice_ref") or invoice.get("doc_id"),
            f"total={invoice.get('total')}; lines={len(invoice.get('lines') or [])}",
            doc_id=invoice.get("doc_id"),
        ))
    for proof in facts.get("proofs") or []:
        entries.append(_doc_entry(
            str(proof.get("kind") or "proof"),
            proof.get("ref") or proof.get("doc_id"),
            proof.get("summary"),
            doc_id=proof.get("doc_id"),
            signed=proof.get("signed"),
        ))
    reconcile = facts.get("reconcile") or {}
    for cause in reconcile.get("causes") or []:
        line_bits = []
        for line in reconcile.get("lines") or []:
            for c in line.get("causes") or []:
                if c.get("code") == cause:
                    line_bits.append(c.get("text") or "")
        entries.append(_doc_entry(
            "reconcile",
            cause,
            "; ".join(b for b in line_bits if b) or reconcile.get("explanation"),
            status=reconcile.get("status"),
        ))
    threeway = facts.get("threeway") or {}
    for line in threeway.get("lines") or []:
        if not line.get("reason"):
            continue
        entries.append(_doc_entry(
            "threeway",
            str(line.get("item_code") or "line"),
            f"{line.get('reason')} (ordered {line.get('ordered')}, "
            f"received {line.get('received')}, invoiced {line.get('invoiced')})",
        ))
    for miss in facts.get("misses") or []:
        entries.append(_doc_entry(
            "miss",
            miss.get("kind"),
            f"queried={miss.get('queried')}; {miss.get('detail')}",
        ))
    for point in verdict.get("points") or []:
        src = point.get("source") or {}
        if not src:
            continue
        entries.append(_doc_entry(
            f"verdict:{src.get('kind') or 'other'}",
            src.get("ref"),
            point.get("text") or src.get("detail"),
            amount=point.get("amount"),
        ))
    return entries


def build_case_pack(erp: Erp, case_id: str) -> dict[str, Any]:
    """Everything a person needs for one handed-off dispute, in one object."""
    case = erp.signoff(case_id)
    if not case or case.get("row") != "dispute":
        raise ValueError(f"{case_id} is not a dispute sign-off")
    proposal = case.get("proposal") or {}
    verdict = proposal.get("verdict") or {}
    facts = proposal.get("facts") or {}
    claim = verdict.get("claim") or {}
    reasons = list(case.get("reasons") or verdict.get("sign_off_reasons") or [])
    briefing = brief(erp, case_id)  # code path offline; optional Grok rewrite if key set
    evidence = evidence_index(facts, verdict)
    issue_verdicts = list(verdict.get("issue_verdicts") or [])
    pending_issues = list(proposal.get("pending_issues") or [])
    auto_issues = list(proposal.get("auto_issues") or [])
    if not pending_issues and issue_verdicts:
        pending_issues = [iv for iv in issue_verdicts if not iv.get("settled")]
        auto_issues = [iv for iv in issue_verdicts if iv.get("settled")]
    return {
        "case_id": case["case_id"],
        "claim_id": case.get("subject_ref"),
        "status": case.get("status"),
        "why_handed_off": reasons,
        "blocking_question": briefing.get("question") or (reasons[0] if reasons else "Decide this claim?"),
        "briefing": {
            "what_happened": briefing.get("what_happened"),
            "proposal": briefing.get("proposal"),
            "question": briefing.get("question"),
            "by": briefing.get("by"),
            "links": briefing.get("links") or [],
        },
        "proposal": {
            "decision": verdict.get("decision"),
            "amount": verdict.get("amount"),
            "confidence": verdict.get("confidence"),
            "summary": verdict.get("summary"),
        },
        "claim": claim,
        "issue_verdicts": issue_verdicts,
        "pending_issues": [
            {
                "claim_type": (iv.get("issue") or {}).get("claim_type"),
                "decision": iv.get("decision") or (iv.get("verdict") or {}).get("decision"),
                "amount": iv.get("amount") if "amount" in iv else (iv.get("verdict") or {}).get("amount"),
                "reasons": iv.get("sign_off_reasons") or iv.get("reasons") or [],
            }
            for iv in pending_issues
        ],
        "auto_issues": [
            {
                "claim_type": (iv.get("issue") or {}).get("claim_type"),
                "decision": iv.get("decision") or (iv.get("verdict") or {}).get("decision"),
                "amount": iv.get("amount") if "amount" in iv else (iv.get("verdict") or {}).get("amount"),
            }
            for iv in auto_issues
        ],
        "evidence": evidence,
        "evidence_count": len(evidence),
        "reconcile_causes": (facts.get("reconcile") or {}).get("causes") or [],
        "misses": facts.get("misses") or [],
        "out_dir": proposal.get("out_dir"),
        # Full payloads kept for the pack folder / deep dive — not required to read first.
        "verdict": verdict,
        "facts": {
            "order": facts.get("order"),
            "desadv": facts.get("desadv"),
            "invoice": facts.get("invoice"),
            "proofs": facts.get("proofs"),
            "threeway": facts.get("threeway"),
            "reconcile": facts.get("reconcile"),
            "misses": facts.get("misses"),
            "checks": facts.get("checks"),
            "precedents": facts.get("precedents"),
        },
    }


def write_case_pack(pack: dict[str, Any], pack_dir: Path | str) -> Path:
    """Write the case pack to one folder so the person has a single place to look."""
    root = Path(pack_dir)
    root.mkdir(parents=True, exist_ok=True)
    (root / "briefing.json").write_text(
        json.dumps({
            "why_handed_off": pack["why_handed_off"],
            "blocking_question": pack["blocking_question"],
            "briefing": pack["briefing"],
            "proposal": pack["proposal"],
            "claim": pack["claim"],
            "pending_issues": pack.get("pending_issues") or [],
            "auto_issues": pack.get("auto_issues") or [],
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (root / "evidence.json").write_text(
        json.dumps({
            "evidence": pack["evidence"],
            "reconcile_causes": pack["reconcile_causes"],
            "misses": pack["misses"],
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (root / "verdict.json").write_text(
        json.dumps(pack["verdict"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (root / "facts.json").write_text(
        json.dumps(pack["facts"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (root / "pack.json").write_text(
        json.dumps(pack, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    lines = [
        f"# Dispute case pack — {pack['case_id']}",
        "",
        f"Claim: `{pack['claim_id']}` · status: **{pack['status']}**",
        "",
        "## Why a person is needed",
    ]
    for reason in pack["why_handed_off"] or ["(no reason recorded)"]:
        lines.append(f"- {reason}")
    lines += [
        "",
        "## Briefing",
        f"- **What happened:** {pack['briefing'].get('what_happened')}",
        f"- **Proposal:** {pack['briefing'].get('proposal')}",
        f"- **Your question:** {pack['blocking_question']}",
    ]
    if pack.get("auto_issues") or pack.get("pending_issues"):
        lines += ["", "## Issues in this claim"]
        for iv in pack.get("auto_issues") or []:
            amt = f" €{iv['amount']}" if iv.get("amount") is not None else ""
            lines.append(f"- **{iv.get('claim_type')}** (auto): {iv.get('decision')}{amt}")
        for iv in pack.get("pending_issues") or []:
            amt = f" €{iv['amount']}" if iv.get("amount") is not None else ""
            lines.append(f"- **{iv.get('claim_type')}** (needs you): {iv.get('decision')}{amt}")
    lines += [
        "",
        "## Evidence we already have",
    ]
    if not pack["evidence"]:
        lines.append("- (none found — see misses)")
    for item in pack["evidence"]:
        detail = f" — {item['detail']}" if item.get("detail") else ""
        lines.append(f"- **{item['kind']}** `{item.get('ref') or 'n/a'}`{detail}")
    if pack["misses"]:
        lines += ["", "## Lookup misses"]
        for miss in pack["misses"]:
            lines.append(f"- {miss.get('kind')}: queried `{miss.get('queried')}` — {miss.get('detail')}")
    lines += [
        "",
        "## Files in this folder",
        "- `briefing.json` — why handed off + three-line briefing + proposal",
        "- `evidence.json` — document / reconcile index",
        "- `verdict.json` — full Grok verdict",
        "- `facts.json` — order / DESADV / invoice / proofs / matchers",
        "- `pack.json` — everything above in one object",
        "",
        "Approve: `python -m dispute.desk --db <db> approve "
        f"{pack['case_id']} --by NAME --reason '…'`",
        "",
    ]
    (root / "README.md").write_text("\n".join(lines), encoding="utf-8")
    return root


def list_cases(erp: Erp) -> list[dict[str, Any]]:
    """Pending dispute sign-offs: reason first, then proposal."""
    rows: list[dict[str, Any]] = []
    for case in signoff.pending(erp, row="dispute"):
        proposal = case.get("proposal") or {}
        verdict = proposal.get("verdict") or {}
        claim = verdict.get("claim") or {}
        facts = proposal.get("facts") or {}
        reasons = list(case.get("reasons") or verdict.get("sign_off_reasons") or [])
        issue_verdicts = verdict.get("issue_verdicts") or []
        pending_types = [
            (iv.get("issue") or {}).get("claim_type")
            for iv in issue_verdicts
            if not iv.get("settled")
        ]
        rows.append(
            {
                "case_id": case["case_id"],
                "claim_id": case.get("subject_ref"),
                "why_handed_off": reasons,
                "blocking_question": (reasons[0] if reasons else "Decide this claim?").rstrip(".")
                + ": agree with Grok?",
                "decision": verdict.get("decision"),
                "amount": verdict.get("amount"),
                "claim_type": claim.get("claim_type"),
                "issue_count": len(issue_verdicts) or len(claim.get("issues") or []) or 1,
                "pending_issue_types": [t for t in pending_types if t],
                "order_ref": claim.get("order_ref") or (facts.get("order") or {}).get("order_ref"),
                "reconcile_causes": (facts.get("reconcile") or {}).get("causes") or [],
                "evidence_count": len(evidence_index(facts, verdict)),
                "out_dir": proposal.get("out_dir"),
            }
        )
    return rows


def show_case(erp: Erp, case_id: str, *, pack_dir: Path | str | None = None) -> dict[str, Any]:
    """Case pack for one sign-off; optionally write it to a folder."""
    pack = build_case_pack(erp, case_id)
    # Compact view for stdout: lead with what the person needs, keep full under keys.
    view = {
        "case_id": pack["case_id"],
        "claim_id": pack["claim_id"],
        "status": pack["status"],
        "why_handed_off": pack["why_handed_off"],
        "blocking_question": pack["blocking_question"],
        "briefing": pack["briefing"],
        "proposal": pack["proposal"],
        "claim": pack["claim"],
        "issue_verdicts": pack.get("issue_verdicts") or [],
        "pending_issues": pack.get("pending_issues") or [],
        "auto_issues": pack.get("auto_issues") or [],
        "evidence": pack["evidence"],
        "reconcile_causes": pack["reconcile_causes"],
        "misses": pack["misses"],
        "out_dir": pack["out_dir"],
    }
    if pack_dir is not None:
        path = write_case_pack(pack, pack_dir)
        view["pack_dir"] = str(path.resolve())
    return view


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Dispute sign-off desk: list / show (case pack) / approve / reject."
    )
    parser.add_argument(
        "--db",
        required=True,
        help="Mini ERP SQLite path (e.g. data/demo.sqlite from demo.py --db)",
    )
    parser.add_argument(
        "--playbook",
        type=Path,
        default=DEFAULT_PLAYBOOK,
        help="Playbook path for past-case write-back (default: data/disputes/playbook.md)",
    )
    parser.add_argument(
        "--issue-date",
        default=None,
        help="ISO date for the credit note / past case (default: today)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="List pending dispute sign-offs (reason first)")

    p_show = sub.add_parser("show", help="Case pack: why handed off, briefing, evidence index")
    p_show.add_argument("case_id")
    p_show.add_argument(
        "--pack-dir",
        type=Path,
        default=None,
        help="Write briefing/evidence/verdict/facts + README into this folder",
    )

    p_ok = sub.add_parser("approve", help="Approve Grok's verdict and write TD04 / reply")
    p_ok.add_argument("case_id")
    p_ok.add_argument("--by", required=True, help="Who decides")
    p_ok.add_argument("--reason", required=True, help="One line the Playbook learns from")

    p_no = sub.add_parser("reject", help="Overturn Grok; reopen the claim")
    p_no.add_argument("case_id")
    p_no.add_argument("--by", required=True, help="Who decides")
    p_no.add_argument("--reason", required=True, help="One line the Playbook learns from")

    args = parser.parse_args(argv)
    erp = Erp(args.db)
    issue = date.fromisoformat(args.issue_date) if args.issue_date else None

    try:
        if args.command == "list":
            rows = list_cases(erp)
            print(json.dumps({"pending": rows, "count": len(rows)}, ensure_ascii=False, indent=2))
            return 0
        if args.command == "show":
            print(json.dumps(
                show_case(erp, args.case_id, pack_dir=args.pack_dir),
                ensure_ascii=False,
                indent=2,
            ))
            return 0
        if args.command == "approve":
            done = approve_verdict(
                erp,
                args.case_id,
                by=args.by,
                reason=args.reason,
                playbook_path=args.playbook,
                issue_date=issue,
            )
            print(json.dumps(done, ensure_ascii=False, indent=2))
            return 0
        if args.command == "reject":
            done = reject_verdict(
                erp,
                args.case_id,
                by=args.by,
                reason=args.reason,
                playbook_path=args.playbook,
            )
            print(json.dumps(done, ensure_ascii=False, indent=2))
            return 0
    except (ValueError, KeyError, FileNotFoundError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
