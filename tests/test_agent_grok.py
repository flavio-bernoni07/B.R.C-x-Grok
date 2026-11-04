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


class _Resp:
    def __init__(self, body: dict) -> None:
        self._raw = __import__("json").dumps(body).encode()

    def read(self) -> bytes:
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *a) -> None:
        pass


def test_json_mode_is_requested_and_dropped_if_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    import io
    import json
    import urllib.error

    sent = []

    def fake_urlopen(req, timeout=None, context=None):
        body = json.loads(req.data)
        sent.append(body)
        if "response_format" in body and len(sent) == 1:
            raise urllib.error.HTTPError(req.full_url, 400, "bad", {}, io.BytesIO(b'{"error":"response_format not supported"}'))
        return _Resp({"model": "grok-test", "usage": {"prompt_tokens": 3, "completion_tokens": 2},
                      "choices": [{"message": {"content": '{"ok": true}'}}]})

    monkeypatch.setattr(grok.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setitem(grok._JSON_MODE, "supported", True)
    assert grok.chat_json([{"role": "user", "content": "x"}], task="t", api_key_value="k") == {"ok": True}
    assert sent[0]["response_format"] == {"type": "json_object"} and "response_format" not in sent[1]
    assert grok._JSON_MODE["supported"] is False


def test_key_source_never_shows_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XAI_API_KEY", "xai-secret-value")
    assert grok.key_source() == "environment (XAI_API_KEY)"
