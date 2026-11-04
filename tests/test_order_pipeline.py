"""Tests for order availability, contract price checks, and pipeline gates."""

from __future__ import annotations

from pathlib import Path

from order.availability import AvailabilityQuery, StubAvailabilityProvider
from order.contract import check_prices, load_contract
from order.pipeline import PipelineStatus, run_order_file
from order.parser import parse_orders_file

EDI = Path(__file__).resolve().parents[1] / "data" / "orders" / "edi"


def test_availability_stub_caps_stock() -> None:
    provider = StubAvailabilityProvider()
    hit = provider.get_availability(
        AvailabilityQuery("8000000000000", "BUYER001", "SUPPLIER001", "20261104")
    )
    assert hit.found
    assert hit.available_qty == 25000


def test_volume_discount_price() -> None:
    contract = load_contract()
    # 20000 units → discount 1.70
    assert contract.expected_unit_price("8000000000000", 20000) == 1.70
    assert contract.expected_unit_price("8000000000000", 100) == 1.85


def test_clean_order_awaits_confirm_then_ordrsp() -> None:
    waiting = run_order_file(EDI / "ordine_ess_001.edi")
    assert waiting.status == PipelineStatus.AWAIT_CONFIRM_SIGNOFF
    done = run_order_file(EDI / "ordine_ess_001.edi", confirm=True)
    assert done.status == PipelineStatus.READY_ORDRSP
    assert done.ordrsp is not None
    assert "ORDRSP" in done.ordrsp.body
    assert done.ordrsp.handoff["order_number"] == "ESS001"


def test_volume_discount_fixture_confirms() -> None:
    result = run_order_file(EDI / "ordine_ess_discount_ok.edi", confirm=True)
    assert result.status == PipelineStatus.READY_ORDRSP
    assert result.price_check is not None and result.price_check.ok


def test_messy_awaits_grok_parse() -> None:
    result = run_order_file(EDI / "ordine_ess_messy.edi")
    assert result.status == PipelineStatus.AWAIT_GROK_PARSE


def test_short_awaits_grok_qty() -> None:
    result = run_order_file(EDI / "ordine_ess_short.edi")
    assert result.status == PipelineStatus.AWAIT_GROK_QTY
    assert result.availability
    assert not result.availability[0].ok


def test_bad_price_draft_mail_not_confirm_signoff() -> None:
    result = run_order_file(EDI / "ordine_ess_bad_price.edi")
    assert result.status == PipelineStatus.AWAIT_PRICE_HUMAN
    assert result.draft_mail is not None
    assert "Price discrepancy" in result.draft_mail
    assert "Draft — review and send manually" in result.draft_mail
    assert result.status != PipelineStatus.AWAIT_CONFIRM_SIGNOFF


def test_price_check_skips_missing_pri() -> None:
    parsed = parse_orders_file(EDI / "ordine_ess_messy.edi")
    # messy has flags; still check helper ignores None price
    check = check_prices(lines=[{"gtin": "8000000000000", "quantity": 10, "unit_price": None}])
    assert check.ok
    assert check.lines[0].reason == "no_PRI_on_order"
