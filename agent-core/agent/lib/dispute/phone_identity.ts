/**
 * Map inbound callers + spoken retailer names to a simulated retailer session.
 *
 * Env: BRC_PHONE_ALLOWLIST=+39333...,+1415...  (comma-separated E.164)
 * Unknown callers still get a session when BRC_PHONE_DEMO_OPEN=1 (default), but only after
 * the agent has a resolved retailer (or falls back to Esselunga for the jury demo).
 */
import type { Erp } from "../core/erp";
import { DEMO_RETAILER_GLN, type SimulatedRetailerSession, simulatedSession } from "./portal";

function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length >= 10) return `+${digits}`;
  return digits;
}

export function phoneAllowlist(): string[] {
  const raw = process.env.BRC_PHONE_ALLOWLIST?.trim() ?? "";
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => normalizePhone(s.trim()))
    .filter(Boolean);
}

export function demoOpenToAnyCaller(): boolean {
  const v = process.env.BRC_PHONE_DEMO_OPEN?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  return true;
}

/** Known demo aliases → GLN. Longer aliases first. */
const RETAILER_ALIASES: { match: RegExp; gln: string }[] = [
  { match: /\besselunga\b/i, gln: "BUYER001" },
  { match: /\bcarrefour\b/i, gln: "8000000000100" },
  { match: /\bconad\b/i, gln: "8000000000117" },
  { match: /\bcoop\b/i, gln: "8000000000124" },
  { match: /\bauchan\b/i, gln: "8000000000131" },
  { match: /\bbuyer001\b/i, gln: "BUYER001" },
];

/**
 * Resolve a retailer GLN from what the caller said (name or GLN).
 * Returns null if nothing matched — the voice agent should ask again.
 */
export function resolveRetailerGln(erp: Erp, spoken: string | null | undefined): string | null {
  const text = (spoken ?? "").trim();
  if (!text) return null;

  const asGln = text.toUpperCase();
  if (erp.retailer(asGln)) return asGln;

  for (const { match, gln } of RETAILER_ALIASES) {
    if (match.test(text) && erp.retailer(gln)) return gln;
  }

  // Fuzzy: retailer name contained in spoken text or vice versa
  const lower = text.toLowerCase();
  for (const r of erp.retailers()) {
    const name = r.name.toLowerCase();
    if (lower.includes(name) || name.includes(lower)) return r.gln;
  }
  return null;
}

export function listRetailerHints(erp: Erp): { gln: string; name: string }[] {
  return erp.retailers().map((r) => ({ gln: r.gln, name: r.name }));
}

export type PhoneSessionResult =
  | { ok: true; session: SimulatedRetailerSession; caller: string | null; matched_allowlist: boolean; retailer_gln: string }
  | { ok: false; reason: string; caller: string | null; missing?: string };

/** Resolve a simulated retailer session from SIP From + optional spoken retailer. */
export function resolvePhoneSession(
  erp: Erp,
  callerRaw: string | null,
  opts: { retailerSpoken?: string | null; defaultGln?: string | null } = {},
): PhoneSessionResult {
  const caller = callerRaw ? normalizePhone(callerRaw) : null;
  const allow = phoneAllowlist();
  const matched = Boolean(caller && allow.some((a) => a === caller || caller.endsWith(a.replace(/^\+/, ""))));

  if (allow.length && caller && !matched && !demoOpenToAnyCaller()) {
    return { ok: false, reason: "caller_not_allowlisted", caller };
  }

  const fromSpeech = resolveRetailerGln(erp, opts.retailerSpoken);
  const gln = fromSpeech ?? opts.defaultGln ?? null;

  if (!gln) {
    return {
      ok: false,
      reason: "retailer_required",
      caller,
      missing: "retailer",
    };
  }

  try {
    const session = simulatedSession(erp, gln);
    return { ok: true, session, caller, matched_allowlist: matched, retailer_gln: gln };
  } catch (err) {
    return { ok: false, reason: (err as Error).message, caller };
  }
}
