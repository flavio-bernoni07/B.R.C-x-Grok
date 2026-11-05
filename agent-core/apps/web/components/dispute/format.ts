import type { ClaimRow } from "@agent/lib/dispute/views";
import { eur, type PillTone, qty } from "@/components/kit";

const TYPE_LABEL: Record<string, string> = {
  shortage: "Shortage",
  pricing: "Pricing",
  damage: "Damage",
  late_delivery: "Late delivery",
  other: "Unclear",
};

export const claimTypeLabel = (t: string | null | undefined) => (t ? (TYPE_LABEL[t] ?? t) : "Unread");

/** "Shortage · €528.00 · 240 Carnaroli 1 kg". A claim of no known type with an amount (a deduction
 *  such as a promo contribution) is "Other"; with nothing to go on it is "Unclear". */
export function retailerSays(r: Pick<ClaimRow, "claim_type" | "claimed_amount" | "claimed_quantity" | "product">): string {
  const bits = [r.claim_type === "other" && r.claimed_amount != null ? "Other" : claimTypeLabel(r.claim_type)];
  if (r.claimed_amount != null) bits.push(eur(r.claimed_amount));
  const what = [r.claimed_quantity != null ? qty(r.claimed_quantity) : null, r.product].filter(Boolean).join(" ");
  if (what) bits.push(what);
  return bits.join(" · ");
}

/** Confidence as a percentage. 0.60 is "60%", never "unsure · 0.60". */
export const confidencePct = (v: number) => `${Math.round(v * 100)}%`;

/** What Grok suggests, in a word or two: "credit €528", "reject", "repay €250". The confidence has its own column. */
export function grokSays(g: ClaimRow["grok"]): string {
  if (!g) return "–";
  const d = g.decision.replace(/_/g, " ");
  return g.amount != null && g.decision !== "reject" ? `${d} ${eur(g.amount, g.amount % 1 ? 2 : 0)}` : d;
}

export function outcomePill(r: Pick<ClaimRow, "status" | "outcome">): { tone: PillTone; label: string } {
  if (r.status === "awaiting_sign_off" || r.status === "action_required" || r.status === "customer_reported") {
    return { tone: "attention", label: "Needs a person" };
  }
  if (r.status === "reopened" || r.status === "awaiting_customer_evidence") return { tone: "attention", label: "Reopened" };
  if (r.status === "investigating") return { tone: "wait", label: "Investigating" };
  if (r.status === "resolved" || r.status === "closed") return { tone: "ok", label: "Closed" };
  if (r.outcome?.kind === "credit_note") return { tone: "ok", label: "Credit note" };
  if (r.outcome?.kind === "reject_reply") return { tone: "ok", label: "Reply sent" };
  return { tone: "wait", label: "Checking" };
}

export const decisionLabel = (d: string | null | undefined) => (d ? d.charAt(0).toUpperCase() + d.slice(1) : "–");

const SOURCE_KIND: Record<string, string> = {
  order: "Order",
  desadv: "DESADV",
  invoice: "Invoice",
  ddt: "DDT",
  pod: "POD",
  warehouse_event: "Warehouse",
  contract: "Contract",
  contract_excerpt: "Contract",
  threeway: "Threeway",
  playbook: "Playbook",
  damage_photo: "Photo",
  other: "Other",
};
export const sourceKindLabel = (k: string) => SOURCE_KIND[k] ?? k;

export const DOC_LABEL: Record<string, string> = {
  td04_xml: "TD04",
  edi_invoic_381: "INVOIC 381",
  reject_reply: "Reply",
  outcome_json: "Outcome JSON",
};
