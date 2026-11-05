/**
 * Hold-to-talk clip → Grok Voice transcript. Does not write a record or send a message.
 * The dashboard posts the text into the existing agent thread after this returns.
 */
import { transcribeAudio, voiceCapabilities } from "@agent/lib/grok/voice";

function clientError(err: unknown): string {
  const message = err instanceof Error ? err.message : "Grok Voice didn't answer.";
  const safe = message.replace(/xai-[A-Za-z0-9_-]{8,}/g, "…");
  if (/missing api key|unauthorized|invalid api key|401/i.test(safe)) return "Grok Voice needs an API key on the server.";
  if (safe.length > 180) return "Grok Voice didn't answer. Try again.";
  return safe;
}

export async function POST(request: Request) {
  const caps = voiceCapabilities();
  if (!caps.transcription) {
    return Response.json({ error: "Grok Voice needs an API key on the server.", voice: caps }, { status: 503 });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof Blob)) {
    return Response.json({ error: "Send multipart form field `audio` with the recording." }, { status: 400 });
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!buf.byteLength) return Response.json({ error: "Empty audio recording." }, { status: 400 });
  if (buf.byteLength > 8_000_000) return Response.json({ error: "Recording is too long." }, { status: 413 });

  try {
    const result = await transcribeAudio(buf, file.type || "audio/webm");
    return Response.json({ text: result.text, mode: result.mode });
  } catch (err) {
    return Response.json({ error: clientError(err), voice: caps }, { status: 502 });
  }
}
