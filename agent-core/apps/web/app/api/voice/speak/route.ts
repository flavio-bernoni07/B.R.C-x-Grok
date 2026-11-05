/**
 * Speak one grounded answer in Grok's voice. The browser sends the agent's text.
 * The permanent key stays on the server. The body is audio/mpeg.
 */
import { speakText, voiceCapabilities } from "@agent/lib/grok/voice";

function clientError(err: unknown): string {
  const message = err instanceof Error ? err.message : "Grok Voice didn't speak.";
  const safe = message.replace(/xai-[A-Za-z0-9_-]{8,}/g, "…");
  if (/missing api key|unauthorized|invalid api key|401/i.test(safe)) return "Grok Voice needs an API key on the server.";
  if (safe.length > 180) return "Grok Voice didn't speak. Try again.";
  return safe;
}

export async function POST(request: Request) {
  const caps = voiceCapabilities();
  if (!caps.transcription) {
    return Response.json({ error: "Grok Voice needs an API key on the server." }, { status: 503 });
  }
  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ error: "Send JSON { text }." }, { status: 400 });
  if (text.length > 700) return Response.json({ error: "That answer is too long to speak." }, { status: 413 });

  try {
    const audio = await speakText(text);
    const copy = new ArrayBuffer(audio.byteLength);
    new Uint8Array(copy).set(audio);
    return new Response(new Blob([copy], { type: "audio/mpeg" }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return Response.json({ error: clientError(err) }, { status: 502 });
  }
}
