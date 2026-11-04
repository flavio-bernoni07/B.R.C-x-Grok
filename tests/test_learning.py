"""The learning loop: case log, precedents, draft rules, approval, rule decisions, demotion."""

from __future__ import annotations

import json
import shutil
from datetime import date
from pathlib import Path

import pytest

from agent import learning, replay
from core.erp import Erp
from core.stock import record_event
from core.world import fresh_erp
from dispute.service import approve_verdict, handle_claim, offline_callers, reject_verdict
from order.service import confirm_order, receive_order
from shipping.service import ingest_confirmed_order, invoice_shipment, record_delivery, ship_order

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = ROOT / "data" / "world" / "golden"
SIG = {"task": "dispute.verdict", "case_type": "shortage", "threeway_reason": "matched",
       "reconcile_causes": "", "proofs": "pod", "checks": "reservation_on_ddt",
       "retailer": "Esselunga", "product": "CAR-1KG", "amount_band": "500-2000"}


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


def test_activate_from_person_does_not_reuse_rule_with_other_decision() -> None:
    erp = Erp()
    learning.ensure_schema(erp)
    old = learning.activate_from_person(erp, SIG, "accept", by="Sara", reason="credit it")
    assert learning.rules(erp, "active")[0]["action"]["decision"] == "accept"
    new = learning.activate_from_person(erp, SIG, "reject", by="Sara", reason="reply with evidence instead")
    assert new != old
    active = learning.rules(erp, "active")
    assert len(active) == 1 and active[0]["action"]["decision"] == "reject"
    assert learning.rules(erp, "draft")[0]["rule_id"] == old


def test_same_kind_matches_on_reconcile_causes_not_threeway_wording() -> None:
    """Exact rules key off Shipping reconcile codes — the labels we cite — not baseline text."""
    erp = Erp()
    a = dict(SIG, reconcile_causes="overbilled,short_delivery",
             threeway_reason="Billed for more than was received")
    b = dict(SIG, reconcile_causes="overbilled,short_delivery",
             threeway_reason="Short delivery")  # different baseline wording, same causes
    learning.activate_from_person(erp, a, "accept", by="Sara", reason="overbilled + short")
    assert learning.match_rule(erp, b)["action"]["decision"] == "accept"
    other = dict(SIG, reconcile_causes="price_difference", threeway_reason="Billed for more than was received")
    assert learning.match_rule(erp, other) is None


def test_reason_applicability_requires_saras_why_to_still_hold() -> None:
    """Same fingerprint is not enough: quantities / OTIF from the reason must still be true."""
    from dispute.pull_facts import load_claim_json, pull_facts

    facts = pull_facts(load_claim_json(ROOT / "data" / "disputes" / "extractions" / "05_ambiguous.json")).to_dict()
    reason = "Late gate-in, quantities agree: reply with the evidence"
    when = learning.applicability_conditions(facts, reason)
    assert "quantities_agree" in when["required"]
    assert "late_gate_or_otif" in when["required"]
    assert when["quantities_agree"] and when["late_gate_or_otif"]

    rule = {"action": {"decision": "reject", "when": when}, "approved_reason": reason}
    assert learning.reason_still_applies(rule, facts) == (True, [])

    disagree = json.loads(json.dumps(facts))
    disagree["invoice"]["lines"][0]["quantity"] = 99
    ok, fails = learning.reason_still_applies(rule, disagree)
    assert not ok and any("quantities" in f for f in fails)

    no_otif = json.loads(json.dumps(facts))
    for proof in no_otif["proofs"]:
        if proof.get("kind") == "warehouse_event":
            proof["summary"] = "Pallet scanned at gate"
    if no_otif.get("desadv"):
        no_otif["desadv"]["notes"] = ""
    ok, fails = learning.reason_still_applies(rule, no_otif)
    assert not ok and any("OTIF" in f or "gate-in" in f for f in fails)


def test_precedents_are_the_closest_and_never_overturned() -> None:
    erp = Erp()
    _log(erp, 1)
    _log(erp, 2, sig=dict(SIG, case_type="pricing", reconcile_causes="price_difference",
                           threeway_reason="Invoice price differs from the PO price"))
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


