"""RECADV receiving gaps, and the checks Dispute settles in code: complaint window, duplicates."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from core.stock import record_event
from core.world import fresh_erp
from dispute.service import handle_claim, offline_callers
from order.service import confirm_order, receive_order
from shipping.receiving import parse_recadv, record_receiving_advice
from shipping.service import ingest_confirmed_order, invoice_shipment, record_delivery, ship_order

GOLDEN = Path(__file__).resolve().parents[1] / "data" / "world" / "golden"


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)


def _shipped():
    erp = fresh_erp()
    r = receive_order(erp, (GOLDEN / "ORDERS_ESS-GOLD-001.edi").read_text())
    ingest_confirmed_order(erp, confirm_order(erp, r["case_id"], by="Giulia", reason="ok"))
    record_event(erp, "quality_hold", batch="LOT-C-0418", qty=1200)
    s = ship_order(erp, "ESS-GOLD-001", ship_date="2026-11-05")
    invoice_shipment(erp, s["desadv_ref"], invoice_date="2026-11-05")
    record_delivery(erp, s["desadv_ref"], signed_by="CeDi Melzo", received={"8000000000001": 10560},
                    note="1 pallet mancante (240 pz)", when="2026-11-06")
    return erp


def test_parse_recadv() -> None:
    advice = parse_recadv((GOLDEN / "RECADV_ESS-GOLD-001.edi").read_text())
    assert advice["desadv_ref"] == "DESADV-ESS-GOLD-001-1" and advice["date"] == "2026-11-06"
    assert advice["lines"] == [{"gtin": "8000000000001", "accepted": 10560.0, "refused": 0.0, "received": 10560.0}]
    with pytest.raises(ValueError):
        parse_recadv("UNH+1+RECADV'BGM+632+X+9'")


def test_receiving_gap_is_known_before_the_claim() -> None:
    erp = _shipped()
    res = record_receiving_advice(erp, (GOLDEN / "RECADV_ESS-GOLD-001.edi").read_text())
    assert res["gaps"][0]["gap"] == 240 and res["gaps"][0]["eur"] == 528.0
    assert res["exceptions"][0]["type"] == "RECEIVING_GAP"
    assert any(p["kind"] == "recadv" for p in erp.proofs("ESS-GOLD-001"))


def _claim(erp, tmp_path, received_on):
    read_c, verdict_c = offline_callers(GOLDEN / "grok_offline.json")
    return handle_claim(erp, (GOLDEN / "claim_email.txt").read_text(), out_dir=tmp_path, read_caller=read_c,
                        verdict_caller=verdict_c, received_on=received_on)


def test_claim_inside_the_window_goes_through(tmp_path: Path) -> None:
    res = _claim(_shipped(), tmp_path, date(2026, 11, 7))
    assert res["status"] == "closed"
    assert res["verdict"]["checks"]["days_after_delivery"] == 1


def test_late_claim_goes_to_a_person(tmp_path: Path) -> None:
    res = _claim(_shipped(), tmp_path, date(2026, 12, 20))
    assert res["status"] == "awaiting_person"
    assert any("44 days after delivery" in r for r in res["verdict"]["sign_off_reasons"])
    assert not list(tmp_path.glob("*_TD04.xml"))


def test_second_claim_for_the_same_thing_goes_to_a_person(tmp_path: Path) -> None:
    erp = _shipped()
    first = _claim(erp, tmp_path, date(2026, 11, 7))
    second = _claim(erp, tmp_path / "again", date(2026, 11, 8))
    assert first["status"] == "closed" and second["status"] == "awaiting_person"
    assert any(f"claim {first['claim_id']}" in r for r in second["verdict"]["sign_off_reasons"])
