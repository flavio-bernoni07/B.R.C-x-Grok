/**
 * Plain-language reading of a sign-off case for the Home and Actions inbox: the problem in one
 * line, the responsible role, the money at stake (only when the proposal holds an amount), and
 * the autonomy status. Pure functions, safe to import in the browser.
 */
import type { Signoff } from "./erp";

type P = Record<string, unknown>;
const obj = (v: unknown): P | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as P) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const ROLE: Record<string, string> = { order: "Order desk", shipping: "Warehouse lead", dispute: "Credit desk", purchasing: "Purchasing" };

export function caseRole(c: Pick<Signoff, "row" | "reasons"> & { proposal?: unknown }): string {
  const named = obj(c.proposal)?.role;
  const fromReason = typeof named === "string" ? named : (c.reasons ?? []).map((r) => /role (\w+)/.exec(r)?.[1]).find(Boolean);
  return fromReason ? fromReason.replace(/_/g, " ").replace(/^./, (s) => s.toUpperCase()) : ROLE[c.row] ?? c.row;
}

/** Money in the proposal: an explicit amount, or the order value of the lines. Undefined when none. */
export function caseAmount(c: Pick<Signoff, "proposal">): { eur: number; label: string } | undefined {
  const p = obj(c.proposal);
  if (!p) return undefined;
  const verdict = obj(p.verdict);
  const intake = obj(p.intake);
  const direct =
    num(p.amount) ??
    num(p.financial_impact_eur) ??
    num(verdict?.amount) ??
    num(obj(verdict?.claim)?.amount) ??
    num(intake?.claimed_amount);
  if (direct != null) return { eur: direct, label: "at stake" };
  if (Array.isArray(p.lines)) {
    let total = 0;
    let any = false;
    for (const l of p.lines) {
      const line = obj(l);
      const q = num(line?.qty_confirmed) ?? num(line?.quantity);
      const price = num(line?.unit_price);
      if (q != null && price != null) {
        total += q * price;
        any = true;
      }
    }
    if (any) return { eur: Math.round(total * 100) / 100, label: "order value" };
  }
  return undefined;
}

export type Autonomy = "Approval required" | "Blocked" | "Done";

export function caseAutonomy(c: Pick<Signoff, "status" | "reasons" | "decidedAt">): Autonomy {
  if (c.status !== "pending" || c.decidedAt) return "Done";
  const text = (c.reasons ?? []).join(" ").toLowerCase();
  return /missing|no source|not found/.test(text) ? "Blocked" : "Approval required";
}

/** The problem in one line: the case title, else its kind. */
export const caseProblem = (c: Pick<Signoff, "title" | "kind">) => c.title ?? c.kind.replace(/_/g, " ");

/** The proposed next step in plain words. */
export function caseNextStep(c: Pick<Signoff, "row" | "kind" | "proposal">): string {
  const p = obj(c.proposal) ?? {};
  if (c.row === "order" && c.kind === "confirm") return "Confirm the order and send the ORDRSP";
  if (c.row === "order") return "Fix the order lines, then confirm";
  if (c.row === "shipping") {
    const acts = Array.isArray(p.actions) ? p.actions.map((a) => String(obj(a)?.action ?? "")).filter(Boolean) : [];
    return acts.length ? `Approve ${acts.join(", ").replace(/_/g, " ").toLowerCase()}` : "Approve the proposed resolution";
  }
  if (c.kind === "customer_dispute") {
    const channel = p.channel === "phone" ? "phone" : "chat";
    return `Review the ${channel} claim (no money issued automatically)`;
  }
  const d = obj(p.verdict)?.decision;
  return typeof d === "string" ? `${d.charAt(0).toUpperCase()}${d.slice(1).replace(/_/g, " ")} the claim` : "Decide the claim";
}

/** Urgency: blocked and money cases first, then by age. */
export function caseUrgency(c: Pick<Signoff, "status" | "reasons" | "proposal" | "row" | "decidedAt">): "High" | "Normal" | "None" {
  if (c.status !== "pending" || c.decidedAt) return "None";
  if (caseAutonomy(c) === "Blocked" || c.row === "order" || c.row === "shipping") return "High";
  return "Normal";
}

/** The order a case is about, when it can be read from the case. */
export function caseOrderRef(c: Pick<Signoff, "row" | "subjectRef" | "proposal" | "title">): string | undefined {
  if (c.row === "order") return c.subjectRef ?? undefined;
  const p = obj(c.proposal) ?? {};
  const intake = obj(p.intake);
  const fromClaim =
    obj(obj(p.verdict)?.claim)?.order_ref ??
    obj(obj(p.facts)?.claim)?.order_ref ??
    p.order_ref ??
    intake?.order_ref;
  if (typeof fromClaim === "string") return fromClaim;
  const t = /\bon ([A-Z0-9][A-Z0-9-]+\d)\b/.exec((c as { title?: string | null }).title ?? "");
  return t?.[1];
}