def test_person_signoff_teaches_the_next_similar_claim(tmp_path: Path) -> None:
    """Case A unclear → Sara approves → Case B same kind + same why closes alone via learned rule."""
    import json

    erp = fresh_erp()
    playbook = tmp_path / "playbook.md"
    shutil.copy(ROOT / "data" / "disputes" / "playbook.md", playbook)
    unclear = json.loads((ROOT / "data" / "disputes" / "extractions" / "05_ambiguous.json").read_text())
    twin = json.loads((ROOT / "data" / "disputes" / "extractions" / "06_ambiguous_twin.json").read_text())
    verdict = json.loads((ROOT / "data" / "disputes" / "verdicts" / "05_ambiguous_reject.json").read_text())
    for key in ("claim", "playbook_path", "contract_path", "amount_notes", "known_amounts"):
        verdict.pop(key, None)
    read_a = lambda _t: dict(unclear)
    read_b = lambda _t: dict(twin)
    verdict_c = lambda _m: json.loads(json.dumps(verdict))

    first = handle_claim(
        erp, (ROOT / "data" / "disputes" / "claims" / "05_ambiguous_otif_or_shortage.txt").read_text(),
        out_dir=tmp_path / "a", read_caller=read_a, verdict_caller=verdict_c,
        received_on=date(2026, 11, 7),
    )
    assert first["status"] == "awaiting_person"
    done = approve_verdict(
        erp, first["case_id"], by="Sara", reason="Late gate-in, quantities agree: reply with the evidence",
        playbook_path=playbook, issue_date=date(2026, 11, 7),
    )
    assert done["learned_rule_id"]
    rule = learning.match_rule(erp, learning.case_for(erp, first["claim_id"])["signature"])
    assert rule and rule["action"]["when"]["required"] == ["quantities_agree", "late_gate_or_otif"]
    assert rule["approved_reason"].startswith("Late gate-in")

    def no_grok(_messages):
        raise AssertionError("Grok must not be called when the learned rule matches")

    second = handle_claim(
        erp, (ROOT / "data" / "disputes" / "claims" / "06_ambiguous_otif_twin.txt").read_text(),
        out_dir=tmp_path / "b", read_caller=read_b, verdict_caller=no_grok,
        received_on=date(2026, 11, 7),
    )
    assert second["status"] == "closed"
    assert second["outcome"]["kind"] == "reject_reply"
    assert second["verdict"]["points"][0]["source"]["ref"] == done["learned_rule_id"]
    assert "because:" in second["verdict"]["points"][0]["source"]["detail"].lower()
    assert learning.case_for(erp, second["claim_id"])["decided_by"] == "rule"
    assert done["learned_rule_id"] in second["verdict"]["summary"]
    assert "Late gate-in" in second["verdict"]["summary"]


def test_matching_rule_skipped_when_reason_no_longer_holds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fingerprint matches, but Sara's why does not → ask a person again, do not force the rule."""
    import json

    erp = fresh_erp()
    playbook = tmp_path / "playbook.md"
    shutil.copy(ROOT / "data" / "disputes" / "playbook.md", playbook)
    unclear = json.loads((ROOT / "data" / "disputes" / "extractions" / "05_ambiguous.json").read_text())
    twin = json.loads((ROOT / "data" / "disputes" / "extractions" / "06_ambiguous_twin.json").read_text())
    verdict = json.loads((ROOT / "data" / "disputes" / "verdicts" / "05_ambiguous_reject.json").read_text())
    for key in ("claim", "playbook_path", "contract_path", "amount_notes", "known_amounts"):
        verdict.pop(key, None)

    first = handle_claim(
        erp, "a", out_dir=tmp_path / "a",
        read_caller=lambda _t: dict(unclear),
        verdict_caller=lambda _m: json.loads(json.dumps(verdict)),
        received_on=date(2026, 11, 7),
    )
    approve_verdict(
        erp, first["case_id"], by="Sara",
        reason="Late gate-in, quantities agree: reply with the evidence",
        playbook_path=playbook, issue_date=date(2026, 11, 7),
    )

    monkeypatch.setattr(
        learning,
        "reason_still_applies",
        lambda _rule, _facts: (
            False,
            ["Sara's reason needs quantities to agree, but DESADV and invoice quantities differ on this claim"],
        ),
    )
    second = handle_claim(
        erp, "b", out_dir=tmp_path / "b",
        read_caller=lambda _t: dict(twin),
        verdict_caller=lambda _m: json.loads(json.dumps(verdict)),
        received_on=date(2026, 11, 7),
    )
    assert second["status"] == "awaiting_person"
    assert any("quantities" in r for r in second["verdict"]["sign_off_reasons"])
    assert learning.case_for(erp, second["claim_id"])["decided_by"] is None


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
