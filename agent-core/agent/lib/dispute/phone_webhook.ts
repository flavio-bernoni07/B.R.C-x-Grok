/**
 * Standard Webhooks verification for xAI realtime.call.incoming (SIP / free number).
 * Signed content: `{webhook-id}.{webhook-timestamp}.{raw-body}` with HMAC-SHA256
 * keyed by base64-decoded secret after the `whsec_` prefix.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

export function readWebhookHeaders(request: Request): WebhookHeaders {
  return {
    id: request.headers.get("webhook-id"),
    timestamp: request.headers.get("webhook-timestamp"),
    signature: request.headers.get("webhook-signature"),
  };
}

export function webhookSecret(): string | null {
  for (const name of ["XAI_VOICE_WEBHOOK_SECRET", "XAI_WEBHOOK_SECRET"]) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return null;
}

/** Verify Standard Webhooks signature. Returns false on missing/stale/bad signatures. */
export function verifyWebhookSignature(
  body: string,
  headers: WebhookHeaders,
  secret: string,
  opts: { nowSeconds?: number; maxAgeSeconds?: number } = {},
): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAge = opts.maxAgeSeconds ?? 5 * 60;
  if (Math.abs(now - ts) > maxAge) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (!key.length) return false;
  const signed = `${headers.id}.${headers.timestamp}.${body}`;
  const digest = createHmac("sha256", key).update(signed, "utf8").digest("base64");
  const expected = `v1,${digest}`;

  const candidates = headers.signature.split(/\s+/).filter(Boolean);
  return candidates.some((candidate) => {
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/** Sign a body the same way xAI does — used in tests. */
export function signWebhookBody(
  body: string,
  secret: string,
  headers: { id: string; timestamp: string },
): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signed = `${headers.id}.${headers.timestamp}.${body}`;
  return `v1,${createHmac("sha256", key).update(signed, "utf8").digest("base64")}`;
}

export type IncomingCallEvent = {
  type: string;
  data?: {
    call_id?: string;
    sip_headers?: { name: string; value: string }[];
    metadata?: Record<string, unknown>;
  };
};

export function extractCallerFrom(event: IncomingCallEvent): string | null {
  const headers = event.data?.sip_headers ?? [];
  const from = headers.find((h) => h.name.toLowerCase() === "from")?.value ?? null;
  if (!from) return null;
  // SIP From may look like: "Name" <sip:+14155550100@…>;tag=… or bare +E.164
  const m = from.match(/(\+?\d{8,15})/);
  return m?.[1] ?? (from.trim() || null);
}

export function extractCallId(event: IncomingCallEvent): string | null {
  const id = event.data?.call_id?.trim();
  return id || null;
}
