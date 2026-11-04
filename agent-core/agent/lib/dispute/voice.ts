/**
 * Server-side voice helpers for the customer dispute chat.
 *
 * - Ephemeral realtime tokens (API key never sent to the browser)
 * - Speech-to-text via xAI transcription
 * - Text-to-speech for optional read-aloud of Grok replies
 *
 * Confirmed transcript text still goes through handleCustomerMessage — voice never
 * submits a dispute on its own.
 */
import { createXai } from "@ai-sdk/xai";
import { generateSpeech, transcribe } from "ai";
import { apiKey, hasKey } from "../grok/client";

export type VoiceCapability = {
  key_configured: boolean;
  transcription: boolean;
  speech: boolean;
  realtime_ephemeral: boolean;
  browser_speech_fallback: true;
};

export function voiceCapabilities(): VoiceCapability {
  const key = hasKey();
  return {
    key_configured: key,
    transcription: key,
    speech: key,
    realtime_ephemeral: key,
    browser_speech_fallback: true,
  };
}

function xai() {
  const key = apiKey();
  if (!key) throw new Error("Missing XAI_API_KEY or GROK_API_KEY for voice.");
  return createXai({ apiKey: key, baseURL: process.env.XAI_BASE_URL || undefined });
}

/** Mint a short-lived client secret for browser WebSocket realtime (no permanent key in the client). */
export async function mintRealtimeClientSecret(opts: { expiresAfterSeconds?: number } = {}): Promise<{
  token: string;
  url: string;
  expires_at?: number;
  model: string;
  protocols: string[];
}> {
  const model = process.env.XAI_VOICE_MODEL?.trim() || "grok-voice-latest";
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

/** Transcribe a recorded audio blob (webm/wav/mp3/…) with xAI. */
export async function transcribeAudio(audio: Uint8Array | Buffer): Promise<{
  text: string;
  mode: "xai_transcription";
}> {
  const result = await transcribe({
    model: xai().transcription(),
    audio,
  });
  const text = (result.text ?? "").trim();
  if (!text) throw new Error("Transcription returned empty text. Try again or type your message.");
  return { text, mode: "xai_transcription" };
}

/** Optional TTS for reading the assistant reply aloud. */
export async function speakText(text: string): Promise<{
  audio: Uint8Array;
  mediaType: string;
  mode: "xai_speech";
}> {
  const clipped = text.trim().slice(0, 4000);
  if (!clipped) throw new Error("Nothing to speak.");
  const result = await generateSpeech({
    model: xai().speech(),
    text: clipped,
    voice: process.env.XAI_SPEECH_VOICE?.trim() || "eve",
  });
  return {
    audio: result.audio.uint8Array,
    mediaType: result.audio.mediaType || "audio/mpeg",
    mode: "xai_speech",
  };
}
