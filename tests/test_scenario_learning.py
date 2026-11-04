"""Consecutive damage claims: Grok sees past decisions, a rule is drafted and approved, the rule decides."""

from __future__ import annotations

from pathlib import Path

import pytest

from scenarios.learning import run


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)


def test_past_decisions_feed_grok_then_a_rule_takes_over(tmp_path: Path) -> None:
    res = run(quiet=True, out_dir=tmp_path)
    assert [r["decided_by"] for r in res["rows"]] == ["grok", "grok", "grok", "rule"]
    assert [r["precedents"] for r in res["rows"]][:3] == [0, 1, 2]
    assert [r["amount"] for r in res["rows"]] == [88.8, 177.6, 133.2, 222.0]
    (rule,) = res["rules"]
    assert rule["status"] == "active" and rule["approved_by"] == "Sara, credit desk"
