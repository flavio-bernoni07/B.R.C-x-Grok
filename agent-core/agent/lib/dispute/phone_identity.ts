/**
 * Map inbound caller numbers to the simulated Esselunga session for the hackathon demo.
 *
 * Env: BRC_PHONE_ALLOWLIST=+39333...,+1415...  (comma-separated E.164)
 * Unknown callers still get Esselunga for the jury demo when BRC_PHONE_DEMO_OPEN=1 (default).
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
  return true; // default open for hackathon jury calls
}

export type PhoneSessionResult =
  | { ok: true; session: SimulatedRetailerSession; caller: string | null; matched_allowlist: boolean }
  | { ok: false; reason: string; caller: string | null };

/** Resolve a simulated retailer session from the SIP From header. */
export function resolvePhoneSession(erp: Erp, callerRaw: string | null): PhoneSessionResult {
  const caller = callerRaw ? normalizePhone(callerRaw) : null;
  const allow = phoneAllowlist();
  const matched = Boolean(caller && allow.some((a) => a === caller || caller.endsWith(a.replace(/^\+/, ""))));

  if (allow.length && caller && !matched && !demoOpenToAnyCaller()) {
    return { ok: false, reason: "caller_not_allowlisted", caller };
  }

  try {
    const session = simulatedSession(erp, DEMO_RETAILER_GLN);
    return { ok: true, session, caller, matched_allowlist: matched };
  } catch (err) {
    return { ok: false, reason: (err as Error).message, caller };
  }
}
