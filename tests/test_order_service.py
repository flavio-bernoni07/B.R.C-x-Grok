"""Order row on the Mini ERP, with the Grokbot loops of order-dec.md."""

from __future__ import annotations

from pathlib import Path

import pytest

from core.stock import record_event
from core.world import fresh_erp
from order import grokbot
from order.service import confirm_order, receive_order, reject_order, resolve_price_case

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = (ROOT / "data" / "world" / "golden" / "ORDERS_ESS-GOLD-001.edi").read_text()
EDI = ROOT / "data" / "orders" / "edi"


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)


def _edi(ref: str, gtin: str, qty: int, price: float) -> str:
    return (f"UNH+1+ORDERS:D:96A:UN'BGM+220+{ref}+9'DTM+137:20261104:102'NAD+BY+BUYER001::9'"
            f"NAD+SU+SUPPLIER001::9'LIN+1++{gtin}:EN'QTY+21:{qty}'PRI+AAA:{price}:CT'UNS+S'UNT+10+1'")


def test_clean_order_still_waits_for_a_person_then_hands_over() -> None:
    erp = fresh_erp()
    r = receive_order(erp, GOLDEN)
    assert r["step"] == "confirm"
    assert erp.order("ESS-GOLD-001")["status"] == "awaiting_confirmation"
    case = erp.signoff(r["case_id"])
    assert case["reasons"] == ["Order rule: a person confirms every order before ORDRSP"]
    handoff = confirm_order(erp, r["case_id"], by="Giulia", reason="checks pass")
    assert handoff["order_number"] == "ESS-GOLD-001"
    assert handoff["lines"] == [{"line_no": 1, "gtin": "8000000000001", "quantity": 12000.0, "unit_price": 2.2}]
    assert erp.order("ESS-GOLD-001")["status"] == "confirmed"
    assert "BGM+231+ESS-GOLD-001" in erp.document(handoff["ordrsp_ref"])["body"]


def test_confirmed_orders_reduce_what_the_next_order_can_get() -> None:
    erp = fresh_erp()
    r = receive_order(erp, GOLDEN)
    confirm_order(erp, r["case_id"], by="Giulia", reason="ok")
    r2 = receive_order(erp, _edi("ESS-NEXT", "8000000000001", 12000, 2.20))
    assert r2["step"] != "confirm"  # the first order took the released stock


def test_short_stock_split_on_planned_batch_reenters_the_stock_check() -> None:
    erp = fresh_erp()
    record_event(erp, "quality_hold", batch="LOT-C-0418", qty=1200)
    r = receive_order(erp, _edi("ESS-SPLIT", "8000000000001", 12000, 2.20))
    assert r["step"] == "confirm"
    case = erp.signoff(r["case_id"])
    assert case["proposal"]["backorders"] == [{"line_no": 1, "gtin": "8000000000001", "qty": 1200, "date": "2026-11-09"}]
    assert case["proposal"]["lines"][0]["qty_confirmed"] == 10800
    assert any("stock was short on line 1: split proposed by code" in x for x in case["reasons"])


def test_wrong_price_goes_to_the_price_step_not_the_confirm_step() -> None:
    erp = fresh_erp()
    r = receive_order(erp, (EDI / "ordine_ess_bad_price.edi").read_text())
    assert r["step"] == "price_fix"
    assert erp.order(r["order_ref"])["status"] == "pending_price"
    assert "€2.5" in erp.signoff(r["case_id"])["reasons"][0]
    parked = resolve_price_case(erp, r["case_id"], by="Giulia", reason="wait for Esselunga")
    assert parked["status"] == "parked" and erp.order(r["order_ref"])["status"] == "pending"


def test_manual_edi_goes_back_to_parse() -> None:
    erp = fresh_erp()
    r = receive_order(erp, (EDI / "ordine_ess_bad_price.edi").read_text())
    fixed = (EDI / "ordine_ess_bad_price.edi").read_text().replace("PRI+AAA:2.50", "PRI+AAA:1.85")
    again = resolve_price_case(erp, r["case_id"], by="Giulia", reason="retailer confirmed 1.85", manual_edi=fixed)
    assert again["step"] == "confirm"


def test_unreadable_edi_without_grok_goes_to_a_person() -> None:
    erp = fresh_erp()
    r = receive_order(erp, (EDI / "ordine_ess_messy.edi").read_text())
    assert r["step"] == "manual_edi"


def test_grok_parse_fix_is_parsed_again_and_shown_to_the_person() -> None:
    erp = fresh_erp()
    messy = (EDI / "ordine_ess_messy.edi").read_text()
    fixed = messy.replace("2026-11-04", "20261104").replace("20.000", "20000").strip()

    def caller(_messages):
        return {"corrected_edi": fixed, "confidence": 0.8,
                "changes": [{"segment": "QTY", "before": "20.000", "after": "20000", "why": "IT thousands"}]}

    r = receive_order(erp, messy, caller=caller)
    assert r["step"] == "confirm"
    assert any("Grok corrected the EDI: QTY: 20.000 -> 20000" in x for x in erp.signoff(r["case_id"])["reasons"])


def test_grok_cannot_put_new_figures_in_the_qty_message() -> None:
    def liar(_messages):
        return {"action": "split", "message": "Vi mandiamo 9999 pezzi", "confidence": 0.9}

    out = grokbot.propose_qty_resolution(order_ref="X", gtin="1", product="P", buyer="B", ordered=100,
                                         available=60, next_date="2026-11-09", later_available=40, caller=liar)
    assert out["source"] == "code" and out["now_qty"] == 60 and out["later_qty"] == 40


def test_price_mail_keeps_every_figure() -> None:
    draft = "Order ESS003: ordered €1.85, contract €1.7 (qty 50000)"
    mail, by = grokbot.polish_price_mail(draft, caller=lambda m: {"mail": "Ordine ESS003: €1,85 contro €1,7, qty 50000"})
    assert by == "grok"
    mail, by = grokbot.polish_price_mail(draft, caller=lambda m: {"mail": "Ordine ESS003: prezzo €1.99"})
    assert by == "code" and mail == draft


def test_reject_order() -> None:
    erp = fresh_erp()
    r = receive_order(erp, GOLDEN)
    reject_order(erp, r["case_id"], by="Giulia", reason="duplicate of yesterday's order")
    assert erp.order("ESS-GOLD-001")["status"] == "rejected"


def test_confirm_checks_stock_again_when_two_orders_wait() -> None:
    erp = fresh_erp()
    first = receive_order(erp, GOLDEN)
    second = receive_order(erp, _edi("ESS-TWIN", "8000000000001", 12000, 2.20))
    assert second["step"] == "confirm"  # both passed the checks while neither was confirmed
    confirm_order(erp, first["case_id"], by="Giulia", reason="ok")
    with pytest.raises(ValueError, match="run the order again"):
        confirm_order(erp, second["case_id"], by="Giulia", reason="ok")
    assert erp.signoff(second["case_id"])["status"] == "pending"
