/**
 * Read models for the Disputes page, its API routes and the dispute_* tools: one list row per
 * claim and one detail per claim, built from the Mini ERP (claims, documents, sign-offs, audit).
 * Embedded JSON documents (extraction, verdict, facts, outcome) keep their Python key names.
 */
import type { AuditEntry, Erp, Signoff } from "../core/erp";
import type { ClaimExtraction } from "./claim_reader";
import type { MiniErpStore } from "./mini_erp";
import type { DisputeOutcome } from "./outcome";
import { type DisputeFacts, pullFacts } from "./pull_facts";
import { disputeStore, OUTCOME_KINDS } from "./service";
import type { DisputeVerdict } from "./verdict";

export type StoredVerdict = DisputeVerdict & { claim?: ClaimExtraction };

export type ClaimRow = {
  claim_id: string;
  received_at: string;
  status: string;
  order_ref: string | null;
  invoice_ref: string | null;
  customer: string | null;
  claim_type: string | null;
  claimed_amount: number | null;
  claimed_quantity: number | null;
  product: string | null;
  /** How the retailer opened it: phone / customer_chat from portal intake, else null (email paste). */
  channel: "phone" | "customer_chat" | null;
  grok: {
    decision: string;
    amount: number | null;
    confidence: number;
    /** The lower of the verdict's and the claim reading's confidence. */
    lowest_confidence: number;
    sources: number;
    needs_sign_off: boolean;
    sign_off_reasons: string[];
  } | null;
  outcome: { kind: string; credit_note_number: string | null; approved_by: string | null; amount: number | null } | null;
  signoff: { case_id: string; status: string; kind: string; decided_by: string | null } | null;
};

export type OutcomeDocument = { doc_id: string; kind: string; key: string; path: string | null; created_at: string; body: string | null };

export type ClaimDetail = ClaimRow & {
  email: { doc_id: string; source: string | null; body: string | null } | null;
  extraction: ClaimExtraction | null;
  verdict: StoredVerdict | null;
  facts: DisputeFacts | null;
  /** Where the facts shown come from: the sign-off proposal (as Grok saw them) or pulled again now. */
  facts_from: "sign-off proposal" | "pulled again from the Mini ERP" | null;
  outcome_full: DisputeOutcome | null;
  documents: OutcomeDocument[];
  signoff_case: Signoff | null;
  audit: AuditEntry[];
};

const KIND_TO_KEY = Object.fromEntries(Object.entries(OUTCOME_KINDS).map(([k, v]) => [v, k]));

function latestSignoff(erp: Erp, claimId: string): Signoff | null {
  const all = erp.signoffs({ row: "dispute" }).filter((s) => s.subjectRef === claimId);
  return all.at(-1) ?? null;
}

function portalChannel(extraction: ClaimExtraction | null): "phone" | "customer_chat" | null {
  const portal = extraction && typeof extraction === "object" ? (extraction as { portal?: { channel?: string } }).portal : undefined;
  if (portal?.channel === "phone") return "phone";
  if (portal?.channel === "customer_chat" || portal?.channel === "customer_portal") return "customer_chat";
  return null;
}

function rowOf(erp: Erp, claimId: string, store: MiniErpStore): ClaimRow | null {
  const c = erp.claim(claimId);
  if (!c) return null;
  const extraction = c.extraction as ClaimExtraction | null;
  const verdict = c.verdict as StoredVerdict | null;
  const outcome = c.outcome as DisputeOutcome | null;
  const so = latestSignoff(erp, claimId);
  const [order] = store.findOrder(c.orderRef ?? extraction?.order_ref ?? null);
  const sources = verdict ? verdict.points.filter((p) => p.source?.ref && p.source.ref !== "unspecified").length : 0;
  const channel = portalChannel(extraction);
  return {
    claim_id: c.claimId,
    received_at: c.receivedAt,
    status: c.status,
    order_ref: c.orderRef ?? null,
    invoice_ref: c.invoiceRef ?? null,
    customer: (order?.customer as string | undefined) ?? null,
    claim_type: extraction?.claim_type ?? null,
    claimed_amount: extraction?.amount ?? null,
    claimed_quantity: extraction?.quantity ?? null,
    product: extraction?.product ?? null,
    channel,
    grok: verdict
      ? {
          decision: verdict.decision,
          amount: verdict.amount,
          confidence: verdict.confidence,
          lowest_confidence: Math.min(verdict.confidence, extraction?.confidence ?? 1),
          sources,
          needs_sign_off: verdict.needs_sign_off,
          sign_off_reasons: verdict.sign_off_reasons ?? [],
        }
      : null,
    outcome: outcome
      ? { kind: outcome.kind, credit_note_number: outcome.credit_note_number, approved_by: outcome.approved_by, amount: outcome.amount }
      : null,
    signoff: so ? { case_id: so.caseId, status: so.status, kind: so.kind, decided_by: so.decidedBy ?? null } : null,
  };
}

/** Every claim, newest first. */
export function listClaims(erp: Erp): ClaimRow[] {
  const store = disputeStore(erp);
  return erp
    .claims()
    .map((c) => rowOf(erp, c.claimId, store)!)
    .reverse();
}

/** One claim with everything behind it: email, extraction, facts, verdict, outcome documents, sign-off, audit. */
export function claimDetail(erp: Erp, claimId: string): ClaimDetail | null {
  const store = disputeStore(erp);
  const row = rowOf(erp, claimId, store);
  if (!row) return null;
  const c = erp.claim(claimId)!;
  const so = latestSignoff(erp, claimId);
  const emailDoc = c.sourceDoc ? erp.document(c.sourceDoc) : undefined;

  let facts: DisputeFacts | null = null;
  let factsFrom: ClaimDetail["facts_from"] = null;
  const proposalFacts = so?.proposal?.facts as DisputeFacts | undefined;
  if (proposalFacts) {
    facts = proposalFacts;
    factsFrom = "sign-off proposal";
  } else if (c.extraction) {
    facts = pullFacts(c.extraction, { store });
    factsFrom = "pulled again from the Mini ERP";
  }

  const documents: OutcomeDocument[] = erp
    .documents({ ref: claimId })
    .filter((d) => d.kind in KIND_TO_KEY)
    .map((d) => ({ doc_id: d.docId, kind: d.kind, key: KIND_TO_KEY[d.kind], path: d.path ?? null, created_at: d.createdAt, body: d.body ?? null }));

  return {
    ...row,
    email: emailDoc ? { doc_id: emailDoc.docId, source: emailDoc.path ?? null, body: emailDoc.body ?? null } : null,
    extraction: c.extraction as ClaimExtraction | null,
    verdict: c.verdict as StoredVerdict | null,
    facts,
    facts_from: factsFrom,
    outcome_full: c.outcome as DisputeOutcome | null,
    documents,
    signoff_case: so,
    audit: erp.auditLog(claimId),
  };
}
