"""Unit tests for dispute.claim_reader — Grok is mocked; no API key required."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from dispute.claim_reader import (
    DEFAULT_XAI_MODEL,
    ClaimExtraction,
    ClaimType,
    MissingApiKeyError,
    _model,
    load_claim_file,
    main,
    parse_extraction,
    read_claim,
    refine_claim_type,
    scoped_extraction,
)

FIXTURES = Path(__file__).resolve().parents[1] / "data" / "disputes" / "claims"


def test_parse_extraction_maps_fields_and_nulls() -> None:
    result = parse_extraction(
        {
            "order_ref": "RS-2026-00481",
            "invoice_ref": None,
            "product": "Arborio 1kg",
            "quantity": 12,
            "amount": "186,00",
            "claim_type": "shortage",
            "confidence": 0.91,
            "raw_notes": "invoice present in email but left null in this fixture test",
        }
    )
    assert isinstance(result, ClaimExtraction)
    assert result.order_ref == "RS-2026-00481"
    assert result.invoice_ref is None
    assert result.product == "Arborio 1kg"
    assert result.quantity == 12.0
    assert result.amount == 186.0
    assert result.claim_type is ClaimType.SHORTAGE
    assert result.confidence == 0.91
    assert len(result.issues) == 1
    assert result.issues[0].claim_type is ClaimType.SHORTAGE
    assert result.issues[0].amount == 186.0
    assert result.to_dict()["issues"][0]["claim_type"] == "shortage"


def test_parse_extraction_multi_issues_round_trip() -> None:
    result = parse_extraction(
        {
            "order_ref": "RS-2026-00481",
            "invoice_ref": "FT-2026/1187",
            "confidence": 0.9,
            "raw_notes": "shortage and promo price on same order",
            "issues": [
                {
                    "claim_type": "shortage",
                    "product": "Arborio 1kg",
                    "quantity": 12,
                    "amount": 186.0,
                    "notes": "12 cartons short",
                },
                {
                    "claim_type": "pricing",
                    "product": "Arborio 1kg",
                    "quantity": 28,
                    "amount": 10.08,
                    "notes": "promo 1.49 vs list on remaining",
                },
            ],
        }
    )
    assert len(result.issues) == 2
    assert result.claim_type is ClaimType.SHORTAGE
    assert result.amount == 186.0
    assert result.issues[1].claim_type is ClaimType.PRICING
    assert result.issues[1].amount == 10.08
    scoped = scoped_extraction(result, result.issues[1])
    assert scoped.claim_type is ClaimType.PRICING
    assert scoped.amount == 10.08
    assert len(scoped.issues) == 1


def test_parse_extraction_per_issue_pricing_refine() -> None:
    result = parse_extraction(
        {
            "order_ref": "RS2026/771",
            "invoice_ref": "334",
            "confidence": 0.6,
            "raw_notes": "two lines",
            "issues": [
                {
                    "claim_type": "shortage",
                    "product": "Arborio",
                    "quantity": 5,
                    "amount": 77.5,
                    "notes": "",
                },
                {
                    "claim_type": "other",
                    "product": "Arborio",
                    "quantity": 100,
                    "amount": 70.0,
                    "notes": "Remittance PRI/UNK; price hold 70",
                },
            ],
        }
    )
    assert result.issues[0].claim_type is ClaimType.SHORTAGE
    assert result.issues[1].claim_type is ClaimType.PRICING


def test_parse_extraction_rejects_invented_blank_refs() -> None:
    result = parse_extraction(
        {
            "order_ref": "  ",
            "invoice_ref": "n/a",
            "product": None,
            "quantity": None,
            "amount": None,
            "claim_type": "weird_type",
            "confidence": 2.5,
            "raw_notes": "ambiguous",
        }
    )
    assert result.order_ref is None
    assert result.invoice_ref is None
    assert result.claim_type is ClaimType.OTHER
    assert result.confidence == 1.0


def test_read_claim_uses_injected_grok_caller() -> None:
    def fake_grok(_text: str) -> dict:
        return {
            "order_ref": "PO77821",
            "invoice_ref": "INV2026-0891",
            "product": "Basmati 500g",
            "quantity": 200,
            "amount": 72.0,
            "claim_type": "pricing",
            "confidence": 0.88,
            "raw_notes": "promo price variance",
        }

    out = read_claim("dummy email body", grok_caller=fake_grok)
    assert out.claim_type is ClaimType.PRICING
    assert out.amount == 72.0
    assert out.to_dict()["claim_type"] == "pricing"


def test_read_claim_missing_key_fails_clearly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)
    with pytest.raises(MissingApiKeyError, match="XAI_API_KEY or GROK_API_KEY"):
        read_claim("Buongiorno, contestiamo la fattura.")


def test_fixtures_exist_and_load() -> None:
    expected = [
        "01_shortage_messy_it.txt",
        "02_pricing_promo_en.txt",
        "03_damage_it.txt",
        "04_short_payment_incomplete.txt",
        "05_ambiguous_otif_or_shortage.txt",
        "07_shortage_and_pricing.txt",
    ]
    assert FIXTURES.is_dir()
    for name in expected:
        text = load_claim_file(FIXTURES / name)
        assert len(text.strip()) > 40


def test_read_claim_on_shortage_fixture_with_mock() -> None:
    text = load_claim_file(FIXTURES / "01_shortage_messy_it.txt")

    def fake_grok(claim: str) -> dict:
        assert "mancano" in claim.lower() or "colli" in claim.lower()
        return {
            "order_ref": "RS-2026-00481",
            "invoice_ref": "FT-2026/1187",
            "product": "Riso Scotti Arborio 1kg",
            "quantity": 12,
            "amount": 186.0,
            "claim_type": "shortage",
            "confidence": 0.9,
            "raw_notes": "spacing typo in PO",
        }

    out = read_claim(text, grok_caller=fake_grok)
    assert out.claim_type is ClaimType.SHORTAGE
    assert out.order_ref == "RS-2026-00481"
    assert out.invoice_ref == "FT-2026/1187"


def test_cli_dry_run(capsys: pytest.CaptureFixture[str]) -> None:
    path = FIXTURES / "03_damage_it.txt"
    code = main(["--dry-run", str(path)])
    assert code == 0
    captured = capsys.readouterr()
    assert "Dry-run" in captured.out
    assert "danneggiata" in captured.out.lower() or "danneggiati" in captured.out.lower()


def test_cli_missing_key(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)
    path = FIXTURES / "02_pricing_promo_en.txt"
    code = main([str(path)])
    assert code == 1
    err = capsys.readouterr().err
    assert "XAI_API_KEY" in err or "GROK_API_KEY" in err


def test_remittance_pri_unk_maps_to_pricing() -> None:
    result = parse_extraction(
        {
            "order_ref": "RS2026/771",
            "invoice_ref": "334",
            "product": "Arborio sottovuoto",
            "quantity": 100,
            "amount": 70.0,
            "claim_type": "other",
            "confidence": 0.55,
            "raw_notes": "Remittance PRI/UNK; price hold 70",
        }
    )
    assert result.claim_type is ClaimType.PRICING


def test_refine_claim_type_uses_claim_text_short_pay() -> None:
    assert (
        refine_claim_type(
            ClaimType.OTHER,
            claim_text="REMITTANCE ADVICE\nInvoice paid short.\nUnit price hold",
        )
        is ClaimType.PRICING
    )
    assert refine_claim_type(ClaimType.SHORTAGE, raw_notes="PRI/UNK") is ClaimType.SHORTAGE


def test_fixture_04_is_pricing() -> None:
    path = Path(__file__).resolve().parents[1] / "data" / "disputes" / "extractions" / "04_short_payment.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["claim_type"] == "pricing"
    assert parse_extraction(payload).claim_type is ClaimType.PRICING


def test_model_default_is_current(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XAI_MODEL", raising=False)
    monkeypatch.delenv("GROK_MODEL", raising=False)
    assert DEFAULT_XAI_MODEL == "grok-4-latest"
    assert _model() == "grok-4-latest"


def test_model_env_override_prefers_xai(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XAI_MODEL", "grok-3")
    monkeypatch.setenv("GROK_MODEL", "ignored-when-xai-set")
    assert _model() == "grok-3"
    monkeypatch.delenv("XAI_MODEL")
    assert _model() == "ignored-when-xai-set"


def test_cli_live_with_mocked_api(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("XAI_API_KEY", "test-key")

    def fake_call(claim_text: str, *, api_key: str) -> dict:
        assert api_key == "test-key"
        assert "Basmati" in claim_text or "promo" in claim_text.lower()
        return {
            "order_ref": "PO77821",
            "invoice_ref": "INV2026-0891",
            "product": "Scotti Basmati 500g",
            "quantity": 200,
            "amount": 72,
            "claim_type": "pricing",
            "confidence": 0.87,
            "raw_notes": "",
        }

    monkeypatch.setattr("dispute.claim_reader.call_grok", fake_call)
    path = FIXTURES / "02_pricing_promo_en.txt"
    code = main([str(path)])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["claim_type"] == "pricing"
    assert payload["amount"] == 72.0
