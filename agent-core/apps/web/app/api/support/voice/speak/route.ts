/** Optional TTS for reading the assistant reply aloud. */
import { speakText, voiceCapabilities } from "@agent/lib/dispute/voice";

export async function POST(request: Request) {
  const caps = voiceCapabilities();
  if (!caps.speech) {
    return Response.json({ error: "TTS unavailable without XAI_API_KEY.", voice: caps }, { status: 503 });
  }
  const body = (await request.json().catch(() => ({}))) as { text?: string };
  if (!body.text?.trim()) return Response.json({ error: "text is required" }, { status: 400 });
  try {
    const spoken = await speakText(body.text);
    return new Response(Buffer.from(spoken.audio), {
      status: 200,
      headers: {
        "Content-Type": spoken.mediaType,
        "X-Voice-Mode": spoken.mode,
      },
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
