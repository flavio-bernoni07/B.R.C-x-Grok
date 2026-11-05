"""Dispute row on the Mini ERP, the benchmark against threeway, and the whole demo."""

from __future__ import annotations

import json
import re
import shutil
from datetime import date
from pathlib import Path

import pytest

import demo
from bench.score import score
from core.world import fresh_erp
from dispute.service import approve_verdict, handle_claim, offline_callers, reject_verdict

ROOT = Path(__file__).resolve().parents[1]
DISPUTES = ROOT / "data" / "disputes"


def _claim_type_from_verdict_messages(messages: list[dict[str, str]]) -> str:
    text = messages[-1]["content"] if messages else ""
    match = re.search(r'"claim_type"\s*:\s*"(\w+)"', text)
    return match.group(1) if match else "other"


def _multi_issue_callers(*, pricing_verdict_name: str):
    extraction = json.loads((DISPUTES / "extractions" / "07_shortage_and_pricing.json").read_text())
    shortage = json.loads((DISPUTES / "verdicts" / "07_shortage_issue.json").read_text())
    pricing = json.loads((DISPUTES / pricing_verdict_name).read_text())

    def read_c(_text: str) -> dict:
        return dict(extraction)

    def verdict_c(messages: list[dict[str, str]]) -> dict:
        claim_type = _claim_type_from_verdict_messages(messages)
        payload = pricing if claim_type == "pricing" else shortage
        return json.loads(json.dumps(payload))

    return read_c, verdict_c


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)


def _unclear():
    extraction = json.loads((DISPUTES / "extractions" / "05_ambiguous.json").read_text())
    verdict = json.loads((DISPUTES / "verdicts" / "05_ambiguous_reject.json").read_text())
    for key in ("claim", "playbook_path", "contract_path", "amount_notes", "known_amounts"):
        verdict.pop(key, None)
    return (lambda _t: dict(extraction)), (lambda _m: json.loads(json.dumps(verdict)))


def test_unclear_claim_waits_then_approval_writes_reply_and_playbook(tmp_path: Path) -> None:
    erp = fresh_erp()
    playbook = tmp_path / "playbook.md"
    shutil.copy(DISPUTES / "playbook.md", playbook)
    read_c, verdict_c = _unclear()
    res = handle_claim(erp, (DISPUTES / "claims" / "05_ambiguous_otif_or_shortage.txt").read_text(),
                       out_dir=tmp_path, read_caller=read_c, verdict_caller=verdict_c)
    assert res["status"] == "awaiting_person"
    assert not list(tmp_path.glob("*_reject_reply.txt"))
    assert erp.claim(res["claim_id"])["status"] == "awaiting_sign_off"
    done = approve_verdict(erp, res["case_id"], by="Sara", reason="Late gate-in, quantities agree",
                           playbook_path=playbook, issue_date=date(2026, 11, 7))
    assert done["outcome"]["kind"] == "reject_reply" and done["outcome"]["approved_by"] == "Sara"
    assert erp.claim(res["claim_id"])["status"] == "closed"
    assert "| 2026-11-07 | RS26112 | other | reject (approved) |" in playbook.read_text()
    assert erp.documents(ref=res["claim_id"], kind="claim reply")


def test_multi_issue_both_clear_emits_one_combined_credit(tmp_path: Path) -> None:
    erp = fresh_erp()
    read_c, verdict_c = _multi_issue_callers(
        pricing_verdict_name="verdicts/07_pricing_issue.json"
    )
    res = handle_claim(
        erp,
        (DISPUTES / "claims" / "07_shortage_and_pricing.txt").read_text(),
        out_dir=tmp_path,
        read_caller=read_c,
        verdict_caller=verdict_c,
        received_on=date(2026, 11, 4),
    )
    assert res["status"] == "closed"
    assert res["verdict"]["decision"] == "accept"
    assert res["verdict"]["amount"] == pytest.approx(202.8)
    assert len(res["verdict"]["issue_verdicts"]) == 2
    assert all(iv["settled"] for iv in res["verdict"]["issue_verdicts"])
    assert res["outcome"]["kind"] == "credit_note"
    assert res["outcome"]["amount"] == pytest.approx(202.8)
    assert list(tmp_path.glob("*_TD04.xml"))
    assert not list(tmp_path.glob("*_reject_reply.txt"))


