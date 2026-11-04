"""The ambiguous order end to end: Grok fixes the EDI, a person confirms, it ships, the
retailer claims, Grok proposes the verdict. Recorded answers; the same code checks as live."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scenarios.ambiguous_order import HERE, run

RECORDED = json.loads((HERE / "grok_recorded.json").read_text(encoding="utf-8"))


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)


def _with(**changes) -> dict:
    data = json.loads(json.dumps(RECORDED))
    for step, patch in changes.items():
        data[step].update(patch)
    return data


def test_grok_fixes_a_person_confirms_it_ships_and_the_claim_is_settled(tmp_path: Path) -> None:
    res = run(out_dir=tmp_path, quiet=True)
    assert res["order_qty"] == 6000  # 6.000 read as six thousand, and a person confirmed it
    assert [c["step"] for c in res["grok_calls"]] == ["fix_parse", "read_claim", "verdict"]
    assert [p["by"] for p in res["people"]] == ["Giulia, order desk"]
    assert res["invoice_total"] == 11544.0
    assert (res["claim_status"], res["outcome"], res["credit"]) == ("closed", "credit_note", 444.0)
    assert res["trace_gaps"] == []
    assert list(tmp_path.glob("ESS-AMB-001_TD04.xml"))


def test_an_unsure_fix_goes_to_a_person_who_types_the_edi(tmp_path: Path) -> None:
    res = run(out_dir=tmp_path, quiet=True, recorded=_with(fix_parse={"confidence": 0.3}))
    assert [p["done"] for p in res["people"]][:2] == ["manual EDI parsed again", "ORDRSP sent, order handed to Shipping"]
    assert res["order_qty"] == 6000 and res["outcome"] == "credit_note"


def test_an_invented_figure_in_the_verdict_puts_the_claim_on_a_desk(tmp_path: Path) -> None:
    res = run(out_dir=tmp_path, quiet=True, recorded=_with(verdict={"amount": 600.0}))
    assert [p["by"] for p in res["people"]] == ["Giulia, order desk", "Sara, credit desk"]
    assert res["credit"] == 444.0  # code kept the figure the documents support


def test_grok_reading_six_packs_is_shown_to_the_person(tmp_path: Path) -> None:
    six = RECORDED["fix_parse"]["corrected_edi"].replace("QTY+21:6000", "QTY+21:6")
    res = run(out_dir=tmp_path, quiet=True, recorded=_with(fix_parse={
        "corrected_edi": six, "changes": [{"segment": "QTY", "before": "6.000", "after": "6", "why": "decimal point"}]}))
    assert res["order_qty"] == 6  # the scripted person approves; a real one sees "6.000 -> 6" in the reasons
