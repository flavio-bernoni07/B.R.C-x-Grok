"""Shipping and invoicing: hand-over in, dispatch, invoice, reconcile, hand-over to Dispute,
and the v0.5.0 rules (trucks, scans, exception cases) from Nicola's write-up."""

from __future__ import annotations

from pathlib import Path

import pytest

from core.stock import available_to_promise, record_event
from core.world import fresh_erp
from dispute.mini_erp import MiniErpStore
from dispute.pull_facts import pull_facts
from order.service import confirm_order, receive_order
from shipping import cases, warehouse as wh
from shipping.reconcile import reconcile_documents
from shipping.service import (ShippingError, export_for_dispute, ingest_confirmed_order, invoice_shipment,
                              record_delivery, reconcile_and_send, ship_order)

CAR = "8000000000001"


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)


def _ready(erp, ref: str = "ESS-GOLD-001", qty: int = 12000, price: float = 2.20) -> dict:
    edi = (f"UNH+1+ORDERS:D:96A:UN'BGM+220+{ref}+9'DTM+137:20261104:102'NAD+BY+BUYER001::9'"
           f"NAD+SU+SUPPLIER001::9'LIN+1++{CAR}:EN'QTY+21:{qty}'PRI+AAA:{price}:CT'UNS+S'UNT+10+1'")
    r = receive_order(erp, edi)
    handoff = confirm_order(erp, r["case_id"], by="Giulia", reason="ok")
    ingest_confirmed_order(erp, handoff)
    return handoff


def test_handover_needs_a_confirmed_order_with_its_ordrsp() -> None:
    erp = fresh_erp()
    r = receive_order(erp, (Path(__file__).resolve().parents[1] / "data/world/golden/ORDERS_ESS-GOLD-001.edi").read_text())
    with pytest.raises(ShippingError):
        ingest_confirmed_order(erp, {"order_number": "ESS-GOLD-001", "ordrsp_ref": "x", "lines": []})
    handoff = confirm_order(erp, r["case_id"], by="Giulia", reason="ok")
    bad = dict(handoff, lines=[dict(handoff["lines"][0], quantity=99)])
    with pytest.raises(ShippingError):
        ingest_confirmed_order(erp, bad)
    assert ingest_confirmed_order(erp, handoff) == "ESS-GOLD-001"


def test_held_stock_never_ships_and_the_invoice_bills_what_shipped() -> None:
    erp = fresh_erp()
    _ready(erp)
    record_event(erp, "quality_hold", batch="LOT-C-0418", qty=1200)
    s = ship_order(erp, "ESS-GOLD-001", ship_date="2026-11-05")
    assert sum(l["qty"] for l in s["lines"]) == 10800
    assert "quality hold on LOT-C-0418-HOLD" in s["short"][0]
    inv = invoice_shipment(erp, s["desadv_ref"], invoice_date="2026-11-05")
    assert (inv["net"], inv["vat"], inv["total"]) == (23760.0, 950.4, 24710.4)
    xml = erp.document(inv["td01_doc"])["body"]
    assert "<TipoDocumento>TD01</TipoDocumento>" in xml and "DEMO FatturaPA TD01" in xml
    assert "BGM+380+FT-2026/0001" in erp.document(inv["invoic_doc"])["body"]
    with pytest.raises(ShippingError):
        invoice_shipment(erp, s["desadv_ref"], invoice_date="2026-11-05")


def test_short_delivery_with_a_cause_goes_out_and_is_followed_up() -> None:
    erp = fresh_erp()
    _ready(erp)
    record_event(erp, "quality_hold", batch="LOT-C-0418", qty=1200)
    s = ship_order(erp, "ESS-GOLD-001", ship_date="2026-11-05")
    invoice_shipment(erp, s["desadv_ref"], invoice_date="2026-11-05")
    rec = reconcile_and_send(erp, "ESS-GOLD-001")
    assert rec["status"] == "sent" and rec["report"]["causes"] == ["short_delivery"]
    assert erp.invoices("ESS-GOLD-001")[0]["status"] == "sent"
    assert "1200 of 12000" in rec["follow_up"]


