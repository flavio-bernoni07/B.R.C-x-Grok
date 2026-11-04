"""Minimal Dispute sign-off desk — list pending cases, approve or reject.

Uses the same queue and services as the shared CRM (`core.signoff.pending`,
`approve_verdict` / `reject_verdict`). No web UI: a person works from the CLI.

Usage (from repo root):
  python -m dispute.desk --db data/demo.sqlite list
  python -m dispute.desk --db data/demo.sqlite show SO-0001
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
from dispute.service import approve_verdict, reject_verdict
from dispute.verdict import DEFAULT_PLAYBOOK


def list_cases(erp: Erp) -> list[dict[str, Any]]:
    """Pending dispute sign-offs with the fields a person needs on the desk."""
    rows: list[dict[str, Any]] = []
    for case in signoff.pending(erp, row="dispute"):
        proposal = case.get("proposal") or {}
        verdict = proposal.get("verdict") or {}
        claim = verdict.get("claim") or {}
        facts = proposal.get("facts") or {}
        rows.append(
            {
                "case_id": case["case_id"],
                "claim_id": case.get("subject_ref"),
                "title": case.get("title"),
                "decision": verdict.get("decision"),
                "amount": verdict.get("amount"),
                "claim_type": claim.get("claim_type"),
                "order_ref": claim.get("order_ref") or (facts.get("order") or {}).get("order_ref"),
                "sign_off_reasons": case.get("reasons") or verdict.get("sign_off_reasons") or [],
                "reconcile_causes": (facts.get("reconcile") or {}).get("causes") or [],
                "out_dir": proposal.get("out_dir"),
            }
        )
    return rows


def show_case(erp: Erp, case_id: str) -> dict[str, Any]:
    case = erp.signoff(case_id)
    if not case or case.get("row") != "dispute":
        raise ValueError(f"{case_id} is not a pending dispute sign-off")
    proposal = case.get("proposal") or {}
    verdict = proposal.get("verdict") or {}
    facts = proposal.get("facts") or {}
    return {
        "case": {
            "case_id": case["case_id"],
            "claim_id": case.get("subject_ref"),
            "status": case.get("status"),
            "title": case.get("title"),
            "reasons": case.get("reasons"),
        },
        "verdict": {
            "decision": verdict.get("decision"),
            "amount": verdict.get("amount"),
            "confidence": verdict.get("confidence"),
            "summary": verdict.get("summary"),
            "points": verdict.get("points"),
            "sign_off_reasons": verdict.get("sign_off_reasons"),
            "claim": verdict.get("claim"),
        },
        "facts": {
            "order_ref": (facts.get("order") or {}).get("order_ref"),
            "invoice_ref": (facts.get("invoice") or {}).get("invoice_ref"),
            "misses": facts.get("misses"),
            "threeway_summary": (facts.get("threeway") or {}).get("summary"),
            "reconcile": facts.get("reconcile"),
            "proofs": [
                {"kind": p.get("kind"), "ref": p.get("ref"), "summary": p.get("summary")}
                for p in (facts.get("proofs") or [])
            ],
        },
        "out_dir": proposal.get("out_dir"),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Dispute sign-off desk: list / show / approve / reject pending verdicts."
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

    sub.add_parser("list", help="List pending dispute sign-offs")

    p_show = sub.add_parser("show", help="Show one case with verdict + facts summary")
    p_show.add_argument("case_id")

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
            print(json.dumps(show_case(erp, args.case_id), ensure_ascii=False, indent=2))
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
