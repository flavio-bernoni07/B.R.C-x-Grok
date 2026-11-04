/**
 * Transcribe recorded microphone audio. Returns draft text for customer confirmation.
 * Does not create a dispute.
 */
import { transcribeAudio, voiceCapabilities } from "@agent/lib/dispute/voice";

export async function POST(request: Request) {
  const caps = voiceCapabilities();
  if (!caps.transcription) {
    return Response.json(
      {
        error: "Server transcription unavailable. Use the browser speech fallback or type your message.",
        voice: caps,
        fallback: "browser_speechRecognition",
      },
      { status: 503 },
    );
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof Blob)) {
    return Response.json({ error: "Send multipart form field `audio` with the recording." }, { status: 400 });
  }
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (!buf.byteLength) return Response.json({ error: "Empty audio recording." }, { status: 400 });
    const result = await transcribeAudio(buf);
    return Response.json({
      draft_text: result.text,
      mode: result.mode,
      needs_confirmation: true,
      note: "Edit the draft if needed, then Send — a dispute is created only after the chat backend confirms success.",
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message, voice: caps }, { status: 502 });
  }
}
