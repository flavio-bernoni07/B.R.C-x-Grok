/**
 * Grok Voice for the dashboard. The permanent key stays in this process.
 *
 * Next does not load agent-core/.env.local (eve does, for the chat). This module reads that
 * file when the process has no key, and never returns the key to the browser.
 * Hold-to-talk uses transcription. The ephemeral token is for a browser realtime socket.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createXai } from "@ai-sdk/xai";
import { repoRoot } from "../paths";
import { apiKey, hasKey } from "./client";

const VOICE_MODEL = "grok-voice-transcribe-2.0";
const REALTIME_MODEL = "grok-voice-latest";
const ENV_KEYS = ["XAI_API_KEY", "GROK_API_KEY", "XAI_BASE_URL", "XAI_VOICE_MODEL"] as const;

let envLoaded = false;

/** Fill missing voice env from agent-core/.env.local. Does not override a key already set. */
export function loadVoiceEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  if (hasKey()) return;
  let text = "";
  try {
    text = readFileSync(join(repoRoot(), "agent-core", ".env.local"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const name = match[1];
    if (!ENV_KEYS.includes(name as (typeof ENV_KEYS)[number])) continue;
    if (process.env[name]?.trim()) continue;
    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) process.env[name] = value;
  }
}

export type VoiceCapability = {
  key_configured: boolean;
  transcription: boolean;
  realtime_ephemeral: boolean;
};

export function voiceCapabilities(): VoiceCapability {
  loadVoiceEnv();
  const key = hasKey();
  return { key_configured: key, transcription: key, realtime_ephemeral: key };
}

function xai() {
  loadVoiceEnv();
  const key = apiKey();
  if (!key) throw new Error("Missing XAI_API_KEY or GROK_API_KEY for voice.");
  return createXai({ apiKey: key, baseURL: process.env.XAI_BASE_URL || undefined });
}

/** Short-lived client secret for a browser WebSocket. The permanent key is not in the result. */
export async function mintRealtimeClientSecret(opts: { expiresAfterSeconds?: number } = {}): Promise<{
  token: string;
  url: string;
  expires_at?: number;
  model: string;
  protocols: string[];
}> {
  const model = process.env.XAI_VOICE_MODEL?.trim() || REALTIME_MODEL;
  const realtime = xai().experimental_realtime(model);
  if (!realtime?.doCreateClientSecret || !realtime.getWebSocketConfig) {
    throw new Error("xAI realtime client secrets are not available in this SDK build.");
  }
  const secret = await realtime.doCreateClientSecret({
    expiresAfterSeconds: opts.expiresAfterSeconds ?? 60,
  });
  const ws = realtime.getWebSocketConfig({ token: secret.token, url: secret.url });
  return {
    token: secret.token,
    url: ws.url,
    expires_at: secret.expiresAt,
    model,
    protocols: ws.protocols ?? [`xai-client-secret.${secret.token}`],
  };
}

function fileExtension(mediaType: string): string {
  if (mediaType.includes("mp4") || mediaType.includes("m4a")) return "m4a";
  if (mediaType.includes("wav")) return "wav";
  if (mediaType.includes("ogg")) return "ogg";
  if (mediaType.includes("mpeg") || mediaType.includes("mp3")) return "mp3";
  return "webm";
}

/** Transcribe one hold-to-talk clip with Grok Voice. Empty audio is an error, not a guess. */
export async function transcribeAudio(audio: Uint8Array, mediaType = "audio/webm"): Promise<{
  text: string;
  mode: "grok_voice";
}> {
  loadVoiceEnv();
  const key = apiKey();
  if (!key) throw new Error("Missing XAI_API_KEY or GROK_API_KEY for voice.");
  const type = mediaType.split(";")[0]?.trim() || "audio/webm";
  const copy = new ArrayBuffer(audio.byteLength);
  new Uint8Array(copy).set(audio);
  const form = new FormData();
  form.append("model", VOICE_MODEL);
  form.append("file", new Blob([copy], { type }), `take.${fileExtension(type)}`);
  const base = (process.env.XAI_BASE_URL || "https://api.x.ai/v1").replace(/\/$/, "");
  const response = await fetch(`${base.endsWith("/v1") ? base : `${base}/v1`}/stt`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Grok Voice transcription failed (${response.status}).`);
  const data = (await response.json()) as { text?: string };
  const text = (data.text ?? "").trim();
  if (!text) throw new Error("Didn't catch that. Tap the voice bar and speak.");
  return { text, mode: "grok_voice" };
}
