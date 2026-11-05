/**
 * Ephemeral xAI realtime secret for a browser voice socket.
 * The permanent API key stays on the server.
 */
import { mintRealtimeClientSecret, voiceCapabilities } from "@agent/lib/grok/voice";

export async function POST() {
  const caps = voiceCapabilities();
  if (!caps.realtime_ephemeral) {
    return Response.json(
      { error: "Grok Voice needs an API key on the server.", voice: caps },
      { status: 503 },
    );
  }
  try {
    const secret = await mintRealtimeClientSecret({ expiresAfterSeconds: 60 });
    return Response.json({
      url: secret.url,
      expires_at: secret.expires_at,
      model: secret.model,
      protocols: secret.protocols,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not mint a voice token.";
    return Response.json({ error: message.replace(/xai-[A-Za-z0-9_-]{8,}/g, "…"), voice: caps }, { status: 502 });
  }
}
