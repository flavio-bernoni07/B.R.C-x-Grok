"""One Grok client for every row (see grok-agent-dec.md).

- JSON answers only, parsed here.
- `validate` returns a list of problems; the answer is sent back once with them,
  and a second bad answer raises GrokAnswerRejected so the case goes to a person.
- Model per task: XAI_MODEL_<TASK> (dots become underscores, e.g.
  XAI_MODEL_DISPUTE_VERDICT), then XAI_MODEL, then GROK_MODEL, then the default below.
- Key from XAI_API_KEY or GROK_API_KEY; base URL from XAI_BASE_URL. Each setting is read
  from the environment first, then from the repo's gitignored .env.local.

Grok proposes; code checks; a person decides when it is unclear. Nothing here
writes a document or an amount.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

DEFAULT_BASE_URL = "https://api.x.ai/v1"
DEFAULT_MODEL = "grok-4-latest"  # grok-2-latest answers 404 (PR #11)

Messages = list[dict[str, str]]
Caller = Callable[[Messages], Any]
Validator = Callable[[dict[str, Any]], list[str]]


class MissingApiKeyError(RuntimeError):
    """No xAI/Grok key is configured, so no live call can be made."""


class GrokAnswerRejected(RuntimeError):
    """Grok's answer failed the code checks twice."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__("Grok answer rejected: " + "; ".join(problems))
        self.problems = problems


ENV_FILE = Path(__file__).resolve().parents[1] / ".env.local"  # gitignored


def _env_file() -> dict[str, str]:
    """KEY=value lines from the repo's .env.local, if there is one. Ignored when BRC_OFFLINE=1
    (the test suite), so a key saved there never turns an offline test into a live call."""
    if os.environ.get("BRC_OFFLINE") == "1" or not ENV_FILE.is_file():
        return {}
    out = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and key and not key.startswith("#"):
            out[key.strip().removeprefix("export ").strip()] = value.strip().strip('"').strip("'")
    return out


def _setting(name: str) -> str:
    return (os.environ.get(name) or _env_file().get(name) or "").strip()


def api_key() -> str | None:
    for name in ("XAI_API_KEY", "GROK_API_KEY"):
        value = _setting(name)
        if value:
            return value
    return None


def has_key() -> bool:
    return api_key() is not None


def base_url() -> str:
    return (_setting("XAI_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


def model_for(task: str | None = None) -> str:
    if task:
        specific = _setting("XAI_MODEL_" + task.upper().replace(".", "_").replace("-", "_"))
        if specific:
            return specific
    for name in ("XAI_MODEL", "GROK_MODEL"):
        value = _setting(name)
        if value:
            return value
    return DEFAULT_MODEL


def extract_json_object(text: str) -> dict[str, Any]:
    """Parse the first JSON object in a model reply (tolerates ``` fences)."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise
        data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("Grok response JSON must be an object")
    return data


def post_chat(messages: Messages, *, task: str | None = None, api_key_value: str | None = None,
              temperature: float = 0, timeout: int = 90) -> str:
    """One HTTP call to xAI chat completions; returns the message text."""
    key = api_key_value or api_key()
    if not key:
        raise MissingApiKeyError("Missing API key. Set XAI_API_KEY or GROK_API_KEY.")
    body = {"model": model_for(task), "temperature": temperature, "messages": messages}
    request = urllib.request.Request(
        f"{base_url()}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"xAI API HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"xAI API request failed: {exc}") from exc
    envelope = json.loads(raw)
    try:
        content = envelope["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"Unexpected xAI response shape: {envelope!r}") from exc
    if not isinstance(content, str):
        raise RuntimeError("xAI message content is not a string")
    return content


def chat_json(
    messages: Messages,
    *,
    task: str,
    validate: Validator | None = None,
    caller: Caller | None = None,
    api_key_value: str | None = None,
    retries: int = 1,
    timeout: int = 90,
) -> dict[str, Any]:
    """Ask Grok for a JSON object, check it, retry once with the problems found.

    `caller` replaces the network in tests and offline demos: it gets the
    messages and returns a dict or a JSON string.
    """
    convo = list(messages)
    problems: list[str] = []
    for attempt in range(retries + 1):
        if caller is not None:
            reply = caller(convo)
        else:
            reply = post_chat(convo, task=task, api_key_value=api_key_value, timeout=timeout)
        if isinstance(reply, dict):
            payload, text = reply, json.dumps(reply)
        else:
            text = str(reply)
            try:
                payload = extract_json_object(text)
            except (ValueError, json.JSONDecodeError) as exc:
                payload, problems = None, [f"the reply is not a JSON object ({exc})"]
        if payload is not None:
            problems = validate(payload) if validate else []
            if not problems:
                return payload
        if attempt < retries:
            convo = convo + [
                {"role": "assistant", "content": text},
                {"role": "user", "content": "Your answer was rejected by the checks: "
                 + "; ".join(problems) + ". Return the corrected JSON object only."},
            ]
    raise GrokAnswerRejected(problems)
