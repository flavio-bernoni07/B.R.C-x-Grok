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
import ssl
import time
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


USAGE: dict[str, Any] = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "seconds": 0.0,
                         "by_task": {}, "models": set(), "retries": {}, "rejected": []}


def _ssl_context() -> ssl.SSLContext:
    """python.org builds on macOS ship without root certificates; certifi has them."""
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def _count(task: str | None, envelope: dict[str, Any], seconds: float) -> None:
    usage = envelope.get("usage") or {}
    USAGE["calls"] += 1
    USAGE["prompt_tokens"] += int(usage.get("prompt_tokens") or 0)
    USAGE["completion_tokens"] += int(usage.get("completion_tokens") or 0)
    USAGE["seconds"] += seconds
    USAGE["by_task"][task or "?"] = USAGE["by_task"].get(task or "?", 0) + 1
    if envelope.get("model"):
        USAGE["models"].add(envelope["model"])


def usage_summary() -> str:
    """Live calls so far in this process; the cost is on console.x.ai."""
    if not USAGE["calls"]:
        return "no live Grok calls"
    return (f"{USAGE['calls']} live Grok calls ({', '.join(f'{k} {v}' for k, v in USAGE['by_task'].items())}), "
            f"{USAGE['prompt_tokens']:,} tokens in, {USAGE['completion_tokens']:,} out, "
            f"{USAGE['seconds']:.1f} s, model {', '.join(sorted(USAGE['models'])) or model_for()}"
            + (f"; retried after a rejected answer: {', '.join(f'{k} {v}' for k, v in USAGE['retries'].items())}"
               if USAGE["retries"] else ""))


def key_source() -> str | None:
    """Where the key comes from, never the key itself."""
    for name in ("XAI_API_KEY", "GROK_API_KEY"):
        if os.environ.get(name, "").strip():
            return f"environment ({name})"
        if _env_file().get(name, "").strip():
            return f".env.local ({name})"
    return None


_JSON_MODE = {"supported": True}


def post_chat(messages: Messages, *, task: str | None = None, api_key_value: str | None = None,
              temperature: float = 0, timeout: int = 90, json_mode: bool = True) -> str:
    """One HTTP call to xAI chat completions; returns the message text.

    json_mode asks the API for a guaranteed JSON object (response_format), so a reply can
    never come back with brackets out of order; if the model refuses the option, the call
    is made again without it and the code checks catch any bad JSON as before.
    """
    key = api_key_value or api_key()
    if not key:
        raise MissingApiKeyError("Missing API key. Set XAI_API_KEY or GROK_API_KEY.")
    body: dict[str, Any] = {"model": model_for(task), "temperature": temperature, "messages": messages}
    if json_mode and _JSON_MODE["supported"]:
        body["response_format"] = {"type": "json_object"}
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
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=_ssl_context()) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        if exc.code == 400 and "response_format" in body and "response_format" in detail:
            _JSON_MODE["supported"] = False
            return post_chat(messages, task=task, api_key_value=key, temperature=temperature, timeout=timeout,
                             json_mode=False)
        raise RuntimeError(f"xAI API HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"xAI API request failed: {exc}") from exc
    envelope = json.loads(raw)
    _count(task, envelope, time.monotonic() - started)
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
            USAGE["retries"][task] = USAGE["retries"].get(task, 0) + 1
            USAGE["rejected"].append({"task": task, "problems": problems, "reply": text[:600]})
            convo = convo + [
                {"role": "assistant", "content": text},
                {"role": "user", "content": "Your answer was rejected by the checks: "
                 + "; ".join(problems) + ". Return the corrected JSON object only."},
            ]
    raise GrokAnswerRejected(problems)


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Check the Grok connection with one tiny call")
    parser.add_argument("--ping", action="store_true", help="send one small request and report the model and tokens")
    args = parser.parse_args(argv)
    source = key_source()
    print(f"key: {'found in ' + source if source else 'not found (set XAI_API_KEY or create .env.local)'}")
    print(f"model: {model_for('ping')}, endpoint: {base_url()}")
    if not args.ping or not source:
        return 0 if source else 1
    try:
        answer = chat_json([{"role": "user", "content": 'Reply with the JSON object {"ok": true} and nothing else.'}],
                           task="ping", validate=lambda p: [] if p.get("ok") is True else ['answer {"ok": true}'])
    except Exception as exc:  # noqa: BLE001 - report any failure plainly
        print(f"ping failed: {exc}")
        return 1
    print(f"ping ok: {answer}; {usage_summary()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