def test_a_billing_error_holds_the_invoice_for_a_person() -> None:
    erp = fresh_erp()
    _ready(erp, qty=1000, price=2.40)
    s = ship_order(erp, "ESS-GOLD-001", ship_date="2026-11-05")
    inv = invoice_shipment(erp, s["desadv_ref"], invoice_date="2026-11-05")
    erp.db.execute("UPDATE invoice_lines SET unit_price = 2.60 WHERE invoice_ref = ?", (inv["invoice_ref"],))
    erp.db.commit()
    rec = reconcile_and_send(erp, "ESS-GOLD-001")
    assert rec["status"] == "awaiting_person"
    case = erp.signoff(rec["case_id"])
    assert case["row"] == "shipping" and case["reasons"] == ["billing error found: price_difference"]
    assert erp.invoices("ESS-GOLD-001")[0]["status"] == "draft"


def test_grok_explanation_cannot_add_figures() -> None:
    from shipping.service import explain_flags

    text, by = explain_flags("price €2.60 against €2.40 (€200.00)", "notes: none",
                             caller=lambda m: {"explanation": "Gap of €999", "confidence": 0.9})
    assert by == "code"
    text, by = explain_flags("price €2.60 against €2.40 (€200.00)", "notes: none",
                             caller=lambda m: {"explanation": "Invoice at €2.60 instead of €2.40: €200.00 too much"})
    assert by == "grok"


def test_export_feeds_dispute_pull_facts() -> None:
    erp = fresh_erp()
    _ready(erp)
    s = ship_order(erp, "ESS-GOLD-001", ship_date="2026-11-05")
    invoice_shipment(erp, s["desadv_ref"], invoice_date="2026-11-05")
    record_delivery(erp, s["desadv_ref"], signed_by="CeDi Melzo", received={CAR: 11760}, note="1 pallet missing")
    store = MiniErpStore.from_dict(export_for_dispute(erp))
    facts = pull_facts({"order_ref": "ESS GOLD 001", "invoice_ref": "FT-2026-0001", "product": "Carnaroli",
                        "quantity": 240, "amount": 528, "claim_type": "shortage", "confidence": 0.9,
                        "raw_notes": ""}, store=store)
    assert not facts.misses
    assert facts.invoice["invoice_ref"] == "FT-2026/0001"
    assert any(p["kind"] == "pod" and "with reservation" in p["summary"] for p in facts.proofs)
    assert facts.threeway.summary == {"matched": 1}


def test_reconcile_links_a_one_character_typo_but_not_an_ambiguous_one() -> None:
    po = [{"order_ref": "RS-26-1100", "item_code": "ARB-1KG-CTN12", "quantity": 40, "unit_price": 15.5},
          {"order_ref": "RS-26-1101", "item_code": "ARB-1KG-CTN12", "quantity": 40, "unit_price": 15.5}]
    rec = [{"order_ref": "RS-26-1100", "item_code": "ARB-1KG-CTN12", "quantity": 40},
           {"order_ref": "RS-26-1101", "item_code": "ARB-1KG-CTN12", "quantity": 40}]
    inv = [{"order_ref": "RS-26-1100", "item_code": "ARB-1KG-CTN12", "quantity": 40, "unit_price": 15.5},
           {"order_ref": "RS-26-110", "item_code": "ARB-1KG-CTN12", "quantity": 40, "unit_price": 15.5}]
    report = reconcile_documents(po, rec, inv)
    assert "orphan_invoice" in report.causes
    assert any("several orders" in n for n in report.notes)


# ----- v0.5.0: trucks, scans, exception cases --------------------------------

def _trucks(erp, *items):
    wh.register_trucks(erp, [{"truck_id": t, "plate": f"PL{i}", "destination": "CeDi Melzo", "pallet_capacity": cap,
                              "max_payload_kg": kg} for i, (t, cap, kg) in enumerate(items)])


