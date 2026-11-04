"""Unit tests for dispute.pull_facts — no network, no API key."""

from __future__ import annotations

import json
from pathlib import Path

from dispute.claim_reader import ClaimExtraction, ClaimType
from dispute.mini_erp import MiniErpStore, normalize_ref
from dispute.pull_facts import load_claim_json, main, pull_facts

ROOT = Path(__file__).resolve().parents[1]
EXTRACTIONS = ROOT / "data" / "disputes" / "extractions"
CATALOG = ROOT / "data" / "disputes" / "erp" / "catalog.json"


def test_normalize_ref_collapses_noise() -> None:
    assert normalize_ref("RS-2026-00481") == "RS202600481"
    assert normalize_ref("INV 2026-0891") == "INV20260891"
    # Messy "PO RS 2026 00481" still matches via substring / aliases in MiniErpStore.
    assert normalize_ref("RS-2026-00481") in normalize_ref("PO RS 2026 00481")


def test_pull_facts_shortage_flags_qty_gap() -> None:
    claim = load_claim_json(EXTRACTIONS / "01_shortage.json")
    facts = pull_facts(claim)
    assert facts.order is not None
    assert facts.desadv is not None
    assert facts.invoice is not None
    assert facts.misses == []
    assert facts.threeway is not None
    line = facts.threeway.lines[0]
    assert line.status == "exception"
    assert line.received == 28
    assert line.invoiced == 40
    assert "Billed for more than was received" in line.reason or "Short delivery" in line.reason
    assert any(p.get("kind") == "warehouse_event" for p in facts.proofs)
    assert any(p.get("kind") == "ddt" for p in facts.proofs)


def test_pull_facts_shortage_reconcile_names_both_causes() -> None:
    """Baseline threeway gives one reason; Shipping reconcile names overbilled + short_delivery."""
    claim = load_claim_json(EXTRACTIONS / "01_shortage.json")
    facts = pull_facts(claim)
    assert facts.reconcile is not None
    assert facts.reconcile.source.startswith("shipping.reconcile")
    assert facts.reconcile.status == "exception"
    causes = set(facts.reconcile.causes)
    assert "overbilled" in causes
    assert "short_delivery" in causes
    # Baseline keeps a single reason string — the improved view is what verdicts should cite.
    assert facts.threeway is not None
    assert len(facts.threeway.lines[0].reason.split(";")) == 1 or "and" not in facts.threeway.lines[0].reason.lower()
    payload = facts.to_dict()
    assert payload["reconcile"]["causes"] == sorted(causes)
    assert any(c["code"] == "overbilled" for c in payload["reconcile"]["lines"][0]["causes"])


def test_pull_facts_pricing_flags_price() -> None:
    claim = load_claim_json(EXTRACTIONS / "02_pricing.json")
    facts = pull_facts(claim)
    assert facts.order["order_ref"] == "PO77821"
    assert facts.invoice["invoice_ref"] == "INV2026-0891"
    assert facts.threeway is not None
    line = facts.threeway.lines[0]
    assert line.status == "exception"
    assert line.reason == "Invoice price differs from the PO price"
    assert any(p.get("kind") == "contract_excerpt" for p in facts.proofs)


def test_pull_facts_damage_recovers_invoice_by_order() -> None:
    claim = load_claim_json(EXTRACTIONS / "03_damage.json")
    assert claim.invoice_ref is None
    facts = pull_facts(claim)
    assert facts.order["order_ref"] == "RS-ORD-99102"
    assert facts.invoice is not None
    assert facts.invoice["invoice_ref"] == "FT-2026/2201"
    assert facts.threeway is not None
    assert facts.threeway.lines[0].status == "matched"
    assert any(p.get("ref") == "4521" for p in facts.proofs)


def test_pull_facts_short_payment_fragment_invoice() -> None:
    claim = load_claim_json(EXTRACTIONS / "04_short_payment.json")
    facts = pull_facts(claim)
    assert facts.invoice is not None
    assert facts.invoice["invoice_ref"] == "FT-2026/0334"
    assert facts.threeway is not None
    assert facts.threeway.lines[0].reason == "Invoice price differs from the PO price"
    assert abs(facts.threeway.lines[0].value_variance - 70.0) < 0.01
    assert facts.claim["claim_type"] == "pricing"


def test_pull_facts_maps_other_to_pricing_on_price_gap() -> None:
    claim = ClaimExtraction(
        order_ref="RS2026/771",
        invoice_ref="334",
        product="Riso Scotti Arborio sottovuoto 1kg",
        quantity=100,
        amount=70.0,
        claim_type=ClaimType.OTHER,
        confidence=0.4,
        raw_notes="portal blank type",
    )
    facts = pull_facts(claim)
    assert facts.claim["claim_type"] == "pricing"
    assert "threeway price gap" in facts.claim["raw_notes"]


def test_pull_facts_ambiguous_resolves_alias() -> None:
    claim = load_claim_json(EXTRACTIONS / "05_ambiguous.json")
    facts = pull_facts(claim)
    assert facts.order["order_ref"] == "RS26112"
    assert facts.desadv is not None
    assert facts.invoice is not None
    assert facts.threeway is not None
    # short ship 28 vs order 30, invoice 28 → short delivery vs order / matched GRN-INV
    statuses = {line.status for line in facts.threeway.lines}
    assert "exception" in statuses or "check" in statuses or "matched" in statuses
    assert any("OTIF" in (p.get("summary") or "") or p.get("kind") == "warehouse_event" for p in facts.proofs)


def test_pull_facts_lookup_miss_when_unknown_order() -> None:
    claim = ClaimExtraction(
        order_ref="DOES-NOT-EXIST",
        invoice_ref=None,
        product=None,
        quantity=None,
        amount=None,
        claim_type=ClaimType.OTHER,
        confidence=0.1,
        raw_notes="unknown",
    )
    facts = pull_facts(claim)
    assert facts.order is None
    assert facts.threeway is None
    kinds = {m.kind for m in facts.misses}
    assert "order" in kinds


def test_cli_on_extraction(capsys) -> None:
    code = main([str(EXTRACTIONS / "01_shortage.json")])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["order"]["order_ref"] == "RS-2026-00481"
    assert payload["threeway"]["summary"]["exception"] >= 1
    assert payload["catalog_path"]


def test_catalog_covers_all_claim_order_refs() -> None:
    store = MiniErpStore.load(CATALOG)
    expected = {
        "RS-2026-00481",
        "PO77821",
        "RS-ORD-99102",
        "RS2026/771",
        "RS26112",
        "RS26113",
    }
    found = {o["order_ref"] for o in store.orders}
    assert expected <= found
