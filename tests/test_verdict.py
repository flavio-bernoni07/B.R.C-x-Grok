"""Unit tests for dispute.verdict — Grok is mocked; no network / API key."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from dispute.claim_reader import MissingApiKeyError
from dispute.pull_facts import load_claim_json, pull_facts
from dispute.verdict import (
    VerdictDecision,
    collect_known_amounts,
    decide_verdict,
    load_text,
    main,
    normalize_amounts,
    parse_verdict_payload,
)

ROOT = Path(__file__).resolve().parents[1]
EXTRACTIONS = ROOT / "data" / "disputes" / "extractions"
PLAYBOOK = ROOT / "data" / "disputes" / "playbook.md"
CONTRACT = ROOT / "data" / "disputes" / "contract_excerpt.md"


def _shortage_bundle():
    claim = load_claim_json(EXTRACTIONS / "01_shortage.json")
    facts = pull_facts(claim).to_dict()
    return claim, facts


def test_playbook_and_contract_exist() -> None:
    playbook = load_text(PLAYBOOK)
    contract = load_text(CONTRACT)
    assert "Shortage" in playbook or "shortage" in playbook.lower()
    assert "Past cases" in playbook
    assert "Complaint window" in contract or "complaint" in contract.lower()
    assert "1.49" in contract
    assert "tolerance" in contract.lower()


def test_collect_known_amounts_includes_claim_and_threeway() -> None:
    claim, facts = _shortage_bundle()
    known = collect_known_amounts(claim, facts)
    assert 186.0 in known  # claim amount / (40-28)*15.5
    assert 15.5 in known


def test_normalize_amounts_drops_invented() -> None:
    from dispute.verdict import VerdictPoint, VerdictSource

    points = [
        VerdictPoint(
            text="invented",
            amount=9999.0,
            source=VerdictSource(kind="other", ref="x", detail=""),
        ),
        VerdictPoint(
            text="ok",
            amount=186.0,
            source=VerdictSource(kind="threeway", ref="qty", detail=""),
        ),
    ]
    amount, fixed, notes = normalize_amounts(
        VerdictDecision.ACCEPT, 9999.0, points, known=[186.0, 72.0]
    )
    assert amount == 186.0 or amount is None or amount == 72.0
    # 9999 should not survive as overall or point amount
    assert all(p.amount != 9999.0 for p in fixed)
    assert notes


def test_parse_verdict_payload_maps_decision() -> None:
    verdict = parse_verdict_payload(
        {
            "decision": "partial",
            "amount": 72.0,
            "confidence": 0.8,
            "needs_sign_off": False,
            "summary": "Promo price gap",
            "points": [
                {
                    "text": "Invoice above promo",
                    "amount": 72.0,
                    "source": {
                        "kind": "contract",
                        "ref": "RS-PROMO-AUT26",
                        "detail": "€1.49 vs €1.85",
                    },
                }
            ],
        },
        known_amounts=[72.0, 1.49, 1.85],
    )
    assert verdict.decision is VerdictDecision.PARTIAL
    assert verdict.amount == 72.0
    assert len(verdict.points) == 1
    assert verdict.points[0].source.ref == "RS-PROMO-AUT26"


def test_decide_verdict_with_mocked_grok() -> None:
    claim, facts = _shortage_bundle()

    def fake_grok(messages):
        assert any("PLAYBOOK" in m["content"] for m in messages)
        assert any("known_amounts_eur" in m["content"] for m in messages)
        return {
            "decision": "accept",
            "amount": 186.0,
            "confidence": 0.9,
            "needs_sign_off": False,
            "summary": "Invoiced 40 vs DESADV/DDT 28; credit short-shipped cartons.",
            "points": [
                {
                    "text": "Over-billed 12 CTN vs DESADV",
                    "amount": 186.0,
                    "source": {
                        "kind": "threeway",
                        "ref": "Billed for more than was received",
                        "detail": "invoiced 40 received 28",
                    },
                },
                {
                    "text": "Signed DDT confirms 28 CTN",
                    "amount": None,
                    "source": {
                        "kind": "ddt",
                        "ref": "DDT-1187",
                        "detail": "quantity_confirmed 28",
                    },
                },
            ],
        }

    verdict = decide_verdict(claim, facts, grok_caller=fake_grok)
    assert verdict.decision is VerdictDecision.ACCEPT
    assert verdict.amount == 186.0
    assert len(verdict.points) == 2
    assert verdict.playbook_path
    assert "playbook" in (verdict.playbook_path or "").lower() or verdict.playbook_path.endswith(
        "playbook.md"
    )


def test_decide_verdict_rejects_invented_amount() -> None:
    claim, facts = _shortage_bundle()

    def fake_grok(_messages):
        return {
            "decision": "accept",
            "amount": 12345.67,
            "confidence": 0.99,
            "needs_sign_off": False,
            "summary": "bad invent",
            "points": [
                {
                    "text": "made up",
                    "amount": 12345.67,
                    "source": {"kind": "other", "ref": "none", "detail": ""},
                }
            ],
        }

    verdict = decide_verdict(claim, facts, grok_caller=fake_grok)
    assert verdict.amount != 12345.67
    assert all(p.amount != 12345.67 for p in verdict.points)
    assert verdict.amount_notes
    assert verdict.needs_sign_off
    assert "Grok proposed an amount that is not in the documents" in verdict.sign_off_reasons


def test_decide_verdict_missing_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)
    claim, facts = _shortage_bundle()
    with pytest.raises(MissingApiKeyError):
        decide_verdict(claim, facts)


def test_cli_dry_run(capsys: pytest.CaptureFixture[str]) -> None:
    code = main(["--extraction", str(EXTRACTIONS / "02_pricing.json"), "--dry-run"])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["dry_run"] is True
    assert payload["facts_order_ref"] == "PO77821"
    assert 72.0 in payload["known_amounts_eur"]
    assert payload["playbook_chars"] > 100
    assert payload["contract_chars"] > 100


def test_cli_live_with_mock(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("XAI_API_KEY", "test-key")

    def fake_call(messages, *, api_key: str):
        assert api_key == "test-key"
        return {
            "decision": "accept",
            "amount": 72.0,
            "confidence": 0.88,
            "needs_sign_off": False,
            "summary": "Promo credit",
            "points": [
                {
                    "text": "Price variance vs RS-PROMO-AUT26",
                    "amount": 72.0,
                    "source": {
                        "kind": "contract",
                        "ref": "RS-PROMO-AUT26",
                        "detail": "1.85 vs 1.49 × 200",
                    },
                }
            ],
        }

    monkeypatch.setattr("dispute.verdict.call_grok_verdict", fake_call)
    code = main(["--extraction", str(EXTRACTIONS / "02_pricing.json")])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["decision"] == "accept"
    assert payload["amount"] == 72.0


def test_cli_missing_key(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)
    code = main(["--extraction", str(EXTRACTIONS / "01_shortage.json")])
    assert code == 1
    assert "XAI_API_KEY" in capsys.readouterr().err


# --- Sign-off: no euro threshold, only ambiguity sends a case to a person ---

def _clear_payload(amount: float = 2000.0, **overrides):
    payload = {
        "decision": "accept",
        "amount": amount,
        "confidence": 0.9,
        "needs_sign_off": False,
        "summary": "Clear over-billing",
        "points": [
            {
                "text": "Billed for more than was received",
                "amount": amount,
                "source": {"kind": "threeway", "ref": "Billed for more than was received", "detail": ""},
            }
        ],
    }
    payload.update(overrides)
    return payload


_CLEAR_CLAIM = {
    "order_ref": "RS-2026-00481",
    "invoice_ref": "FT-2026/1187",
    "product": "Riso Scotti Arborio 1kg",
    "quantity": 129,
    "amount": 2000.0,
    "claim_type": "shortage",
    "confidence": 0.92,
    "raw_notes": "",
}


def test_large_clear_credit_needs_no_sign_off() -> None:
    verdict = parse_verdict_payload(
        _clear_payload(2000.0),
        known_amounts=[2000.0],
        claim=_CLEAR_CLAIM,
        facts={"misses": []},
    )
    assert verdict.amount == 2000.0
    assert verdict.needs_sign_off is False
    assert verdict.sign_off_reasons == []


def test_grok_unsure_needs_sign_off() -> None:
    verdict = parse_verdict_payload(
        _clear_payload(186.0, needs_sign_off=True), known_amounts=[186.0]
    )
    assert verdict.needs_sign_off
    assert "Grok marked the case as unsure" in verdict.sign_off_reasons


def test_low_verdict_confidence_needs_sign_off() -> None:
    verdict = parse_verdict_payload(_clear_payload(186.0, confidence=0.5), known_amounts=[186.0])
    assert verdict.needs_sign_off
    assert any("verdict confidence" in r for r in verdict.sign_off_reasons)


def test_point_without_source_needs_sign_off() -> None:
    payload = _clear_payload(186.0)
    payload["points"][0]["source"] = {}
    verdict = parse_verdict_payload(payload, known_amounts=[186.0])
    assert verdict.needs_sign_off
    assert "a point has no source" in verdict.sign_off_reasons


def test_claim_type_not_in_playbook_needs_sign_off() -> None:
    claim = load_claim_json(EXTRACTIONS / "04_short_payment.json")  # claim_type "other"
    verdict = parse_verdict_payload(
        _clear_payload(70.0), known_amounts=[70.0], claim=claim, facts={"misses": []}
    )
    assert verdict.needs_sign_off
    assert "the claim type is not covered by the Playbook" in verdict.sign_off_reasons


def test_unsure_claim_reading_needs_sign_off() -> None:
    claim = dict(_CLEAR_CLAIM, confidence=0.4)
    verdict = parse_verdict_payload(_clear_payload(186.0), known_amounts=[186.0], claim=claim)
    assert verdict.needs_sign_off
    assert any("claim reading confidence" in r for r in verdict.sign_off_reasons)


def test_missing_document_needs_sign_off() -> None:
    facts = {"misses": [{"kind": "invoice", "queried": "334", "detail": "No invoice matched"}]}
    verdict = parse_verdict_payload(
        _clear_payload(186.0), known_amounts=[186.0], claim=_CLEAR_CLAIM, facts=facts
    )
    assert verdict.needs_sign_off
    assert "documents not found: invoice" in verdict.sign_off_reasons


def test_decide_verdict_clear_shortage_goes_without_person() -> None:
    claim, facts = _shortage_bundle()

    def fake_grok(_messages):
        return _clear_payload(186.0)

    verdict = decide_verdict(claim, facts, grok_caller=fake_grok)
    assert verdict.needs_sign_off is False
    assert verdict.to_dict()["sign_off_reasons"] == []
