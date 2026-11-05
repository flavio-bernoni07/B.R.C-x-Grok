"""Dispute sign-off desk + Mini-ERP-only claim runner."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

import demo
from core.erp import Erp
from core.world import fresh_erp
from dispute import desk
from dispute.service import handle_claim, main as service_main
from shipping.service import export_for_dispute

ROOT = Path(__file__).resolve().parents[1]
DISPUTES = ROOT / "data" / "disputes"
GOLDEN = ROOT / "data" / "world" / "golden"


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)


def _unclear():
    extraction = json.loads((DISPUTES / "extractions" / "05_ambiguous.json").read_text())
    verdict = json.loads((DISPUTES / "verdicts" / "05_ambiguous_reject.json").read_text())
    for key in ("claim", "playbook_path", "contract_path", "amount_notes", "known_amounts"):
        verdict.pop(key, None)
    return (lambda _t: dict(extraction)), (lambda _m: json.loads(json.dumps(verdict)))


def test_desk_pack_surfaces_multi_issue_split(tmp_path: Path) -> None:
    erp = fresh_erp()
    extraction = json.loads((DISPUTES / "extractions" / "07_shortage_and_pricing.json").read_text())
    shortage = json.loads((DISPUTES / "verdicts" / "07_shortage_issue.json").read_text())
    pricing = json.loads((DISPUTES / "verdicts" / "07_pricing_ambiguous.json").read_text())

    def verdict_c(messages):
        import re

        text = messages[-1]["content"] if messages else ""
        match = re.search(r'"claim_type"\s*:\s*"(\w+)"', text)
        claim_type = match.group(1) if match else "shortage"
        return json.loads(json.dumps(pricing if claim_type == "pricing" else shortage))

    res = handle_claim(
        erp,
        (DISPUTES / "claims" / "07_shortage_and_pricing.txt").read_text(),
        out_dir=tmp_path / "out",
        read_caller=lambda _t: dict(extraction),
        verdict_caller=verdict_c,
    )
    assert res["status"] == "awaiting_person"
    pending = desk.list_cases(erp)
    assert pending[0]["issue_count"] == 2
    assert "pricing" in pending[0]["pending_issue_types"]
    pack_dir = tmp_path / "multi-pack"
    shown = desk.show_case(erp, res["case_id"], pack_dir=pack_dir)
    assert any(iv.get("claim_type") == "shortage" for iv in shown["auto_issues"])
    assert any(iv.get("claim_type") == "pricing" for iv in shown["pending_issues"])
    readme = (pack_dir / "README.md").read_text()
    assert "Issues in this claim" in readme
    assert "needs you" in readme
    briefing = json.loads((pack_dir / "briefing.json").read_text())
    assert briefing["pending_issues"]
    assert briefing["auto_issues"]


def test_desk_lists_and_approves_pending_dispute(tmp_path: Path, capsys) -> None:
    db = tmp_path / "desk.sqlite"
    erp = fresh_erp(db)
    playbook = tmp_path / "playbook.md"
    shutil.copy(DISPUTES / "playbook.md", playbook)
    read_c, verdict_c = _unclear()
    res = handle_claim(
        erp,
        (DISPUTES / "claims" / "05_ambiguous_otif_or_shortage.txt").read_text(),
        out_dir=tmp_path / "out",
        read_caller=read_c,
        verdict_caller=verdict_c,
    )
    assert res["status"] == "awaiting_person"

    pending = desk.list_cases(erp)
    assert len(pending) == 1
    assert pending[0]["case_id"] == res["case_id"]
    assert pending[0]["decision"] == "reject"
    assert pending[0]["why_handed_off"]
    assert pending[0]["blocking_question"]
    assert pending[0]["evidence_count"] >= 1
    assert pending[0]["order_ref"] == "RS26112"

    pack_dir = tmp_path / "case-pack"
    shown = desk.show_case(erp, res["case_id"], pack_dir=pack_dir)
    assert shown["proposal"]["decision"] == "reject"
    assert shown["why_handed_off"]
    assert shown["briefing"]["what_happened"]
    assert shown["briefing"]["question"]
    assert shown["blocking_question"]
    assert any(e["kind"] == "order" for e in shown["evidence"])
    assert (pack_dir / "README.md").is_file()
    assert (pack_dir / "briefing.json").is_file()
    assert (pack_dir / "evidence.json").is_file()
    assert (pack_dir / "verdict.json").is_file()
    assert (pack_dir / "facts.json").is_file()
    readme = (pack_dir / "README.md").read_text()
    assert "Why a person is needed" in readme
    assert "Evidence we already have" in readme

    assert desk.main(["--db", str(db), "list"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert listed["count"] == 1
    assert listed["pending"][0]["why_handed_off"]

    assert desk.main(["--db", str(db), "show", res["case_id"], "--pack-dir", str(tmp_path / "cli-pack")]) == 0
    shown_cli = json.loads(capsys.readouterr().out)
    assert shown_cli["pack_dir"]
    assert Path(shown_cli["pack_dir"], "README.md").is_file()

    assert (
        desk.main(
            [
                "--db",
                str(db),
                "--playbook",
                str(playbook),
                "--issue-date",
                "2026-11-07",
                "approve",
                res["case_id"],
                "--by",
                "Sara",
                "--reason",
                "Late gate-in, quantities agree",
            ]
        )
        == 0
    )
    done = json.loads(capsys.readouterr().out)
    assert done["status"] == "closed"
    assert done["outcome"]["kind"] == "reject_reply"
    assert erp.claim(res["claim_id"])["status"] == "closed"
    assert desk.list_cases(erp) == []


def test_erp_only_claim_finds_golden_order_without_fixtures(tmp_path: Path) -> None:
    db = tmp_path / "demo.sqlite"
    demo.run(db=str(db), out_dir=tmp_path / "demo_out", quiet=True, with_planning=False)
    erp = Erp(db)
    catalog = export_for_dispute(erp)
    assert any(o["order_ref"] == "ESS-GOLD-001" for o in catalog["orders"])

    offline = GOLDEN / "grok_offline.json"
    out = tmp_path / "jury_claim"
    code = service_main(
        [
            "--db",
            str(db),
            str(GOLDEN / "claim_email.txt"),
            "--out-dir",
            str(out),
            "--offline",
            str(offline),
            "--issue-date",
            "2026-11-07",
        ]
    )
    assert code == 0
    claims = [c for c in erp.claims() if c.get("order_ref") == "ESS-GOLD-001"]
    assert len(claims) >= 2  # demo claim + jury runner claim


def test_erp_only_unknown_order_reports_misses(tmp_path: Path, capsys) -> None:
    db = tmp_path / "empty.sqlite"
    demo.run(db=str(db), out_dir=tmp_path / "demo_out", quiet=True, with_planning=False)
    extraction = {
        "order_ref": "DOES-NOT-EXIST",
        "invoice_ref": None,
        "product": None,
        "quantity": None,
        "amount": 10.0,
        "claim_type": "other",
        "confidence": 0.2,
        "raw_notes": "jury unknown",
    }
    verdict = {
        "decision": "reject",
        "amount": None,
        "confidence": 0.3,
        "needs_sign_off": True,
        "summary": "unknown order",
        "points": [
            {
                "text": "order not found",
                "amount": None,
                "source": {"kind": "other", "ref": "miss", "detail": "no docs"},
            }
        ],
    }
    ext_path = tmp_path / "ext.json"
    verd_path = tmp_path / "verd.json"
    ext_path.write_text(json.dumps(extraction), encoding="utf-8")
    verd_path.write_text(json.dumps(verdict), encoding="utf-8")
    claim = tmp_path / "claim.txt"
    claim.write_text("unknown claim", encoding="utf-8")

    code = service_main(
        [
            "--db",
            str(db),
            str(claim),
            "--out-dir",
            str(tmp_path / "out"),
            "--extraction",
            str(ext_path),
            "--verdict",
            str(verd_path),
        ]
    )
    assert code == 0
    captured = capsys.readouterr()
    assert "lookup misses" in captured.err
    summary = json.loads(captured.out)
    assert summary["status"] == "awaiting_person"
    assert any(m.get("kind") == "order" for m in summary.get("misses") or [])
    assert summary.get("hint")