def test_capacity_case_end_to_end_like_section_9() -> None:
    erp = fresh_erp()
    _ready(erp, "ORD-1081", 1920, 2.40)  # 2 pallets of 960
    _trucks(erp, ("TRUCK-SMALL", 1, 24000))
    plan = wh.plan_truck_loads(erp, ["ORD-1081"])
    assert not plan["planned"] and plan["exceptions"][0]["type"] == "TRUCK_CAPACITY_EXCEEDED"
    case_id = cases.open_exception_cases(erp, plan["exceptions"])[0]
    case = cases.view_exception_case(erp, case_id)
    assert case["role"] == "transport_planner"
    assert [a["action"] for a in case["possible_actions"]] == ["PLAN_ON_TRUCK", "REQUEST_CLARIFICATION"]
    assert not any(a["selected"] for a in case["possible_actions"])
    assert cases.submit_resolution_proposal(erp, case_id, {"actions": [
        {"action": "PLAN_ON_TRUCK", "params": {"truck_id": "TRUCK-SMALL"}}]})["status"] == "rejected"
    _trucks(erp, ("TRUCK-WIDE", 2, 24000))
    good = cases.submit_resolution_proposal(erp, case_id, {"actions": [
        {"action": "PLAN_ON_TRUCK", "params": {"truck_id": "TRUCK-WIDE"}}]})
    assert good["status"] == "validated"
    with pytest.raises(ValueError):
        cases.execute_resolution(erp, case_id)
    with pytest.raises(ValueError):
        cases.decide_resolution(erp, case_id, employee_id="E1", role="warehouse_lead", decision="approve", reason="x")
    cases.decide_resolution(erp, case_id, employee_id="EMP-PLANNER-01", role="transport_planner",
                            decision="approve", reason="TRUCK-WIDE has room")
    assert cases.execute_resolution(erp, case_id)["status"] == "EXECUTED"
    assert cases.execute_resolution(erp, case_id)["status"] == "DUPLICATE_EXECUTION"
    assert cases.recheck_exception_case(erp, case_id)["resolution"] == "resolved"
    m = wh.manifest_for_order(erp, "ORD-1081")
    assert m["truck_id"] == "TRUCK-WIDE" and m["dispatched"] is False
    assert not erp.shipments("ORD-1081")  # planning writes no shipment
    assert erp.signoffs(row="shipping")[0]["status"] == "approved"


def test_forbidden_actions_are_rejected_whatever_the_template() -> None:
    erp = fresh_erp()
    _ready(erp, "ORD-1", 960, 2.40)
    exc = wh.record_exception(erp, type="QUALITY_HOLD", severity="high", order_ref="ORD-1", explanation="hold")
    case_id = cases.open_exception_cases(erp, [exc])[0]
    for bad in ("RELEASE_QUALITY_HOLD", "ISSUE_CREDIT_NOTE", "EDIT_AMOUNT", "UNBLOCK_DISPATCH"):
        result = cases.submit_resolution_proposal(erp, case_id, {"actions": [{"action": bad}]})
        assert result["status"] == "rejected" and "never allowed" in result["problems"][0]


def test_missing_product_data_stops_the_plan() -> None:
    erp = fresh_erp()
    _ready(erp, "ORD-2", 960, 2.40)
    erp.db.execute("UPDATE products SET unit_weight_kg = NULL WHERE gtin = ?", (CAR,))
    erp.db.commit()
    _trucks(erp, ("T1", 33, 24000))
    plan = wh.plan_truck_loads(erp, ["ORD-2"])
    assert plan["exceptions"][0]["type"] == "PLAN_MISSING_PRODUCT_DATA"


