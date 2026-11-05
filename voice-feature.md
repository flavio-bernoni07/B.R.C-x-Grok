Grok Voice for CRM

One markdown file with the full voice feature. Paste sections into your CRM as needed. API key stays on the server; the browser only gets an ephemeral client secret.

How it works





Browser POST /api/voice/session



Server calls xAI POST /v1/realtime/client_secrets with XAI_API_KEY



Browser opens wss://api.x.ai/v1/realtime?model=grok-voice-latest with subprotocol xai-client-secret.<token>



On session.created, browser sends session.update (instructions, tools, voice eve, PCM 24 kHz)



On tool call, browser POST /api/voice/tool → CRM data → conversation.item.create + response.create



Tool results may include navigate: { section, order_id } for CRM tabs

Setup checklist





Set XAI_API_KEY (or GROK_API_KEY) on the server only



Gitignore .env and .env.local



Mount the three voice API routes and serve the two JS assets



Add the voice card HTML and load the two browser scripts



Implement window.crmNavigate(section, orderId) for your router



Rewire order/list/ask tools to your CRM reads; keep return shape {ok, answer, navigate}



Mic needs https or localhost

Environment (do not commit)

XAI_API_KEY=xai-...
# optional
# XAI_BASE_URL=https://api.x.ai/v1

.env
.env.local

Voice card HTML

<article id="voice-card">
  <h2>Talk to the desk</h2>
  <p id="voice-status" class="muted">Checking the voice connection.</p>
  <button type="button" id="voice-button">Start microphone</button>
  <p id="voice-transcript"></p>
</article>
<script src="/voice_client.js"></script>
<script src="/desk_voice.js"></script>

xAI client (Python)

"""The one xAI client for this workspace.

Key lookup matches the team client: XAI_API_KEY, then GROK_API_KEY, then a
gitignored .env.local. The key never leaves this process. Voice sessions use a
short-lived client secret instead.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

DEFAULT_BASE_URL = "https://api.x.ai/v1"
VOICE_MODEL = "grok-voice-latest"
ENV_FILE = Path(__file__).resolve().parents[1] / ".env.local"


class MissingApiKeyError(RuntimeError):
    """No xAI key is configured, so no live call can be made."""


def _env_file() -> dict[str, str]:
    if os.environ.get("BRC_OFFLINE") == "1" or not ENV_FILE.is_file():
        return {}
    found: dict[str, str] = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and key and not key.startswith("#"):
            found[key.strip().removeprefix("export ").strip()] = value.strip().strip('"').strip("'")
    return found


def _setting(name: str) -> str:
    return (os.environ.get(name) or _env_file().get(name) or "").strip()


def api_key() -> str | None:
    for name in ("XAI_API_KEY", "GROK_API_KEY"):
        value = _setting(name)
        if value:
            return value
    return None


def key_status() -> dict[str, Any]:
    """Whether a key is configured. The value is not included."""
    if (os.environ.get("XAI_API_KEY") or "").strip() or (os.environ.get("GROK_API_KEY") or "").strip():
        source = "environment"
    elif _env_file().get("XAI_API_KEY") or _env_file().get("GROK_API_KEY"):
        source = "env_file"
    else:
        source = None
    return {
        "configured": source is not None,
        "source": source,
        "provider": "xai",
        "voice_model": VOICE_MODEL,
        "key_exposed": False,
    }


def base_url() -> str:
    return (_setting("XAI_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


Poster = Callable[[str, dict[str, Any], str], dict[str, Any]]


def _post_json(url: str, body: dict[str, Any], key: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"xAI API HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"xAI API request failed: {exc.reason}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("xAI response was not an object")
    return payload


def mint_voice_client_secret(*, poster: Poster | None = None, ttl_seconds: int = 300) -> dict[str, Any]:
    """Ask xAI for an ephemeral realtime token. The API key stays here."""
    key = api_key()
    if not key:
        raise MissingApiKeyError("XAI_API_KEY is not set.")
    send = poster or _post_json
    payload = send(
        f"{base_url()}/realtime/client_secrets",
        {"expires_after": {"seconds": ttl_seconds}},
        key,
    )
    token = payload.get("value")
    if not isinstance(token, str) or not token or token == key:
        raise RuntimeError("xAI did not return a client secret.")
    return {
        "ok": True,
        "provider": "xai",
        "model": VOICE_MODEL,
        "websocket_url": f"wss://api.x.ai/v1/realtime?model={VOICE_MODEL}",
        "client_secret": token,
        "expires_at": payload.get("expires_at"),
        "api_key_included": False,
    }

Voice tools and session payload (Python)

"""Voice tools for the shipping desk.