def test_multi_issue_mixed_waits_then_approval_combines_credit(tmp_path: Path) -> None:
    erp = fresh_erp()
    playbook = tmp_path / "playbook.md"
    shutil.copy(DISPUTES / "playbook.md", playbook)
    read_c, verdict_c = _multi_issue_callers(
        pricing_verdict_name="verdicts/07_pricing_ambiguous.json"
    )
    res = handle_claim(
        erp,
        (DISPUTES / "claims" / "07_shortage_and_pricing.txt").read_text(),
        out_dir=tmp_path,
        read_caller=read_c,
        verdict_caller=verdict_c,
        received_on=date(2026, 11, 4),
    )
    assert res["status"] == "awaiting_person"
    assert not list(tmp_path.glob("*_TD04.xml"))
    issue_rows = {iv["issue"]["claim_type"]: iv for iv in res["verdict"]["issue_verdicts"]}
    assert issue_rows["shortage"]["settled"] is True
    assert issue_rows["pricing"]["settled"] is False
    assert any("pricing" in r for r in res["verdict"]["sign_off_reasons"])

    done = approve_verdict(
        erp,
        res["case_id"],
        by="Sara",
        reason="Autumn promo applies to Arborio on this PO",
        playbook_path=playbook,
        issue_date=date(2026, 11, 7),
    )
    assert done["outcome"]["kind"] == "credit_note"
    assert done["outcome"]["amount"] == pytest.approx(202.8)
    assert done["verdict"]["decision"] == "accept"
    assert all(iv["settled"] for iv in done["verdict"]["issue_verdicts"])
    assert done["learned_rule_id"]
    assert list(tmp_path.glob("*_TD04.xml"))


def test_overturned_verdict_reopens_the_claim(tmp_path: Path) -> None:
    erp = fresh_erp()
    playbook = tmp_path / "playbook.md"
    shutil.copy(DISPUTES / "playbook.md", playbook)
    read_c, verdict_c = _unclear()
    res = handle_claim(erp, "unclear claim text", out_dir=tmp_path, read_caller=read_c, verdict_caller=verdict_c)
    reject_verdict(erp, res["case_id"], by="Sara", reason="Ask Auchan for the receiving count first",
                   playbook_path=playbook)
    assert erp.claim(res["claim_id"])["status"] == "reopened"
    assert "reject overturned" in playbook.read_text()


def test_benchmark_beats_threeway_on_its_blind_spots() -> None:
    res = score()
    t = res["totals"]
    assert t["ours_attention_ok"] > t["threeway_attention_ok"]
    assert t["ours_causes_ok"] > t["threeway_causes_ok"]
    rows = {r["id"]: r for r in res["rows"]}
    for blind_spot in ("C06", "C13", "C14", "C15"):  # short invoiced right, two causes, ref typo
        assert rows[blind_spot]["ours_causes_ok"] and not rows[blind_spot]["threeway_causes_ok"]
    for parity in ("C01", "C04", "C09", "C11", "C19"):
        assert rows[parity]["ours_causes_ok"] and rows[parity]["threeway_causes_ok"]


def test_golden_order_runs_through_every_row(tmp_path: Path) -> None:
    result = demo.run(out_dir=tmp_path, quiet=True)
    assert result["order"] == "confirmed" or result["order"] in {"invoiced", "shipped"}
    assert result["shipping"] == "sent"
    assert result["golden_claim"] == "closed"
    assert result["unclear_claim"] == "awaiting_person"
    assert result["learned_claim"] == "closed"
    assert result.get("learned_rule_id")
    assert result["multi_issue_claim"] == "closed"
    assert result["multi_issue_amount"] == pytest.approx(202.8)
    assert result["pending_signoffs"] == 0
    assert list(tmp_path.glob("ESS-GOLD-001_TD04.xml"))
    assert len(list(tmp_path.glob("*_TD04.xml"))) >= 2
    # Golden shortage credit + combined multi-issue credit (flyer remittance is reject, not a credit).
    assert "credit notes issued: 2" in result["digest"]
    assert result["planning"]["lot"] == "awaiting_person" and result["planning"]["suggestion"]["qty"] > 0
    assert (ROOT / "data" / "disputes" / "playbook.md").read_text().count("No past cases yet") == 1


def test_every_output_traces_back_to_its_source(tmp_path: Path) -> None:
    from core.erp import Erp
    from core.trace import chain, gaps, render

    db = tmp_path / "demo.sqlite"
    demo.run(db=str(db), out_dir=tmp_path / "out", quiet=True, with_planning=False)
    erp = Erp(db)
    assert gaps(erp) == []
    c = chain(erp, "ESS-GOLD-001")
    assert c["order"]["orders_file"] == "ORDERS_ESS-GOLD-001.edi" and c["order"]["ordrsp_doc"]
    assert {e["kind"] for e in c["production"]} >= {"batch_finished", "quality_hold"}
    assert c["claims"][0]["decision"] == "accept" and any("TD04" in o for o in c["claims"][0]["outputs"])
    assert "ORDERS" in render(c)
    erp.db.execute("UPDATE signoffs SET decision_reason = NULL WHERE case_id = 'SO-00001'")
    assert gaps(erp) == ["SO-00001: decided without a reason"]
