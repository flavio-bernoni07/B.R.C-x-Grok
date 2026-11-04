/**
 * Claim reader: extract structured fields from a retailer claim email via Grok
 * (port of dispute/claim_reader.py).
 *
 * Grok proposes the JSON; code normalizes it and never invents a reference: a missing or
 * unreadable order / invoice ref stays null. Remittance PRI / PRI/UNK and short-pay price text
 * become claim_type "pricing".
 *
 * Live calls need XAI_API_KEY or GROK_API_KEY (agent/lib/grok/client.ts). `caller` replaces the
 * network (tests, recorded answers); without both, reading fails clearly.
 */
import { readFileSync, statSync } from "node:fs";
import { type Caller, chatJson, hasKey, type Message, MissingApiKeyError, modelFor } from "../grok/client";

export const ClaimType = {
  SHORTAGE: "shortage",
  PRICING: "pricing",
  DAMAGE: "damage",
  LATE_DELIVERY: "late_delivery",
  OTHER: "other",
} as const;
export type ClaimType = (typeof ClaimType)[keyof typeof ClaimType];

export const CLAIM_TYPES: ReadonlySet<string> = new Set(Object.values(ClaimType));

export { MissingApiKeyError };

export const EXTRACTION_SCHEMA_HINT = `
Return a single JSON object only (no markdown), with these keys:
  order_ref: string or null — purchase order / ORDERS reference as written or normalized if clear
  invoice_ref: string or null — invoice / FatturaPA / INVOIC number
  product: string or null — product name or SKU mentioned
  quantity: number or null — disputed quantity (pieces/cartons as stated)
  amount: number or null — disputed amount in euro (numeric, no currency symbol)
  claim_type: one of "shortage" | "pricing" | "damage" | "late_delivery" | "other"
  confidence: number from 0 to 1 — how sure you are of the extraction
  raw_notes: short string — typos, missing refs, ambiguity, or other useful notes

Rules:
- Do not invent order_ref or invoice_ref. If missing or unreadable, use null.
- Prefer null over guessing when a field is absent.
- claim_type must be exactly one of the allowed values.
- Remittance / short-payment texts with price reason codes (PRI, PRI/UNK) or
  unit-price / promo variance → claim_type "pricing" (not "other").
- Tolerate Italian and English, typos, and remittance/short-payment style texts.
`.trim();

// Remittance short-pays often arrive as portal "other" / PRI/UNK; map to pricing.
const PRICING_MARKERS = [
  "pri/unk",
  "pri_unk",
  "reason code: pri",
  "reason code on remittance: pri",
  "short-pay",
  "short pay",
  "shortpaid",
  "paid short",
  "invoice paid short",
  "price variance",
  "price hold",
  "unit price",
  "promo price",
  "promo agreement",
  "list price",
  "listino",
];

/** Structured claim fields (a JSON document: Python key names). */
export type ClaimExtraction = {
  order_ref: string | null;
  invoice_ref: string | null;
  product: string | null;
  quantity: number | null;
  amount: number | null;
  claim_type: ClaimType;
  confidence: number;
  raw_notes: string;
};

/** The model for the claim reader (XAI_MODEL_DISPUTE_READ_CLAIM, XAI_MODEL, GROK_MODEL, default). */
export const model = () => modelFor("dispute.read_claim");

const NULL_WORDS = new Set(["null", "none", "n/a", "na", "-"]);

export function nullStr(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || NULL_WORDS.has(text.toLowerCase())) return null;
    return text;
  }
  return String(value).trim() || null;
}

export function nullFloat(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim().replace(/,/g, ".").replace(/€/g, "").replace(/EUR/g, "").trim();
    if (!text || NULL_WORDS.has(text.toLowerCase())) return null;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;
    return Number(text);
  }
  return null;
}

/** True when remittance / PRI/UNK / short-pay language points at a price dispute. */
export function looksLikePricingRemittance(...texts: (string | null | undefined)[]): boolean {
  const blob = texts.filter((t): t is string => !!t).join(" ").toLowerCase();
  if (!blob) return false;
  if (PRICING_MARKERS.some((m) => blob.includes(m))) return true;
  // Remittance feed + price/PRI token (portal often leaves claim type blank).
  if (blob.includes("remittance") && ["pri", "price", "prezzo", "€", "eur"].some((t) => blob.includes(t))) return true;
  return false;
}

/** Post-process claim_type: only `other` is upgraded to pricing on remittance signals. */
export function refineClaimType(claimType: ClaimType, opts: { rawNotes?: string; claimText?: string } = {}): ClaimType {
  if (claimType !== ClaimType.OTHER) return claimType;
  if (looksLikePricingRemittance(opts.rawNotes ?? "", opts.claimText ?? "")) return ClaimType.PRICING;
  return claimType;
}

/** Build a ClaimExtraction from a model JSON object; never invent refs. */
export function parseExtraction(payload: Record<string, unknown>, opts: { claimText?: string } = {}): ClaimExtraction {
  let claimStr = String(payload.claim_type ?? "other")
    .trim()
    .toLowerCase()
    .replace(/ /g, "_")
    .replace(/-/g, "_");
  if (!payload.claim_type) claimStr = "other";
  if (!CLAIM_TYPES.has(claimStr)) claimStr = "other";
  let claimType = claimStr as ClaimType;

  let confidence = nullFloat(payload.confidence) ?? 0;
  confidence = Math.max(0, Math.min(1, confidence));

  const notes = payload.raw_notes;
  const rawNotes = typeof notes === "string" ? notes.trim() : notes ? String(notes) : "";
  claimType = refineClaimType(claimType, { rawNotes, claimText: opts.claimText ?? "" });

  return {
    order_ref: nullStr(payload.order_ref),
    invoice_ref: nullStr(payload.invoice_ref),
    product: nullStr(payload.product),
    quantity: nullFloat(payload.quantity),
    amount: nullFloat(payload.amount),
    claim_type: claimType,
    confidence,
    raw_notes: rawNotes,
  };
}

export function readClaimMessages(claimText: string): Message[] {
  return [
    {
      role: "system",
      content: "You extract structured dispute claim fields for Riso Scotti back office. " + EXTRACTION_SCHEMA_HINT,
    },
    { role: "user", content: "Claim email / remittance text:\n\n" + claimText },
  ];
}

/**
 * Extract a ClaimExtraction from a plain-text claim email.
 * With `caller` (tests, recorded answers) no network is used. Without a key and without a
 * caller this fails clearly: it never silently invents an extraction.
 */
export async function readClaim(claimText: string, opts: { caller?: Caller | null } = {}): Promise<ClaimExtraction> {
  const text = claimText.trim();
  if (!text) throw new Error("claim text is empty");
  if (!opts.caller && !hasKey()) {
    throw new MissingApiKeyError(
      "Missing API key. Set XAI_API_KEY or GROK_API_KEY for live claim extraction. " +
        "Use --dry-run to validate fixture loading without calling Grok.",
    );
  }
  const payload = await chatJson(readClaimMessages(text), { task: "dispute.read_claim", caller: opts.caller ?? null });
  return parseExtraction(payload, { claimText: text });
}

export function loadClaimFile(path: string): string {
  let ok = false;
  try {
    ok = statSync(path).isFile();
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`Claim fixture not found: ${path}`);
  return readFileSync(path, "utf8");
}
