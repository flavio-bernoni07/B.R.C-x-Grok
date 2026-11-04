"""The shared Grok client: JSON parsing, the one retry with the checks' reasons, model per task."""

from __future__ import annotations

import pytest

from agent import grok
from agent.checks import numbers_in, unknown_numbers


def test_retry_carries_the_problem_then_accepts() -> None:
    seen = []

    def caller(messages):
        seen.append(messages)
        return {"amount": 999} if len(seen) == 1 else {"amount": 186}

    payload = grok.chat_json([{"role": "user", "content": "x"}], task="t",
                             validate=lambda p: [] if p["amount"] == 186 else ["amount not in the facts"],
                             caller=caller)
    assert payload == {"amount": 186}
    assert "amount not in the facts" in seen[1][-1]["content"]


def test_two_bad_answers_raise() -> None:
    with pytest.raises(grok.GrokAnswerRejected) as err:
        grok.chat_json([{"role": "user", "content": "x"}], task="t", validate=lambda p: ["bad"],
                       caller=lambda m: {"a": 1})
    assert err.value.problems == ["bad"]


def test_fenced_json_and_garbage() -> None:
    assert grok.chat_json([], task="t", caller=lambda m: "```json\n{\"ok\": true}\n```") == {"ok": True}
    with pytest.raises(grok.GrokAnswerRejected):
        grok.chat_json([], task="t", caller=lambda m: "no json here")


def test_model_per_task(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XAI_MODEL", "base-model")
    monkeypatch.setenv("XAI_MODEL_DISPUTE_VERDICT", "strong-model")
    assert grok.model_for("dispute.verdict") == "strong-model"
    assert grok.model_for("dispute.read_claim") == "base-model"


def test_no_key_is_a_clear_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)
    assert not grok.has_key()
    with pytest.raises(grok.MissingApiKeyError):
        grok.post_chat([{"role": "user", "content": "x"}], task="t")


def test_number_check() -> None:
    assert numbers_in("12.000 pezzi a 2,20") == {"12000", "220"}
    assert unknown_numbers("credit 528 for 240 packs", "240 x 2.20 = 528") == set()
    assert unknown_numbers("credit 600", "240 x 2.20 = 528") == {"600"}
