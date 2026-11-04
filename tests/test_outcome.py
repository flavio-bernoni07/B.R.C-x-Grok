"""Unit tests for dispute.outcome — no network; uses sample verdict JSON."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from dispute.outcome import (
    build_edi_invoic_381,
    emit_outcome,
    load_verdict_json,
    main,
    resolve_facts,
)

ROOT = Path(__file__).resolve().parents[1]
VERDICTS = ROOT / "data" / "disputes" / "verdicts"


def test_emit_credit_note_td04(tmp_path: Path) -> None:
    verdict = load_verdict_json(VERDICTS / "01_shortage_accept.json")
    facts = resolve_facts(verdict)
    outcome = emit_outcome(
        verdict,
        facts=facts,
        out_dir=tmp_path,
        issue_date=date(2026, 11, 4),
    )
    assert outcome.kind == "credit_note"
    assert outcome.decision == "accept"
    assert outcome.amount == 186.0
    assert outcome.credit_note_number
    xml_path = Path(outcome.paths["td04_xml"])
    xml = xml_path.read_text(encoding="utf-8")
    assert "TD04" in xml
    assert "DEMO FatturaPA TD04" in xml
    assert "186.00" in xml
    assert "FT-2026/1187" in xml
    edi = Path(outcome.paths["edi_invoic_381"]).read_text(encoding="utf-8")
    assert "BGM+381+" in edi
    assert "186.00" in edi or "186" in edi
    meta = json.loads(Path(outcome.paths["outcome_json"]).read_text(encoding="utf-8"))
    assert meta["kind"] == "credit_note"
    assert meta["order_ref"] == "RS-2026-00481"


def test_emit_pricing_credit_note(tmp_path: Path) -> None:
    verdict = load_verdict_json(VERDICTS / "02_pricing_accept.json")
    outcome = emit_outcome(
        verdict,
        facts=resolve_facts(verdict),
        out_dir=tmp_path,
        issue_date=date(2026, 11, 4),
    )
    assert outcome.amount == 72.0
    xml = Path(outcome.paths["td04_xml"]).read_text(encoding="utf-8")
    assert "INV2026-0891" in xml
    assert "TD04" in xml


def test_ambiguous_verdict_waits_for_a_person(tmp_path: Path) -> None:
    verdict = load_verdict_json(VERDICTS / "05_ambiguous_reject.json")
    outcome = emit_outcome(
        verdict,
        facts=resolve_facts(verdict),
        out_dir=tmp_path,
        issue_date=date(2026, 11, 4),
    )
    assert outcome.kind == "awaiting_sign_off"
    assert outcome.sign_off_reasons
    assert "reject_reply" not in outcome.paths
    assert not list(tmp_path.glob("*_reject_reply.txt"))
    assert not list(tmp_path.glob("*_TD04.xml"))
    meta = json.loads(Path(outcome.paths["outcome_json"]).read_text(encoding="utf-8"))
    assert meta["kind"] == "awaiting_sign_off"


def test_clear_verdict_has_no_sign_off_reasons(tmp_path: Path) -> None:
    verdict = load_verdict_json(VERDICTS / "01_shortage_accept.json")
    outcome = emit_outcome(verdict, facts=resolve_facts(verdict), out_dir=tmp_path)
    assert outcome.kind == "credit_note"
    assert outcome.sign_off_reasons == []
    assert outcome.approved_by is None


def test_emit_reject_reply(tmp_path: Path) -> None:
    verdict = load_verdict_json(VERDICTS / "05_ambiguous_reject.json")
    outcome = emit_outcome(
        verdict,
        facts=resolve_facts(verdict),
        out_dir=tmp_path,
        issue_date=date(2026, 11, 4),
        approved_by="EMP-DISPUTE-01",
    )
    assert outcome.approved_by == "EMP-DISPUTE-01"
    assert outcome.kind == "reject_reply"
    assert outcome.decision == "reject"
    assert outcome.credit_note_number is None
    text = Path(outcome.paths["reject_reply"]).read_text(encoding="utf-8")
    assert "REJECT" in text
    assert "RS26112" in text
    assert "DESADV-2026-26112" in text
    assert "GATE-IPER" in text or "DDT-26112" in text
    # Retailer-facing: no internal Playbook / generator meta
    assert "Playbook" not in text
    assert "dispute.outcome" not in text
    assert "out of scope" not in text
    assert "Despatch advice" in text or "Delivery note" in text


def test_edi_bgm_381() -> None:
    from decimal import Decimal

    edi = build_edi_invoic_381(
        amount=Decimal("72.00"),
        invoice_ref="INV2026-0891",
        order_ref="PO77821",
        credit_note_number="NC-TEST",
        issue_date=date(2026, 11, 4),
    )
    assert "BGM+381+NC-TEST+9'" in edi
    assert "RFF+IV:INV2026-0891'" in edi
    assert "RFF+ON:PO77821'" in edi


def test_cli_credit_note(tmp_path: Path, capsys) -> None:
    code = main(
        [
            "--verdict",
            str(VERDICTS / "01_shortage_accept.json"),
            "--out-dir",
            str(tmp_path),
            "--issue-date",
            "2026-11-04",
        ]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["kind"] == "credit_note"
    assert Path(payload["paths"]["td04_xml"]).is_file()


def test_cli_reject(tmp_path: Path, capsys) -> None:
    code = main(
        [
            "--verdict",
            str(VERDICTS / "05_ambiguous_reject.json"),
            "--out-dir",
            str(tmp_path),
            "--approved-by",
            "EMP-DISPUTE-01",
        ]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["kind"] == "reject_reply"


def test_cli_ambiguous_without_approval(tmp_path: Path, capsys) -> None:
    code = main(
        [
            "--verdict",
            str(VERDICTS / "05_ambiguous_reject.json"),
            "--out-dir",
            str(tmp_path),
        ]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["kind"] == "awaiting_sign_off"



def test_reject_reply_when_no_document_was_found(tmp_path: Path) -> None:
    """Live Grok on an unclear claim: no order, DESADV or invoice matched, a person approves the reject."""
    verdict = {"decision": "reject", "amount": None, "confidence": 0.3, "needs_sign_off": True,
               "summary": "Cannot match the claim to any order.", "known_amounts": [],
               "points": [{"text": "No order matches the references", "amount": None,
                           "source": {"kind": "playbook", "ref": "Other / ambiguous", "detail": "ask for refs"}}],
               "claim": {"order_ref": None, "invoice_ref": None, "claim_type": "other", "confidence": 0.4}}
    facts = {"order": None, "desadv": None, "invoice": None, "proofs": [], "threeway": None,
             "misses": [{"kind": "order", "queried": None, "detail": "no ref"}]}
    outcome = emit_outcome(verdict, facts=facts, out_dir=tmp_path, approved_by="Sara")
    assert outcome.kind == "reject_reply"
    assert Path(outcome.paths["reject_reply"]).is_file()