def test_scans_catch_wrong_truck_duplicate_batch_and_hold() -> None:
    erp = fresh_erp()
    _ready(erp, "ORD-3", 6960, 2.40)  # 8 pallets: 7 from LOT-C-0417, the last from LOT-C-0418
    _trucks(erp, ("T1", 33, 24000), ("T2", 33, 24000))
    wh.plan_truck_loads(erp, ["ORD-3"])
    picked = wh.create_picking_list(erp, "ORD-3")
    p1, p2, p3 = picked[0], picked[1], picked[-1]
    assert p1["batch"] == "LOT-C-0417" and p3["batch"] == "LOT-C-0418"
    assert available_to_promise(erp, CAR)["released"] == 12000  # picking moves no stock
    scan = lambda p, **kw: {"pallet_id": p["pallet_id"], "gtin": p["gtin"], "batch": p["batch"], "qty": p["qty"],
                            "truck_id": "T1", **kw}
    record_event(erp, "quality_hold", batch=p3["batch"])
    res = wh.verify_scans(erp, "ORD-3", [scan(p1, truck_id="T2"), scan(p2), scan(p2), scan(p3)])
    assert [r["result"] for r in res["results"]] == ["WRONG_TRUCK", "OK", "DUPLICATE_SCAN", "QUALITY_HOLD"]
    loading = wh.confirm_loading(erp, "ORD-3")
    assert loading["pallets"] == [p2["pallet_id"]]
    assert {e["type"] for e in loading["exceptions"]} == {"MISSING_PALLET"}
    missing = [e for e in loading["exceptions"] if e["pallet_id"] == p1["pallet_id"]]
    case_id = cases.open_exception_cases(erp, missing)[0]
    cases.submit_resolution_proposal(erp, case_id, {"actions": [{"action": "REQUEST_CLARIFICATION",
                                                                 "params": {"question": "where is it?"}}]})
    cases.decide_resolution(erp, case_id, employee_id="E", role="warehouse_lead", decision="approve", reason="ask")
    cases.execute_resolution(erp, case_id)
    assert cases.recheck_exception_case(erp, case_id)["resolution"] == "unresolved"  # only recorded
    with pytest.raises(ValueError):
        wh.cancel_truck_plan(erp, "ORD-3")  # locked once a loading record exists


def test_dispatch_needs_the_planned_truck_and_checks_holds_again() -> None:
    erp = fresh_erp()
    _ready(erp, "ORD-4", 1920, 2.40)
    _trucks(erp, ("T1", 33, 24000), ("T2", 33, 24000))
    wh.plan_truck_loads(erp, ["ORD-4"])
    pallets = wh.create_picking_list(erp, "ORD-4")
    wh.verify_scans(erp, "ORD-4", [{"pallet_id": p["pallet_id"], "gtin": p["gtin"], "batch": p["batch"],
                                    "qty": p["qty"], "truck_id": "T1"} for p in pallets])
    wh.confirm_loading(erp, "ORD-4")
    wrong = wh.authorize_dispatch(erp, "ORD-4", ship_date="2026-11-05", truck_id="T2")
    assert wrong["dispatched"] is False and wrong["exceptions"][0]["type"] == "WRONG_TRUCK"
    record_event(erp, "quality_hold", batch=pallets[1]["batch"], qty=500)  # partial hold after loading
    ok = wh.authorize_dispatch(erp, "ORD-4", ship_date="2026-11-05")
    assert ok["dispatched"] and ok["truck_id"] == "T1" and ok["manifest_id"]
    assert erp.order("ORD-4")["notes"]["truck_id"] == "T1"


def test_quality_hold_case_replaces_the_batch() -> None:
    erp = fresh_erp()
    _ready(erp, "ORD-5", 960, 2.40)
    _trucks(erp, ("T1", 33, 24000))
    wh.plan_truck_loads(erp, ["ORD-5"])
    (p,) = wh.create_picking_list(erp, "ORD-5")
    record_event(erp, "quality_hold", batch=p["batch"])
    res = wh.verify_scans(erp, "ORD-5", [{"pallet_id": p["pallet_id"], "gtin": p["gtin"], "batch": p["batch"],
                                          "qty": p["qty"], "truck_id": "T1"}])
    case_id = cases.open_exception_cases(erp, res["exceptions"])[0]
    package = cases.grok_case_package(erp, case_id)
    assert "RELEASE_QUALITY_HOLD" in package["never_allowed"] and package["facts"]["released_batches"]
    other = package["facts"]["released_batches"][0]["batch"]
    proposal = cases.propose_with_grok(erp, case_id, caller=lambda m: {
        "actions": [{"action": "REPLACE_BATCH", "params": {"batch": other}}], "rationale": "same product, released",
        "confidence": 0.8})
    assert proposal["status"] == "validated" and proposal["by"] == "grok"
    cases.decide_resolution(erp, case_id, employee_id="Q1", role="quality_manager", decision="approve", reason="ok")
    cases.execute_resolution(erp, case_id)
    assert cases.recheck_exception_case(erp, case_id)["resolution"] == "resolved"
