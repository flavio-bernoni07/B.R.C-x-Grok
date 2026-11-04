/**
 * Mint an ephemeral xAI realtime client secret for browser WebSocket voice.
 * Permanent XAI_API_KEY stays server-side.
 */
import { mintRealtimeClientSecret, voiceCapabilities } from "@agent/lib/dispute/voice";

export async function POST() {
  const caps = voiceCapabilities();
  if (!caps.realtime_ephemeral) {
    return Response.json(
      {
        error: "Voice realtime unavailable: set XAI_API_KEY (or GROK_API_KEY) on the server.",
        voice: caps,
      },
      { status: 503 },
    );
  }
  try {
    const secret = await mintRealtimeClientSecret({ expiresAfterSeconds: 60 });
    return Response.json({
      ...secret,
      // Never return the permanent API key.
      instructions:
        "Connect with protocols: xai-client-secret.<token>. Use speech for drafting only; confirmed text must POST /api/support/chat before a dispute is created.",
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message, voice: caps }, { status: 502 });
  }
}
