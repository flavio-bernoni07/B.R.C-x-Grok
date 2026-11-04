"""Receivables: remittances, credit-note matching, deductions turned into claims, aging."""

from __future__ import annotations

import json
import shutil
from datetime import date
from pathlib import Path

import pytest

from core.stock import record_event
from core.world import fresh_erp
from dispute.service import approve_verdict, handle_claim, offline_callers
from finance.receivables import aging, balance, parse_remadv, record_remittance
from order.service import confirm_order, receive_order
from shipping.service import ingest_confirmed_order, invoice_shipment, reconcile_and_send, record_delivery, ship_order

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = ROOT / "data" / "world" / "golden"
REMADV = (GOLDEN / "REMADV_ESS-GOLD-001.edi").read_text()


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)


def _invoiced(tmp_path: Path, with_credit: bool = True):
    erp = fresh_erp()
    r = receive_order(erp, (GOLDEN / "ORDERS_ESS-GOLD-001.edi").read_text())
    ingest_confirmed_order(erp, confirm_order(erp, r["case_id"], by="Giulia", reason="ok"))
    record_event(erp, "quality_hold", batch="LOT-C-0418", qty=1200)
    s = ship_order(erp, "ESS-GOLD-001", ship_date="2026-11-05")
    invoice_shipment(erp, s["desadv_ref"], invoice_date="2026-11-05")
    reconcile_and_send(erp, "ESS-GOLD-001")
    record_delivery(erp, s["desadv_ref"], signed_by="CeDi", received={"8000000000001": 10560}, note="1 pallet", when="2026-11-06")
    if with_credit:
        rc, vc = offline_callers(GOLDEN / "grok_offline.json")
        handle_claim(erp, (GOLDEN / "claim_email.txt").read_text(), out_dir=tmp_path / "out", read_caller=rc,
                     verdict_caller=vc, received_on=date(2026, 11, 7), issue_date=date(2026, 11, 7))
    return erp


def _deduction_verdict(_m):
    return json.loads(json.dumps(json.loads((GOLDEN / "grok_offline.json").read_text())["deduction_verdict"]))


def test_parse_remadv() -> None:
    advice = parse_remadv(REMADV)
    assert advice["remittance_ref"] == "RA-ESS-2026-11-30" and advice["value_date"] == "2026-11-30"
    assert advice["total"] == 23882.40 and advice["payer_gln"] == "BUYER001"
    (doc,) = advice["docs"]
    assert (doc["invoice_ref"], doc["due"], doc["paid"]) == ("FT-2026/0001", 24710.40, 23882.40)
    assert [(a["code"], a["amount"]) for a in doc["adjustments"]] == [("CN", 528.0), ("PC", 300.0)]
    assert doc["adjustments"][1]["note"] == "Contributo volantino novembre"


def test_credit_note_is_matched_and_the_other_deduction_becomes_a_claim(tmp_path: Path) -> None:
    erp = _invoiced(tmp_path)
    res = record_remittance(erp, REMADV, out_dir=tmp_path / "out", verdict_caller=_deduction_verdict,
                            received_on=date(2026, 11, 30))
    matched, opened = res["lines"][0]["deductions"]
    assert matched["status"] == "matched_credit" and matched["credit_note"] == "NC-20261107-ESSGOLD001"
    assert opened["status"] == "claim_opened" and opened["claim_status"] == "awaiting_person"
    case = erp.signoff(opened["case_id"])
    assert "the claim type is not covered by the Playbook" in case["reasons"]
    playbook = tmp_path / "playbook.md"
    shutil.copy(ROOT / "data" / "disputes" / "playbook.md", playbook)
    approve_verdict(erp, case["case_id"], by="Sara", reason="no clause for flyer contributions", playbook_path=playbook)
    b = balance(erp, "FT-2026/0001")
    assert (b["paid"], b["credits"], b["deductions_disputed"], b["open"]) == (23882.40, 528.0, 300.0, 300.0)
    ag = aging(erp, date(2026, 11, 30))
    assert ag["open_total"] == 300.0 and ag["buckets"]["not due"] == 300.0
    assert [d["status"] for d in ag["open_deductions"]] == ["disputed"]
    assert aging(erp, date(2027, 2, 10))["buckets"]["31-60"] == 300.0  # due 4 Jan 2027


def test_accepted_deduction_closes_the_invoice(tmp_path: Path) -> None:
    erp = _invoiced(tmp_path)
    accept = lambda _m: {"decision": "accept", "amount": 300.0, "confidence": 0.9, "needs_sign_off": False,  # noqa: E731
                         "summary": "agreed flyer", "points": [{"text": "flyer agreed", "amount": 300.0,
                         "source": {"kind": "contract", "ref": "flyer agreement", "detail": "signed"}}]}
    text = REMADV.replace("AJT+PC", "AJT+PR")  # a price deduction is in the Playbook
    res = record_remittance(erp, text, out_dir=tmp_path / "out", verdict_caller=accept, received_on=date(2026, 11, 30))
    assert res["lines"][0]["deductions"][1]["claim_status"] == "closed"
    assert balance(erp, "FT-2026/0001")["open"] == 0.0


def test_unexplained_short_payment_without_grok_goes_to_a_person(tmp_path: Path) -> None:
    erp = _invoiced(tmp_path, with_credit=False)
    text = REMADV.replace("MOA+9:23882.40'\nAJT+CN'\nMOA+5:528.00'\nFTX+AAI+++Nota di credito NC-20261107-ESSGOLD001'\nAJT+PC'\nMOA+5:300.00'\nFTX+AAI+++Contributo volantino novembre'",
                          "MOA+9:24610.40'")
    res = record_remittance(erp, text, out_dir=tmp_path / "out", received_on=date(2026, 11, 30))
    (d,) = res["lines"][0]["deductions"]
    assert d["amount"] == 100.0 and d["claim_status"] == "awaiting_person"
    assert "Grok marked the case as unsure" in erp.signoff(d["case_id"])["reasons"]


def test_unknown_invoice_is_reported(tmp_path: Path) -> None:
    erp = _invoiced(tmp_path, with_credit=False)
    res = record_remittance(erp, REMADV.replace("DOC+380+FT-2026/0001", "DOC+380+FT-2026/9999"), out_dir=tmp_path)
    assert res["lines"][0]["problem"] == "unknown invoice"


def test_kpis_after_the_demo(tmp_path: Path) -> None:
    import demo
    from core.digest import kpis
    from core.erp import Erp

    db = tmp_path / "demo.sqlite"
    demo.run(db=str(db), out_dir=tmp_path / "out", quiet=True)
    k = kpis(Erp(db))
    assert k["no_person"]["orders"] == {"done": 0, "of": 1}  # Order rule: a person confirms every order
    assert k["no_person"]["deductions"] == {"done": 1, "of": 2}
    assert k["fill_rate"] == 0.9
    assert (k["invoiced"], k["collected"], k["open_receivables"]) == (24710.40, 23882.40, 300.0)
    assert k["deductions_open"] == 300.0 and k["credit_notes"] == 528.0 and k["waiting_for_a_person"] == 0