Grok Voice calls these by name. They read the same order records as the desk
and name a CRM section. They do not approve a case, transfer stock, or buy
packaging.
"""

from __future__ import annotations

import json
import re
from typing import Any

from shipping_invoicing.store import Store

from workspace.chat import answer_question
from workspace.read_model import build_orders, order_detail

SECTIONS = ("home", "orders", "operations", "actions")

INSTRUCTIONS = (
    "You are the voice of the shipping desk. Speak briefly in English. "
    "Use the tools for every order, stock, invoice, and navigation answer. "
    "Never invent a quantity, a price, a date, or a status. "
    "If a tool has no record, say so. "
    "When the employee asks to open Home, Orders, Operations, Actions, or a specific order, "
    "call navigate. Do not claim a purchase or a transfer was approved unless the tool says it is already stored."
)

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "get_order",
        "description": "Read one stored order: approved quantity, local stock, shipment, invoice, and status.",
        "parameters": {
            "type": "object",
            "properties": {"order_id": {"type": "string", "description": "Order id, for example ORD-3001."}},
            "required": ["order_id"],
        },
    },
    {
        "type": "function",
        "name": "list_orders",
        "description": "List stored orders. view can be all, attention, progress, or completed.",
        "parameters": {
            "type": "object",
            "properties": {"view": {"type": "string"}},
        },
    },
    {
        "type": "function",
        "name": "ask_records",
        "description": "Answer a question from the stored shipping records, including the Carnaroli scenario.",
        "parameters": {
            "type": "object",
            "properties": {"message": {"type": "string"}},
            "required": ["message"],
        },
    },
    {
        "type": "function",
        "name": "navigate",
        "description": "Open a CRM section: home, orders, operations, or actions. Include order_id to open that order.",
        "parameters": {
            "type": "object",
            "properties": {
                "section": {"type": "string"},
                "order_id": {"type": "string"},
            },
            "required": ["section"],
        },
    },
]


def _order_brief(store: Store, order_id: str) -> dict[str, Any] | None:
    detail = order_detail(store, order_id)
    if detail is None:
        return None
    quantities = detail.get("quantities") or {}
    recovery = detail.get("recovery") or {}
    invoices = (detail.get("finance") or {}).get("invoices") or []
    invoice_id = invoices[0].get("invoice_id") if invoices else recovery.get("invoice_id")
    return {
        "order_id": detail.get("order_id"),
        "status": detail.get("status"),
        "status_detail": detail.get("status_detail"),
        "destination": detail.get("destination"),
        "approved_qty": quantities.get("confirmed_qty"),
        "shipped_qty": quantities.get("shipped_qty"),
        "remaining_qty": quantities.get("remaining_qty"),
        "invoice_id": invoice_id,
        "local_released_before": recovery.get("local_released_before"),
        "shortage_qty": recovery.get("shortage_qty"),
        "transfers": recovery.get("transfers"),
        "resolution": recovery.get("resolution"),
    }


def run_voice_tool(store: Store, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
    args = arguments or {}
    if name == "get_order":
        order_id = str(args.get("order_id") or "").upper()
        brief = _order_brief(store, order_id)
        if brief is None:
            return {"ok": False, "answer": f"{order_id or 'That order'} is not stored.", "navigate": None}
        return {
            "ok": True,
            "answer": brief,
            "navigate": {"section": "orders", "order_id": order_id},
        }
    if name == "list_orders":
        view = str(args.get("view") or "all")
        cards = build_orders(store)
        if view == "attention":
            cards = [card for card in cards if card["status"] == "Needs attention"]
        elif view == "progress":
            cards = [card for card in cards if card["status"] in {"On track", "Shipped", "Waiting for retailer"}]
        elif view == "completed":
            cards = [card for card in cards if card["status"] == "Completed"]
        rows = [
            {
                "order_id": card["order_id"],
                "status": card["status"],
                "approved_qty": card["confirmed_qty"],
                "shipped_qty": card["shipped_qty"],
                "remaining_qty": card["remaining_qty"],
            }
            for card in cards
        ]
        return {"ok": True, "answer": rows, "navigate": {"section": "orders", "order_id": None}}
    if name == "ask_records":
        reply = answer_question(store, str(args.get("message") or ""))
        order_id = None
        for source in reply.get("sources") or []:
            if str(source.get("id") or "").startswith("ORD-"):
                order_id = source["id"]
                break
        if order_id is None:
            for link in reply.get("links") or []:
                found = re.search(r"ORD-\d+", str(link.get("href") or link.get("label") or ""))
                if found:
                    order_id = found.group(0)
                    break
        section = "orders" if order_id else None
        return {
            "ok": True,
            "answer": reply["answer"],
            "kind": reply["kind"],
            "grok_called": False,
            "navigate": None if section is None else {"section": section, "order_id": order_id},
        }
    if name == "navigate":
        section = str(args.get("section") or "").casefold()
        if section not in SECTIONS:
            return {"ok": False, "answer": "The section must be home, orders, operations, or actions.", "navigate": None}
        order_id = str(args.get("order_id") or "").upper() or None
        if order_id and _order_brief(store, order_id) is None:
            return {"ok": False, "answer": f"{order_id} is not stored.", "navigate": {"section": section, "order_id": None}}
        return {"ok": True, "answer": f"Opened {section}.", "navigate": {"section": section, "order_id": order_id}}
    return {"ok": False, "answer": f"Unknown tool {name}.", "navigate": None}


def session_payload(secret: dict[str, Any]) -> dict[str, Any]:
    return {
        **secret,
        "instructions": INSTRUCTIONS,
        "tools": TOOLS,
        "voice": "eve",
    }


def voice_followup(name: str, call_id: str, result: dict[str, Any], *, continue_response: bool = True) -> list[dict[str, Any]]:
    """The two realtime events the browser sends after a tool finishes."""
    messages = [{
        "type": "conversation.item.create",
        "item": {
            "type": "function_call_output",
            "call_id": call_id,
            "name": name,
            "output": json.dumps(result),
        },
    }]
    if continue_response:
        messages.append({"type": "response.create"})
    return messages

FastAPI voice routes (Python)

"""Copy these FastAPI routes into your CRM server.

