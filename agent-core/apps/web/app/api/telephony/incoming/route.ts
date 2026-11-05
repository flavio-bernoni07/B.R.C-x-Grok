/**
 * xAI inbound SIP / free-number webhook.
 * Verifies Standard Webhooks signature, then joins the call in the background.
 */
import { getReadyErp } from "@agent/lib/db/app";
import { handleIncomingPhoneCall } from "@agent/lib/dispute/phone_agent";
import {
  extractCallerFrom,
  extractCallId,
  readWebhookHeaders,
  type IncomingCallEvent,
  verifyWebhookSignature,
  webhookSecret,
} from "@agent/lib/dispute/phone_webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const headers = readWebhookHeaders(request);
  const secret = webhookSecret();

  // In production demos always require a secret. Allow unsigned only when explicitly opted in for local fixture posts.
  const allowUnsigned = process.env.BRC_PHONE_ALLOW_UNSIGNED_WEBHOOK === "1";
  if (!secret && !allowUnsigned) {
    return Response.json({ error: "XAI_VOICE_WEBHOOK_SECRET not configured" }, { status: 503 });
  }
  if (secret && !verifyWebhookSignature(rawBody, headers, secret)) {
    return Response.json({ error: "invalid webhook signature" }, { status: 401 });
  }

  let event: IncomingCallEvent;
  try {
    event = JSON.parse(rawBody) as IncomingCallEvent;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  if (event.type !== "realtime.call.incoming") {
    return Response.json({ ok: true, ignored: event.type });
  }

  const callId = extractCallId(event);
  if (!callId) return Response.json({ error: "missing call_id" }, { status: 400 });
  const caller = extractCallerFrom(event);

  // Acknowledge quickly; join the realtime session asynchronously.
  const erp = await getReadyErp();
  void handleIncomingPhoneCall(erp, { callId, caller }).catch((err) => {
    console.error("[telephony/incoming]", callId, err);
  });

  return Response.json({ ok: true, call_id: callId, caller });
}
