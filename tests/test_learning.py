"""The learning loop: case log, precedents, draft rules, approval, rule decisions, demotion."""

from __future__ import annotations

import shutil
from datetime import date
from pathlib import Path

import pytest

from agent import learning, replay
from core.erp import Erp
from core.stock import record_event
from core.world import fresh_erp
from dispute.service import handle_claim, offline_callers, reject_verdict
from order.service import confirm_order, receive_order
from shipping.service import ingest_confirmed_order, invoice_shipment, record_delivery, ship_order

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = ROOT / "data" / "world" / "golden"
SIG = {"task": "dispute.verdict", "case_type": "shortage", "threeway_reason": "matched", "proofs": "pod",
       "checks": "reservation_on_ddt", "retailer": "Esselunga", "product": "CAR-1KG", "amount_band": "500-2000"}


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)


def _log(erp, n, decision="accept", by="grok", sig=SIG):
    return learning.log_case(erp, task="dispute.verdict", subject_ref=f"C{n}", signature=sig, proposal={},
                             confidence=0.9, asked_person=False, why_person=[], decided_by=by, decision=decision)


def test_three_alike_draft_a_rule_that_waits_for_a_person() -> None:
    erp = Erp()
    _log(erp, 1)
    _log(erp, 2, by="Sara")
    assert learning.rules(erp) == []
    _log(erp, 3)
    (rule,) = learning.rules(erp)
    assert rule["status"] == "draft" and rule["action"] == {"decision": "accept"}
    assert learning.match_rule(erp, SIG) is None  # a draft decides nothing
    with pytest.raises(ValueError):
        learning.approve_rule(erp, rule["rule_id"], by="Sara", reason=" ")
    learning.approve_rule(erp, rule["rule_id"], by="Sara", reason="a reservation on the DDT is proof enough")
    assert learning.match_rule(erp, dict(SIG, retailer="Coop Italia"))["rule_id"] == rule["rule_id"]
    assert "approved by Sara" in learning.render_playbook(erp)


def test_disagreement_or_an_overturn_blocks_the_rule() -> None:
    erp = Erp()
    _log(erp, 1)
    _log(erp, 2, decision="reject")
    _log(erp, 3)
    _log(erp, 4)
    assert learning.rules(erp) == []


def test_precedents_are_the_closest_and_never_overturned() -> None:
    erp = Erp()
    _log(erp, 1)
    _log(erp, 2, sig=dict(SIG, case_type="pricing", threeway_reason="Invoice price differs from the PO price"))
    learning.record_person_decision(erp, "C1", decided_by="Sara", decision="not accept", reason="wrong",
                                    overturned=True)
    near = learning.similar(erp, SIG)
    assert [p["subject_ref"] for p in near] == ["C2"]


def _shipped():
    erp = fresh_erp()
    r = receive_order(erp, (GOLDEN / "ORDERS_ESS-GOLD-001.edi").read_text())
    ingest_confirmed_order(erp, confirm_order(erp, r["case_id"], by="Giulia", reason="ok"))
    record_event(erp, "quality_hold", batch="LOT-C-0418", qty=1200)
    s = ship_order(erp, "ESS-GOLD-001", ship_date="2026-11-05")
    invoice_shipment(erp, s["desadv_ref"], invoice_date="2026-11-05")
    record_delivery(erp, s["desadv_ref"], signed_by="CeDi", received={"8000000000001": 10560},
                    note="1 pallet mancante", when="2026-11-06")
    return erp


def test_an_active_rule_decides_with_no_grok_call(tmp_path: Path) -> None:
    read_c, verdict_c = offline_callers(GOLDEN / "grok_offline.json")
    first_erp = _shipped()
    first = handle_claim(first_erp, "claim", out_dir=tmp_path / "1", read_caller=read_c, verdict_caller=verdict_c,
                         received_on=date(2026, 11, 7))
    logged = learning.case_for(first_erp, first["claim_id"])
    assert logged["decided_by"] == "grok" and logged["signature"]["checks"] == "reservation_on_ddt"

    erp = _shipped()  # a fresh database, so the next claim is not a duplicate
    for n in (1, 2, 3):
        _log(erp, n, sig=logged["signature"])
    (rule,) = learning.rules(erp)
    learning.approve_rule(erp, rule["rule_id"], by="Sara", reason="a reservation on the DDT is proof enough")

    def no_grok(_messages):
        raise AssertionError("Grok must not be called when an active rule matches")

    res = handle_claim(erp, "claim", out_dir=tmp_path / "2", read_caller=read_c, verdict_caller=no_grok,
                       received_on=date(2026, 11, 7))
    assert res["status"] == "closed" and res["verdict"]["amount"] == 528.0
    assert res["verdict"]["points"][0]["source"]["ref"] == rule["rule_id"]
    assert learning.case_for(erp, res["claim_id"])["decided_by"] == "rule"


def test_overturning_a_rule_decision_demotes_the_rule(tmp_path: Path) -> None:
    erp = Erp()
    learning.ensure_schema(erp)
    for n in (1, 2, 3):
        _log(erp, n)
    (rule,) = learning.rules(erp)
    learning.approve_rule(erp, rule["rule_id"], by="Sara", reason="ok")
    learning.log_case(erp, task="dispute.verdict", subject_ref="C9", signature=SIG, proposal={}, confidence=1.0,
                      asked_person=False, why_person=[], decided_by="rule", decision="accept", rule_id=rule["rule_id"])
    learning.record_person_decision(erp, "C9", decided_by="Sara", decision="not accept", reason="POD was forged",
                                    overturned=True)
    assert learning.rules(erp)[0]["status"] == "draft"


def test_replay_draws_a_falling_curve() -> None:
    rows = replay.run_many(replays=5)
    assert rows[0]["share_person"] > rows[-1]["share_person"]
    assert rows[0]["decided_by_rule"] == 0 and rows[-1]["decided_by_rule"] > 0
    assert "<svg" in replay.svg(rows)