Requires:
  from your_app.grok_client import MissingApiKeyError, key_status, mint_voice_client_secret
  from your_app.voice import run_voice_tool, session_payload
"""

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field


class VoiceToolRequest(BaseModel):
    name: str
    arguments: dict = Field(default_factory=dict)


def register_voice_routes(app: FastAPI, *, static_root, store, run_voice_tool, session_payload, key_status, mint_voice_client_secret, MissingApiKeyError) -> None:
    @app.get("/voice_client.js")
    def voice_client() -> Response:
        return Response((static_root / "voice_client.js").read_text(encoding="utf-8"), media_type="text/javascript")

    @app.get("/voice-worklet.js")
    def voice_worklet() -> Response:
        return Response((static_root / "voice_worklet.js").read_text(encoding="utf-8"), media_type="text/javascript")

    @app.get("/api/voice/status")
    def voice_status() -> dict:
        return key_status()

    @app.post("/api/voice/session")
    def voice_session() -> dict:
        try:
            secret = mint_voice_client_secret()
        except MissingApiKeyError:
            return JSONResponse(status_code=503, content={
                "ok": False,
                "grok": "unavailable",
                "reason": "XAI_API_KEY is not set. No voice session was opened.",
                "api_key_included": False,
            })
        except RuntimeError as exc:
            return JSONResponse(status_code=502, content={
                "ok": False,
                "grok": "unavailable",
                "reason": str(exc),
                "api_key_included": False,
            })
        return session_payload(secret)

    @app.post("/api/voice/tool")
    def voice_tool(payload: VoiceToolRequest) -> dict:
        return run_voice_tool(store, payload.name, payload.arguments)

Realtime browser client (JavaScript)

/* Browser side of the Grok Voice session.

The page never receives the xAI API key. It uses the ephemeral client secret
from /api/voice/session and sends tool calls to /api/voice/tool.
*/

const voiceClient = {
  handleServerEvent,
  navigationTarget,
  sessionUpdate,
};

function navigationTarget(toolResult) {
  if (!toolResult || !toolResult.navigate || !toolResult.navigate.section) return null;
  return toolResult.navigate;
}

function sessionUpdate(session) {
  return {
    type: "session.update",
    session: {
      instructions: session.instructions,
      voice: session.voice || "eve",
      tools: session.tools,
      turn_detection: { type: "server_vad" },
      audio: {
        input: { format: { type: "audio/pcm", rate: 24000 } },
        output: { format: { type: "audio/pcm", rate: 24000 } },
      },
    },
  };
}

async function handleServerEvent(event, ctx) {
  if (!event || typeof event !== "object") return { handled: false };
  if (event.type === "session.created") {
    ctx.send(sessionUpdate(ctx.session));
    return { handled: true, step: "configure" };
  }
  if (event.type === "response.function_call_arguments.done") {
    let args = {};
    try {
      args = JSON.parse(event.arguments || "{}");
    } catch (_error) {
      args = {};
    }
    const result = await ctx.runTool(event.name, args);
    ctx.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output: JSON.stringify(result),
      },
    });
    const navigate = navigationTarget(result);
    if (navigate && ctx.navigate) ctx.navigate(navigate);
    if (ctx.continueResponse) {
      ctx.continueResponse(() => ctx.send({ type: "response.create" }));
    } else {
      ctx.send({ type: "response.create" });
    }
    return { handled: true, step: "tool", navigate };
  }
  if (event.type === "response.output_audio.delta" || event.type === "response.audio.delta") {
    if (ctx.playAudio && event.delta) ctx.playAudio(event.delta);
    return { handled: true, step: "audio" };
  }
  if (event.type === "input_audio_buffer.speech_started") {
    if (ctx.stopPlayback) ctx.stopPlayback();
    return { handled: true, step: "barge_in" };
  }
  const transcript = event.transcript || event.delta;
  if (event.type === "response.output_audio_transcript.done" && transcript && ctx.note) {
    ctx.note(transcript);
  }
  return { handled: false };
}

if (typeof module !== "undefined") module.exports = voiceClient;
if (typeof window !== "undefined") window.voiceClient = voiceClient;

Microphone PCM worklet (JavaScript)

class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel);
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);

Desk microphone UI (JavaScript)

/* Drop into your CRM page after loading /voice_client.js and the HTML below:

  <article id="voice-card">
    <h2>Talk to the desk</h2>
    <p id="voice-status" class="muted">Checking the voice connection.</p>
    <button type="button" id="voice-button">Start microphone</button>
    <p id="voice-transcript"></p>
  </article>

  Wire showSection(section, orderId) to your CRM router/tabs.
*/

(function () {
  const voiceStatus = document.getElementById("voice-status");
  const voiceButton = document.getElementById("voice-button");
  const voiceTranscript = document.getElementById("voice-transcript");
  let voiceSocket = null;
  let voiceAudio = null;
  let voicePlayAt = 0;
  let voiceSpeaking = false;
  let toolFlight = 0;
  const playing = [];

  function noteVoice(text) {
    voiceTranscript.textContent = text;
  }

  function stopPlayback() {
    voiceSpeaking = false;
    playing.splice(0).forEach((source) => {
      try { source.stop(); } catch (_error) { /* already ended */ }
    });
    voicePlayAt = voiceAudio ? voiceAudio.currentTime : 0;
  }

  function playPcm(base64) {
    if (!voiceAudio) voiceAudio = new AudioContext({ sampleRate: 24000 });
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer);
    const floats = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index += 1) floats[index] = pcm[index] / 32768;
    const buffer = voiceAudio.createBuffer(1, floats.length, 24000);
    buffer.copyToChannel(floats, 0);
    const source = voiceAudio.createBufferSource();
    source.buffer = buffer;
    source.connect(voiceAudio.destination);
    const start = Math.max(voiceAudio.currentTime, voicePlayAt);
    source.start(start);
    playing.push(source);
    voicePlayAt = start + buffer.duration;
    voiceSpeaking = true;
    source.onended = () => {
      if (voiceAudio && voiceAudio.currentTime >= voicePlayAt - 0.05) voiceSpeaking = false;
    };
  }

  function downsample(samples, fromRate) {
    const toRate = 24000;
    if (fromRate === toRate) return samples;
    const ratio = fromRate / toRate;
    const length = Math.floor(samples.length / ratio);
    const out = new Float32Array(length);
    for (let index = 0; index < length; index += 1) out[index] = samples[Math.floor(index * ratio)];
    return out;
  }

  async function startMicrophone(socket, session) {
    if (!voiceAudio) voiceAudio = new AudioContext();
    await voiceAudio.audioWorklet.addModule("/voice-worklet.js");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = voiceAudio.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(voiceAudio, "pcm-capture");
    const rate = voiceAudio.sampleRate;
    let pending = new Float32Array(0);
    node.port.onmessage = (message) => {
      if (voiceSpeaking || socket.readyState !== WebSocket.OPEN) return;
      const next = new Float32Array(pending.length + message.data.length);
      next.set(pending);
      next.set(message.data, pending.length);
      const frame = Math.floor(rate * 0.1);
      if (next.length < frame) {
        pending = next;
        return;
      }
      const chunk = downsample(next.slice(0, frame), rate);
      pending = next.slice(frame);
      const pcm = new Int16Array(chunk.length);
      for (let index = 0; index < chunk.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, chunk[index]));
        pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      const bytes = new Uint8Array(pcm.buffer);
      let binary = "";
      for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
      socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: btoa(binary) }));
    };
    source.connect(node);
    session.microphone = stream;
  }

  // Replace with your CRM navigation.
  function showSection(section, orderId) {
    if (typeof window.crmNavigate === "function") {
      window.crmNavigate(section, orderId);
      return;
    }
    const button = document.querySelector(`[data-tab="${section}"]`);
    if (button) button.click();
    if (orderId) {
      const el = document.getElementById(orderId.toLowerCase()) || document.getElementById("order-" + orderId);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  async function toggleVoice() {
    if (voiceSocket) {
      voiceSocket.close();
      voiceSocket = null;
      stopPlayback();
      voiceButton.textContent = "Start microphone";
      voiceButton.classList.remove("live");
      return;
    }
    voiceButton.disabled = true;
    const response = await fetch("/api/voice/session", { method: "POST" });
    const payload = await response.json();
    const session = payload.detail || payload;
    voiceButton.disabled = false;
    if (!response.ok || !session.client_secret) {
      voiceStatus.textContent = session.reason || "Grok Voice is not connected. Nothing was sent.";
      return;
    }
    if (session.api_key_included) {
      voiceStatus.textContent = "The session was refused because it included the API key.";
      return;
    }
    const socket = new WebSocket(session.websocket_url, ["xai-client-secret." + session.client_secret]);
    voiceSocket = socket;
    const ctx = {
      session,
      send: (message) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message)),
      runTool: async (name, args) => {
        toolFlight += 1;
        try {
          const tool = await fetch("/api/voice/tool", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, arguments: args }),
          });
          return tool.json();
        } finally {
          toolFlight -= 1;
        }
      },
      navigate: (target) => showSection(target.section, target.order_id),
      note: noteVoice,
      playAudio: playPcm,
      stopPlayback,
      continueResponse: (sendContinue) => {
        const wait = () => {
          if (toolFlight === 0) sendContinue();
          else setTimeout(wait, 20);
        };
        setTimeout(wait, 20);
      },
    };
    socket.onopen = () => {
      voiceButton.textContent = "Stop microphone";
      voiceButton.classList.add("live");
      voiceStatus.textContent = "Microphone is live. Ask for an order, or ask to open Orders, Operations, or Actions.";
    };
    socket.onmessage = async (message) => {
      const event = JSON.parse(message.data);
      await voiceClient.handleServerEvent(event, ctx);
      if (event.type === "session.updated") startMicrophone(socket, session).catch((error) => {
        voiceStatus.textContent = "The microphone could not start. " + error.message;
      });
    };
    socket.onerror = () => {
      voiceStatus.textContent = "The voice connection failed. The API key stayed on the server.";
    };
    socket.onclose = () => {
      voiceSocket = null;
      voiceButton.textContent = "Start microphone";
      voiceButton.classList.remove("live");
    };
  }

  voiceButton.onclick = () => toggleVoice().catch((error) => {
    voiceStatus.textContent = error.message;
    voiceButton.disabled = false;
  });
  fetch("/api/voice/status").then((response) => response.json()).then((status) => {
    voiceStatus.textContent = status.configured
      ? "Grok Voice is available. The API key stays on the server."
      : "Grok Voice is not connected in this environment, so the microphone cannot start a live call.";
  });
})();

Voice tests (Python)

"""Grok Voice stays on the existing desk and does not reveal the API key."""

import json

from fastapi.testclient import TestClient

from shipping_invoicing.store import Store
from workspace.server import create_app
from workspace.voice import voice_followup


def _client() -> TestClient:
    return TestClient(create_app(Store(":memory:")))


def test_voice_status_reports_the_key_without_its_value(monkeypatch):
    monkeypatch.setenv("BRC_OFFLINE", "1")
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)
    missing = _client().get("/api/voice/status").json()
    assert missing["configured"] is False
    assert missing["key_exposed"] is False
    assert "value" not in missing

    monkeypatch.setenv("XAI_API_KEY", "sk-test-voice-key")
    present = _client().get("/api/voice/status").json()
    assert present == {
        "configured": True,
        "source": "environment",
        "provider": "xai",
        "voice_model": "grok-voice-latest",
        "key_exposed": False,
    }
    assert "sk-test-voice-key" not in json.dumps(present)


def test_session_refuses_to_open_when_the_key_is_missing(monkeypatch):
    monkeypatch.setenv("BRC_OFFLINE", "1")
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)
    response = _client().post("/api/voice/session")
    assert response.status_code == 503
    body = response.json()
    assert body["grok"] == "unavailable"
    assert body["api_key_included"] is False


def test_session_returns_an_ephemeral_token_and_not_the_api_key(monkeypatch):
    monkeypatch.setenv("XAI_API_KEY", "sk-test-voice-key")
    seen = {}

    class _Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b'{"value":"ephemeral-secret","expires_at":1700000000}'

    def _urlopen(request, timeout=20):
        seen["url"] = request.full_url
        seen["authorization"] = request.get_header("Authorization")
        return _Response()

    monkeypatch.setattr("workspace.grok_client.urllib.request.urlopen", _urlopen)
    response = _client().post("/api/voice/session")
    assert response.status_code == 200
    body = response.json()
    assert seen["authorization"] == "Bearer sk-test-voice-key"
    assert seen["url"].endswith("/realtime/client_secrets")
    assert body["client_secret"] == "ephemeral-secret"
    assert body["api_key_included"] is False
    assert "sk-test-voice-key" not in response.text
    assert body["websocket_url"] == "wss://api.x.ai/v1/realtime?model=grok-voice-latest"
    names = [tool["name"] for tool in body["tools"]]
    assert names == ["get_order", "list_orders", "ask_records", "navigate"]


def test_voice_tools_read_ord_3001_and_navigate():
    client = _client()
    order = client.post("/api/voice/tool", json={"name": "get_order", "arguments": {"order_id": "ORD-3001"}}).json()
    assert order["ok"] is True
    assert order["answer"]["approved_qty"] == "1200"
    assert order["answer"]["shipped_qty"] == "1200"
    assert order["answer"]["invoice_id"] == "INV-3001-1"
    assert order["navigate"] == {"section": "orders", "order_id": "ORD-3001"}
    followup = voice_followup("get_order", "call-1", order)
    assert followup[0]["item"]["call_id"] == "call-1"
    assert "1200" in followup[0]["item"]["output"]
    assert followup[1]["type"] == "response.create"

    opened = client.post("/api/voice/tool", json={
        "name": "navigate",
        "arguments": {"section": "operations"},
    }).json()
    assert opened["navigate"]["section"] == "operations"
    missing = client.post("/api/voice/tool", json={
        "name": "navigate",
        "arguments": {"section": "orders", "order_id": "ORD-9999"},
    }).json()
    assert missing["ok"] is False


def test_voice_question_uses_stored_carnaroli_records():
    client = _client()
    body = client.post("/api/voice/tool", json={
        "name": "ask_records",
        "arguments": {"message": "Why can't we fulfill ORD-3001?"},
    }).json()
    assert "750" in body["answer"]
    assert body["grok_called"] is False
    assert body["navigate"]["section"] == "orders"


def test_desk_page_keeps_the_key_off_the_browser():
    page = _client().get("/").text
    assert "getUserMedia" in page
    assert "/api/voice/session" in page
    assert "xai-client-secret." in page
    assert "XAI_API_KEY" not in page
    assert "sk-" not in page
    script = _client().get("/voice_client.js").text
    assert "function_call_output" in script
    assert "Bearer" not in script

