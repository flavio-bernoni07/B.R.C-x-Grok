/**
 * Customer-facing dispute chat adapter.
 *
 * Reuses the shared Mini ERP claims + sign-off queue and the existing Grok client / threeway
 * pull. It never issues a credit note or admits liability: customers register claims; employees
 * decide in Actions. Auth is a clearly labeled simulated retailer session for the hackathon.
 */
import { createHash } from "node:crypto";
import type { Erp } from "../core/erp";
import { nowIso } from "../core/erp";
import { decide, requestSignoff } from "../core/signoff";
import { type Caller, chatJson, hasKey, type Message } from "../grok/client";
import { ClaimType, type ClaimExtraction, parseExtraction } from "./claim_reader";
import { type DisputeFacts, pullFacts } from "./pull_facts";
import { disputeStore } from "./service";

export const PORTAL_STATUSES = [
  "CUSTOMER_REPORTED",
  "INVESTIGATING",
  "AWAITING_CUSTOMER_EVIDENCE",
  "ACTION_REQUIRED",
  "RESOLVED",
  "CLOSED",
] as const;
export type PortalStatus = (typeof PORTAL_STATUSES)[number];

/** Simulated hackathon retailer session — not a production login. */
export type SimulatedRetailerSession = {
  retailer_id: string;
  retailer_name: string;
  simulated: true;
  label: string;
};

export const DEMO_RETAILER_GLN = "BUYER001";
/** Document kind for chat transcripts (no portal_* tables). */
export const CUSTOMER_CONV_KIND = "customer conversation";

export type ChatMessage = {
  message_id: string;
  role: "customer" | "assistant" | "system";
  content: string;
  at: string;
  meta?: Record<string, unknown> | null;
};

export type ConversationState = {
  conversation_id: string;
  retailer_gln: string;
  claim_id: string | null;
  idempotency_key: string | null;
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
};

export function simulatedSession(erp: Erp, retailerGln = DEMO_RETAILER_GLN): SimulatedRetailerSession {
  const r = erp.retailer(retailerGln);
  if (!r) throw new Error(`Unknown retailer ${retailerGln}`);
  return {
    retailer_id: r.gln,
    retailer_name: r.name,
    simulated: true,
    label: `SIMULATED retailer session — ${r.name} (hackathon demo, not a production login)`,
  };
}

function loadConversation(erp: Erp, conversationId: string): ConversationState | null {
  const doc = erp.documents({ kind: CUSTOMER_CONV_KIND, ref: conversationId })[0];
  if (!doc?.body) return null;
  try {
    return JSON.parse(doc.body) as ConversationState;
  } catch {
    return null;
  }
}

function saveConversation(erp: Erp, state: ConversationState) {
  const existing = erp.documents({ kind: CUSTOMER_CONV_KIND, ref: state.conversation_id })[0];
  const body = JSON.stringify(state);
  if (existing) erp.updateDocument(existing.docId, { body });
  else erp.addDocument(CUSTOMER_CONV_KIND, state.conversation_id, body, { path: `customer/${state.conversation_id}` });
}

function appendMessage(
  erp: Erp,
  state: ConversationState,
  msg: Omit<ChatMessage, "message_id"> & { message_id?: string },
): ConversationState {
  const next: ConversationState = {
    ...state,
    updated_at: msg.at,
    messages: [
      ...state.messages,
      {
        message_id: msg.message_id ?? erp.nextId("chat_msg", "MSG-"),
        role: msg.role,
        content: msg.content,
        at: msg.at,
        meta: msg.meta ?? null,
      },
    ],
  };
  saveConversation(erp, next);
  return next;
}

export type PortalIntake = {
  order_ref: string | null;
  invoice_ref: string | null;
  shipment_ref: string | null;
  category: ClaimType;
  claimed_quantity: number | null;
  claimed_amount: number | null;
  product: string | null;
  customer_description: string;
  missing_fields: string[];
  intent: "report" | "status" | "unauthorized_action" | "chitchat";
  language: "en" | "it";
};

export type PortalClaimRecord = {
  dispute_id: string;
  retailer_id: string;
  order_id: string | null;
  shipment_id: string | null;
  invoice_id: string | null;
  category: string;
  customer_description: string;
  claimed_quantity: number | null;
  claimed_amount: number | null;
  customer_evidence_refs: string[];
  supporting_internal_records: Record<string, unknown>;
  conversation_id: string;
  status: PortalStatus;
  assigned_role: string;
  created_at: string;
  updated_at: string;
  case_id: string | null;
  verified_quantities: Record<string, unknown> | null;
  reconciliation: Record<string, unknown> | null;
};

export type PortalTurnResult = {
  reply: string;
  conversation_id: string;
  dispute_id: string | null;
  status: PortalStatus | null;
  case_id: string | null;
  needs_follow_up: boolean;
  missing_fields: string[];
  grok_mode: "live" | "offline_deterministic";
  submitted: boolean;
  error?: string;
};

const ROLE_BY_CATEGORY: Record<string, string> = {
  shortage: "credit desk",
  pricing: "credit desk",
  damage: "quality / credit desk",
  late_delivery: "logistics desk",
  other: "credit desk",
};

const INTAKE_HINT = `
Return a single JSON object only (no markdown) with keys:
  order_ref: string or null
  invoice_ref: string or null
  shipment_ref: string or null
  category: "shortage" | "pricing" | "damage" | "late_delivery" | "other"
  claimed_quantity: number or null
  claimed_amount: number or null
  product: string or null
  customer_description: short plain-language summary of the complaint
  missing_fields: string[] — only fields still required to open a case (e.g. "order_ref")
  intent: "report" | "status" | "unauthorized_action" | "chitchat"
  language: "en" | "it"

Rules:
- Do not invent order_ref, invoice_ref or shipment_ref. Prefer null over guessing.
- intent "unauthorized_action" when the customer asks for a refund, credit note, invoice change or liability admission.
- intent "status" when they ask about an existing dispute/reference.
- Support English and Italian.
- claimed_quantity / claimed_amount are what the customer claims, not verified facts.
`.trim();

function hashKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

/** Parse a qty/amount token: `1,100` / `1.100` → 1100; `1,5` → 1.5. */
function parseNumberToken(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) {
    const n = Number(t.replace(/[.,]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function looksItalian(text: string): boolean {
  return /\b(ordine|fattura|ricevut[oi]|danneggiat|mancan|consegna| Bund|aiuto|salve|buongiorno)\b/i.test(text);
}

/** Deterministic intake when Grok is offline or a caller is injected. */
export function deterministicIntake(text: string, prior: PortalIntake | null): PortalIntake {
  const lower = text.toLowerCase();
  const italian = looksItalian(text) || prior?.language === "it";
  const orderMatch =
    text.match(/\b(ORD[- ]?\d{3,}|ESS[-A-Z0-9]+|RS\d+|PO[- ]?\d+)\b/i) ||
    text.match(/\border\s+(?:ref(?:erence)?|number|#)?\s*[:#]?\s*([A-Z0-9][-A-Z0-9]+)/i);
  const invoiceMatch = text.match(/\b(FT[-/]?\d{4}[-/]?\d+|INV[- ]?\d+)\b/i);
  // Prefer explicit received/ordered quantities; never treat the digits inside ORD-3001 as a qty.
  const scrubbed = text.replace(/\b(ORD|ESS|RS|PO|DSP|CLM|FT|DDT|DESADV)[-/]?\s*[A-Z0-9-]+/gi, " ");
  const qtyMatch =
    scrubbed.match(/\b(?:received only|only|received|ricevut[oi]\s+solo|mancano)\s+(\d{1,3}(?:[.,]\d{3})*|\d+)\b/i) ||
    scrubbed.match(/\b(\d{1,3}(?:[.,]\d{3})*|\d+)\s*(?:packages?|packs?|units?|pcs|pezzi|confezioni)\b/i);
  const amountMatch = text.match(/€\s*(\d+(?:[.,]\d+)?)/) || text.match(/\b(\d+(?:[.,]\d+)?)\s*euros?\b/i);

  let category: ClaimType = prior?.category ?? ClaimType.OTHER;
  if (/damage|broken|crushed|danneggiat|rott/.test(lower)) category = ClaimType.DAMAGE;
  else if (/price|invoice amount|fattura|prezzo|pricing|overcharg/.test(lower)) category = ClaimType.PRICING;
  else if (/late|hasn't arrived|not arrived|ritardo|non.*arrivat/.test(lower)) category = ClaimType.LATE_DELIVERY;
  else if (/fewer|shortage|short|received only|ricevut|mancan|wrong product|prodotti sbagliat/.test(lower)) {
    category = /wrong product|prodotti sbagliat/.test(lower) ? ClaimType.OTHER : ClaimType.SHORTAGE;
  }

  let intent: PortalIntake["intent"] = "report";
  if (/refund|credit note|nota di credito|change the invoice|admit|liability|compensa/.test(lower)) intent = "unauthorized_action";
  else if (/status|stato|where is (my|the) (dispute|case|claim)|riferimento/.test(lower) && !/report|received only|shortage/.test(lower)) {
    intent = "status";
  } else if (/^(hi|hello|hey|ciao|salve|buongiorno)\b/.test(lower.trim()) && text.trim().split(/\s+/).length < 4) {
    intent = "chitchat";
  }

  const order_ref = (orderMatch?.[1] || orderMatch?.[0] || prior?.order_ref || null)?.replace(/\s+/g, "").toUpperCase() ?? null;
  const invoice_ref = invoiceMatch?.[1] || prior?.invoice_ref || null;
  let claimed_quantity = prior?.claimed_quantity ?? null;
  if (qtyMatch) {
    const n = parseNumberToken(qtyMatch[1]);
    if (n != null) claimed_quantity = n;
  }
  const receivedOnly =
    scrubbed.match(/received only\s+(\d[\d.,]*)/i) || scrubbed.match(/ricevut[oi]\s+solo\s+(\d[\d.,]*)/i);
  if (receivedOnly) {
    const n = parseNumberToken(receivedOnly[1]);
    if (n != null) claimed_quantity = n;
  }
  let claimed_amount = prior?.claimed_amount ?? null;
  if (amountMatch) {
    const n = parseNumberToken(amountMatch[1]);
    if (n != null) claimed_amount = n;
  }

  const missing: string[] = [];
  if (intent === "report") {
    if (!order_ref) missing.push("order_ref");
    if (category === ClaimType.SHORTAGE && claimed_quantity == null) missing.push("claimed_quantity");
    if (category === ClaimType.PRICING && claimed_amount == null && claimed_quantity == null) missing.push("claimed_amount");
  }

  return {
    order_ref,
    invoice_ref,
    shipment_ref: prior?.shipment_ref ?? null,
    category,
    claimed_quantity,
    claimed_amount,
    product: prior?.product ?? (/carnaroli/i.test(text) ? "Carnaroli" : null),
    customer_description: (prior?.customer_description ? `${prior.customer_description} ${text}` : text).trim().slice(0, 800),
    missing_fields: missing,
    intent,
    language: italian ? "it" : "en",
  };
}

async function extractIntake(
  text: string,
  history: { role: string; content: string }[],
  prior: PortalIntake | null,
  caller?: Caller | null,
): Promise<{ intake: PortalIntake; mode: "live" | "offline_deterministic" }> {
  if (caller || !hasKey()) {
    return { intake: deterministicIntake(text, prior), mode: "offline_deterministic" };
  }
  try {
    const messages: Message[] = [
      { role: "system", content: `You are the intake classifier for Riso Scotti's retailer support chat.\n${INTAKE_HINT}` },
      ...history.slice(-6).map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user", content: text },
    ];
    const raw = await chatJson(messages, {
      task: "dispute.portal_intake",
      validate: (p) => {
        const problems: string[] = [];
        if (!p || typeof p !== "object") problems.push("not an object");
        return problems;
      },
    });
    const merged = deterministicIntake(text, prior);
    const category = CLAIM_TYPES_SAFE(raw.category) ?? merged.category;
    const missing = Array.isArray(raw.missing_fields)
      ? (raw.missing_fields as unknown[]).map(String)
      : merged.missing_fields;
    return {
      mode: "live",
      intake: {
        order_ref: typeof raw.order_ref === "string" ? raw.order_ref : merged.order_ref,
        invoice_ref: typeof raw.invoice_ref === "string" ? raw.invoice_ref : merged.invoice_ref,
        shipment_ref: typeof raw.shipment_ref === "string" ? raw.shipment_ref : merged.shipment_ref,
        category,
        claimed_quantity: typeof raw.claimed_quantity === "number" ? raw.claimed_quantity : merged.claimed_quantity,
        claimed_amount: typeof raw.claimed_amount === "number" ? raw.claimed_amount : merged.claimed_amount,
        product: typeof raw.product === "string" ? raw.product : merged.product,
        customer_description:
          typeof raw.customer_description === "string" ? raw.customer_description : merged.customer_description,
        missing_fields: missing,
        intent: (["report", "status", "unauthorized_action", "chitchat"] as const).includes(raw.intent as never)
          ? (raw.intent as PortalIntake["intent"])
          : merged.intent,
        language: raw.language === "it" ? "it" : merged.language,
      },
    };
  } catch {
    return { intake: deterministicIntake(text, prior), mode: "offline_deterministic" };
  }
}

function CLAIM_TYPES_SAFE(v: unknown): ClaimType | null {
  if (typeof v !== "string") return null;
  return (Object.values(ClaimType) as string[]).includes(v) ? (v as ClaimType) : null;
}

function authorizeOrder(erp: Erp, session: SimulatedRetailerSession, orderRef: string): { ok: true } | { ok: false; reason: string } {
  const order = erp.order(orderRef);
  if (!order) return { ok: false, reason: "order_not_found" };
  if (order.buyerGln !== session.retailer_id) return { ok: false, reason: "unauthorized" };
  return { ok: true };
}

function portalMeta(claim: NonNullable<ReturnType<Erp["claim"]>>): Record<string, unknown> {
  const ext = (claim.extraction ?? {}) as Record<string, unknown>;
  return (ext.portal as Record<string, unknown>) ?? {};
}

export function claimToPortalRecord(erp: Erp, claimId: string): PortalClaimRecord | null {
  const claim = erp.claim(claimId);
  if (!claim) return null;
  const portal = portalMeta(claim);
  const status = (portal.status as PortalStatus) || mapLegacyStatus(claim.status);
  return {
    dispute_id: claim.claimId,
    retailer_id: String(portal.retailer_id ?? ""),
    order_id: claim.orderRef,
    shipment_id: (portal.shipment_id as string) ?? null,
    invoice_id: claim.invoiceRef,
    category: String((claim.extraction as ClaimExtraction | null)?.claim_type ?? portal.category ?? "other"),
    customer_description: String(portal.customer_description ?? ""),
    claimed_quantity: (portal.claimed_quantity as number | null) ?? null,
    claimed_amount: (portal.claimed_amount as number | null) ?? null,
    customer_evidence_refs: Array.isArray(portal.customer_evidence_refs) ? (portal.customer_evidence_refs as string[]) : [],
    supporting_internal_records: (portal.supporting_internal_records as Record<string, unknown>) ?? {},
    conversation_id: String(portal.conversation_id ?? ""),
    status,
    assigned_role: String(portal.assigned_role ?? "credit desk"),
    created_at: claim.receivedAt,
    updated_at: String(portal.updated_at ?? claim.receivedAt),
    case_id: (portal.case_id as string) ?? null,
    verified_quantities: (portal.verified_quantities as Record<string, unknown>) ?? null,
    reconciliation: (portal.reconciliation as Record<string, unknown>) ?? null,
  };
}

function mapLegacyStatus(status: string): PortalStatus {
  if (status === "closed") return "CLOSED";
  if (status === "awaiting_sign_off" || status === "received") return "ACTION_REQUIRED";
  if (status === "reopened") return "INVESTIGATING";
  return "ACTION_REQUIRED";
}

function evidenceSnapshot(erp: Erp, orderRef: string, facts: DisputeFacts | null) {
  const order = erp.order(orderRef);
  const shipments = erp.shipments(orderRef);
  const invoices = erp.invoices(orderRef);
  const proofs = erp.proofs(orderRef);
  const ordered = order?.lines.reduce((a, l) => a + (l.qtyConfirmed ?? l.qtyOrdered ?? 0), 0) ?? null;
  const shipped = shipments.reduce((a, sh) => a + sh.lines.reduce((b, l) => b + l.qty, 0), 0);
  const invoiced = invoices.reduce((a, inv) => a + inv.lines.reduce((b, l) => b + l.qty, 0), 0);
  return {
    order_ref: orderRef,
    order_status: order?.status ?? null,
    ordered_qty: ordered,
    dispatched_qty: shipped,
    invoiced_qty: invoiced,
    ddt_refs: shipments.map((s) => s.ddtRef).filter(Boolean),
    invoice_refs: invoices.map((i) => i.invoiceRef),
    proof_kinds: proofs.map((p) => p.kind),
    // DESADV counts as GRN in threeway — that is NOT a retailer receipt confirmation.
    retailer_receipt_verified: proofs.some((p) => /recadv|retailer.?receipt|pod/i.test(p.kind)),
    threeway_summary: facts?.threeway?.summary ?? null,
    threeway_lines: facts?.threeway?.lines ?? null,
    misses: facts?.misses ?? [],
  };
}

function findOpenPortalClaim(erp: Erp, retailerId: string, orderRef: string, category: string): string | null {
  for (const c of erp.claims()) {
    const portal = portalMeta(c);
    if (portal.retailer_id !== retailerId) continue;
    if (c.orderRef !== orderRef) continue;
    if (String(portal.category ?? c.extraction?.claim_type) !== category) continue;
    const st = (portal.status as PortalStatus) || mapLegacyStatus(c.status);
    if (st === "CLOSED" || st === "RESOLVED") continue;
    return c.claimId;
  }
  return null;
}

function replyAskOrder(lang: "en" | "it"): string {
  return lang === "it"
    ? "Mi dispiace per il disguido. Posso aiutarla a segnalarlo. Mi conferma il riferimento dell'ordine o della consegna?"
    : "I'm sorry to hear there is a discrepancy with your delivery. I can help you report it. Could you confirm the order or delivery reference?";
}

function replyUnauthorized(lang: "en" | "it"): string {
  return lang === "it"
    ? "Non posso autorizzare rimborsi, note di credito o modifiche alla fattura da questa chat. Posso registrare la segnalazione così che il team di Riso Scotti la esamini con i documenti."
    : "I can't authorize refunds, credit notes or invoice changes from this chat. I can register your report so Riso Scotti's team can review it against the documents.";
}

function replySubmitted(lang: "en" | "it", disputeId: string, status: PortalStatus): string {
  return lang === "it"
    ? `Grazie. Ho registrato la sua segnalazione. Il riferimento è ${disputeId}. Stato attuale: ${status}. Il team interno è stato avvisato nella casella Actions. Può chiedere lo stato in qualsiasi momento qui.`
    : `Thank you. I've recorded your report. Your dispute reference is ${disputeId}. Current status: ${status}. Our internal team has been notified in the Actions inbox. You can ask for its status here anytime.`;
}

function grokAnalysis(intake: PortalIntake, evidence: ReturnType<typeof evidenceSnapshot>): Record<string, unknown> {
  const matches: string[] = [];
  const mismatches: string[] = [];
  if (evidence.dispatched_qty != null && evidence.invoiced_qty != null && evidence.dispatched_qty === evidence.invoiced_qty) {
    matches.push(`Dispatch and invoice both show ${evidence.dispatched_qty} units.`);
  }
  if (intake.claimed_quantity != null && evidence.dispatched_qty != null && intake.claimed_quantity !== evidence.dispatched_qty) {
    mismatches.push(
      `Customer claims ${intake.claimed_quantity} received; our dispatch/invoice records show ${evidence.dispatched_qty}. The claimed quantity is not verified receipt evidence.`,
    );
  }
  if (!evidence.retailer_receipt_verified) {
    mismatches.push("No authoritative retailer receipt (RECADV) confirming the claimed received quantity.");
  }
  return {
    supported_facts: matches,
    missing_evidence: mismatches,
    possible_causes: [
      intake.category === "shortage" ? "Possible short delivery, receiving variance, or documentation lag." : "Needs document review.",
    ],
    proposed_resolution:
      "Investigate receipt and delivery evidence before any credit note. Do not treat the customer claim as verified.",
    recommended_action: "Review DDT, DESADV, invoice and any RECADV; ask the warehouse and retailer for receiving notes.",
  };
}

/**
 * One customer chat turn. Persists messages; creates or updates a claim only after minimum fields
 * and authorization succeed. Never emits TD04 / refunds.
 */
export async function handleCustomerMessage(
  erp: Erp,
  session: SimulatedRetailerSession,
  opts: {
    message: string;
    conversationId?: string | null;
    idempotencyKey?: string | null;
    caller?: Caller | null;
  },
): Promise<PortalTurnResult> {
  const text = opts.message.trim();
  if (!text) {
    return {
      reply: "Please describe the problem with your order.",
      conversation_id: opts.conversationId ?? "",
      dispute_id: null,
      status: null,
      case_id: null,
      needs_follow_up: true,
      missing_fields: ["description"],
      grok_mode: "offline_deterministic",
      submitted: false,
      error: "empty_message",
    };
  }

  const at = nowIso();
  let conversationId = opts.conversationId ?? "";
  let state = conversationId ? loadConversation(erp, conversationId) : null;
  if (state && state.retailer_gln !== session.retailer_id) {
    return {
      reply: "This conversation belongs to another retailer session.",
      conversation_id: conversationId,
      dispute_id: null,
      status: null,
      case_id: null,
      needs_follow_up: false,
      missing_fields: [],
      grok_mode: "offline_deterministic",
      submitted: false,
      error: "unauthorized_conversation",
    };
  }
  if (!state) {
    conversationId = erp.nextId("chat_conv", "CNV-");
    state = {
      conversation_id: conversationId,
      retailer_gln: session.retailer_id,
      claim_id: null,
      idempotency_key: opts.idempotencyKey ?? null,
      messages: [],
      created_at: at,
      updated_at: at,
    };
    saveConversation(erp, state);
  }

  const replyAndReturn = (
    reply: string,
    extra: Partial<PortalTurnResult> & { grok_mode: PortalTurnResult["grok_mode"] },
  ): PortalTurnResult => {
    state = appendMessage(erp, state!, { role: "assistant", content: reply, at: nowIso() });
    const rec = state.claim_id ? claimToPortalRecord(erp, state.claim_id) : null;
    return {
      reply,
      conversation_id: conversationId,
      dispute_id: rec?.dispute_id ?? extra.dispute_id ?? null,
      status: rec?.status ?? extra.status ?? null,
      case_id: rec?.case_id ?? extra.case_id ?? null,
      needs_follow_up: extra.needs_follow_up ?? false,
      missing_fields: extra.missing_fields ?? [],
      grok_mode: extra.grok_mode,
      submitted: extra.submitted ?? false,
      error: extra.error,
    };
  };

  // Idempotent retry of the same customer message key.
  if (opts.idempotencyKey) {
    const existing = state.messages.find(
      (m) => m.role === "customer" && m.meta?.idempotency_key === opts.idempotencyKey,
    );
    if (existing) {
      const lastAssistant = [...state.messages].reverse().find((m) => m.role === "assistant");
      const rec = state.claim_id ? claimToPortalRecord(erp, state.claim_id) : null;
      return {
        reply: lastAssistant?.content ?? "Your previous message was already recorded.",
        conversation_id: conversationId,
        dispute_id: rec?.dispute_id ?? null,
        status: rec?.status ?? null,
        case_id: rec?.case_id ?? null,
        needs_follow_up: false,
        missing_fields: [],
        grok_mode: "offline_deterministic",
        submitted: Boolean(rec),
      };
    }
  }

  state = appendMessage(erp, state, {
    role: "customer",
    content: text,
    at,
    meta: { idempotency_key: opts.idempotencyKey ?? null },
  });

  const history = state.messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
  const priorClaim = state.claim_id ? claimToPortalRecord(erp, state.claim_id) : null;
  const customerBlob = state.messages
    .filter((m) => m.role === "customer")
    .map((m) => m.content)
    .join("\n");
  // Fold earlier customer turns into the prior intake so "ORD-3001" after a shortage report still keeps qty.
  const foldedPrior = deterministicIntake(customerBlob, priorClaim
    ? {
        order_ref: priorClaim.order_id,
        invoice_ref: priorClaim.invoice_id,
        shipment_ref: priorClaim.shipment_id,
        category: (priorClaim.category as ClaimType) || ClaimType.OTHER,
        claimed_quantity: priorClaim.claimed_quantity,
        claimed_amount: priorClaim.claimed_amount,
        product: null,
        customer_description: priorClaim.customer_description,
        missing_fields: [],
        intent: "report",
        language: looksItalian(customerBlob) ? "it" : "en",
      }
    : null);

  const { intake, mode } = await extractIntake(text, history, foldedPrior, opts.caller);

  if (intake.intent === "unauthorized_action") {
    return replyAndReturn(replyUnauthorized(intake.language), {
      needs_follow_up: true,
      missing_fields: intake.missing_fields,
      grok_mode: mode,
      submitted: false,
    });
  }

  if (intake.intent === "status") {
    const refMatch = text.match(/\b(DSP-\d+|CLM-\d+)\b/i);
    const disputeId = refMatch?.[1]?.toUpperCase() || priorClaim?.dispute_id || state.claim_id || undefined;
    const rec = disputeId ? claimToPortalRecord(erp, disputeId) : null;
    if (!rec || rec.retailer_id !== session.retailer_id) {
      return replyAndReturn(
        intake.language === "it"
          ? "Non trovo una segnalazione sua con quel riferimento. Indichi il codice DSP-… oppure descriva di nuovo il problema."
          : "I can't find one of your disputes with that reference. Share the DSP-… code or describe the problem again.",
        { needs_follow_up: true, missing_fields: ["dispute_id"], grok_mode: mode, submitted: false },
      );
    }
    return replyAndReturn(
      intake.language === "it"
        ? `Lo stato di ${rec.dispute_id} è ${rec.status}. Ruolo assegnato: ${rec.assigned_role}.`
        : `The status of ${rec.dispute_id} is ${rec.status}. Assigned role: ${rec.assigned_role}.`,
      {
        dispute_id: rec.dispute_id,
        status: rec.status,
        case_id: rec.case_id,
        grok_mode: mode,
        submitted: true,
      },
    );
  }

  if (intake.intent === "chitchat") {
    return replyAndReturn(
      intake.language === "it" ? "Buongiorno. Come possiamo aiutarla con il suo ordine?" : "Hello. How can we help with your order?",
      { needs_follow_up: true, missing_fields: ["order_ref"], grok_mode: mode, submitted: false },
    );
  }

  if (intake.missing_fields.includes("order_ref") || !intake.order_ref) {
    return replyAndReturn(replyAskOrder(intake.language), {
      needs_follow_up: true,
      missing_fields: ["order_ref"],
      grok_mode: mode,
      submitted: false,
    });
  }

  const auth = authorizeOrder(erp, session, intake.order_ref);
  if (!auth.ok) {
    const reply =
      auth.reason === "unauthorized"
        ? intake.language === "it"
          ? "Questo ordine non risulta collegato al suo account retailer. Non posso aprirlo."
          : "That order is not linked to your retailer account. I can't open it."
        : intake.language === "it"
          ? "Non trovo quell'ordine nei nostri archivi. Verifichi il riferimento."
          : "I can't find that order in our records. Please check the reference.";
    return replyAndReturn(reply, {
      needs_follow_up: true,
      missing_fields: auth.reason === "order_not_found" ? ["order_ref"] : [],
      grok_mode: mode,
      submitted: false,
      error: auth.reason,
    });
  }

  if (intake.missing_fields.length) {
    const field = intake.missing_fields[0];
    return replyAndReturn(
      intake.language === "it"
        ? `Per registrare la segnalazione mi serve ancora: ${field}.`
        : `To register the report I still need: ${field}.`,
      { needs_follow_up: true, missing_fields: intake.missing_fields, grok_mode: mode, submitted: false },
    );
  }

  // Persist the dispute (create or update). Failures must not claim success.
  try {
    const result = erp.tx(() => {
      const extraction: ClaimExtraction = parseExtraction({
        order_ref: intake.order_ref,
        invoice_ref: intake.invoice_ref,
        product: intake.product,
        quantity: intake.claimed_quantity,
        amount: intake.claimed_amount,
        claim_type: intake.category,
        confidence: 0.7,
        raw_notes: "customer chat intake — claimed values, not verified",
      });
      const facts = pullFacts(extraction, { store: disputeStore(erp, false) });
      const evidence = evidenceSnapshot(erp, intake.order_ref!, facts);
      const analysis = grokAnalysis(intake, evidence);
      const assigned = ROLE_BY_CATEGORY[intake.category] ?? "credit desk";
      const idem = opts.idempotencyKey || hashKey([session.retailer_id, intake.order_ref!, intake.category, String(intake.claimed_quantity), String(intake.claimed_amount)]);

      let disputeId = findOpenPortalClaim(erp, session.retailer_id, intake.order_ref!, intake.category) || state!.claim_id || null;
      let caseId: string | null = null;
      const updatedAt = nowIso();

      if (disputeId && erp.claim(disputeId)) {
        const existing = erp.claim(disputeId)!;
        const prevPortal = portalMeta(existing);
        caseId = (prevPortal.case_id as string) ?? null;
        const portal = {
          ...prevPortal,
          status: "ACTION_REQUIRED" as PortalStatus,
          retailer_id: session.retailer_id,
          shipment_id: evidence.ddt_refs[0] ?? null,
          category: intake.category,
          customer_description: intake.customer_description,
          claimed_quantity: intake.claimed_quantity,
          claimed_amount: intake.claimed_amount,
          customer_evidence_refs: [],
          supporting_internal_records: evidence,
          conversation_id: conversationId,
          assigned_role: assigned,
          updated_at: updatedAt,
          case_id: caseId,
          verified_quantities: {
            ordered: evidence.ordered_qty,
            dispatched: evidence.dispatched_qty,
            invoiced: evidence.invoiced_qty,
            claimed_received: intake.claimed_quantity,
            claimed_is_verified: false,
          },
          reconciliation: {
            note: "Customer claim is separate from verified documents.",
            threeway_summary: evidence.threeway_summary,
            invoice_matches_dispatch:
              evidence.dispatched_qty != null && evidence.invoiced_qty != null && evidence.dispatched_qty === evidence.invoiced_qty,
          },
          analysis,
          channel: "customer_chat",
        };
        erp.setClaim(disputeId, {
          orderRef: intake.order_ref,
          invoiceRef: intake.invoice_ref ?? evidence.invoice_refs[0] ?? null,
          status: "action_required",
          extraction: { ...extraction, portal } as unknown as Record<string, unknown>,
        });
        if (caseId && erp.signoff(caseId)?.status === "pending") {
          const so = erp.signoff(caseId)!;
          erp.updateSignoff(caseId, {
            title: `Customer dispute ${disputeId} on ${intake.order_ref}: ${intake.category}`,
            proposal: { ...(so.proposal ?? {}), portal: true, intake, evidence, analysis, claim_id: disputeId },
            reasons: [
              "Customer-reported claim via chat — not verified evidence",
              `Claimed qty ${intake.claimed_quantity ?? "—"} vs dispatched ${evidence.dispatched_qty ?? "—"}`,
            ],
          });
        }
        erp.log("retailer", "dispute.customer_updated", disputeId, { detail: { conversation_id: conversationId } });
      } else {
        const docId = erp.addDocument("customer claim", intake.order_ref, intake.customer_description, {
          path: `customer/${conversationId}`,
        });
        disputeId = erp.nextId("dispute", "DSP-");
        const portal = {
          status: "CUSTOMER_REPORTED" as PortalStatus,
          retailer_id: session.retailer_id,
          shipment_id: evidence.ddt_refs[0] ?? null,
          category: intake.category,
          customer_description: intake.customer_description,
          claimed_quantity: intake.claimed_quantity,
          claimed_amount: intake.claimed_amount,
          customer_evidence_refs: [] as string[],
          supporting_internal_records: evidence,
          conversation_id: conversationId,
          assigned_role: assigned,
          updated_at: updatedAt,
          case_id: null as string | null,
          verified_quantities: {
            ordered: evidence.ordered_qty,
            dispatched: evidence.dispatched_qty,
            invoiced: evidence.invoiced_qty,
            claimed_received: intake.claimed_quantity,
            claimed_is_verified: false,
          },
          reconciliation: {
            note: "Customer claim is separate from verified documents.",
            threeway_summary: evidence.threeway_summary,
            invoice_matches_dispatch:
              evidence.dispatched_qty != null && evidence.invoiced_qty != null && evidence.dispatched_qty === evidence.invoiced_qty,
          },
          analysis,
          channel: "customer_chat",
          idempotency_key: idem,
        };
        erp.saveClaim({ claimId: disputeId, sourceDoc: docId, status: "customer_reported" });
        erp.setClaim(disputeId, {
          orderRef: intake.order_ref,
          invoiceRef: intake.invoice_ref ?? evidence.invoice_refs[0] ?? null,
          extraction: { ...extraction, portal } as unknown as Record<string, unknown>,
        });
        caseId = requestSignoff(erp, {
          row: "dispute",
          kind: "customer_dispute",
          subjectRef: disputeId,
          title: `Customer dispute ${disputeId} on ${intake.order_ref}: ${intake.category}`,
          proposal: {
            portal: true,
            intake,
            evidence,
            analysis,
            claim_id: disputeId,
            summary: intake.customer_description,
            recommended_action: analysis.recommended_action,
            assigned_role: assigned,
          },
          reasons: [
            "Customer-reported claim via chat — not verified evidence",
            `Claimed qty ${intake.claimed_quantity ?? "—"} vs dispatched ${evidence.dispatched_qty ?? "—"}`,
          ],
        });
        portal.status = "ACTION_REQUIRED";
        portal.case_id = caseId;
        erp.setClaim(disputeId, {
          status: "action_required",
          extraction: { ...extraction, portal } as unknown as Record<string, unknown>,
        });
        erp.saveNotification({
          notificationId: erp.nextId("notif", "NTF-"),
          kind: "customer_dispute",
          subjectRef: disputeId,
          title: `${session.retailer_name}: ${intake.category} on ${intake.order_ref}`,
          body: intake.customer_description,
          assignedRole: assigned,
          createdAt: updatedAt,
        });
        erp.log("retailer", "dispute.customer_created", disputeId, {
          sourceDoc: docId,
          detail: { conversation_id: conversationId, case_id: caseId },
        });
      }

      // Persist claim link on the conversation document (outside nested claim writes is fine).
      const linked: ConversationState = {
        ...state!,
        claim_id: disputeId!,
        idempotency_key: idem,
        updated_at: updatedAt,
      };
      saveConversation(erp, linked);
      return { disputeId: disputeId!, caseId, status: "ACTION_REQUIRED" as PortalStatus, linked };
    });

    state = result.linked;
    return replyAndReturn(replySubmitted(intake.language, result.disputeId, result.status), {
      dispute_id: result.disputeId,
      status: result.status,
      case_id: result.caseId,
      grok_mode: mode,
      submitted: true,
    });
  } catch (err) {
    return replyAndReturn(
      intake.language === "it"
        ? "Non sono riuscito a registrare la segnalazione per un errore interno. Riprovi tra poco; non le è stato assegnato alcun riferimento."
        : "I couldn't submit your report because of an internal error. Please try again shortly; no dispute reference was assigned.",
      {
        needs_follow_up: true,
        grok_mode: mode,
        submitted: false,
        error: (err as Error).message,
      },
    );
  }
}

/** List this retailer's portal disputes only. */
export function listCustomerDisputes(erp: Erp, session: SimulatedRetailerSession): PortalClaimRecord[] {
  return erp
    .claims()
    .map((c) => claimToPortalRecord(erp, c.claimId))
    .filter((r): r is PortalClaimRecord => Boolean(r && r.retailer_id === session.retailer_id && r.conversation_id));
}

/** Employee inbox rows for customer-portal disputes. */
export function listEmployeePortalDisputes(erp: Erp) {
  return erp
    .signoffs({ row: "dispute" })
    .filter((s) => s.kind === "customer_dispute")
    .map((s) => {
      const rec = s.subjectRef ? claimToPortalRecord(erp, s.subjectRef) : null;
      const retailer = rec ? erp.retailer(rec.retailer_id) : null;
      const impact =
        rec?.claimed_amount ??
        (rec?.claimed_quantity != null && rec.order_id
          ? (() => {
              const order = erp.order(rec.order_id!);
              const price = order?.lines[0]?.unitPrice ?? null;
              return price != null && rec.claimed_quantity != null && order
                ? Math.abs((order.lines[0]?.qtyConfirmed ?? order.lines[0]?.qtyOrdered ?? 0) - rec.claimed_quantity) * price
                : null;
            })()
          : null);
      return {
        case_id: s.caseId,
        dispute_id: rec?.dispute_id ?? s.subjectRef,
        retailer: retailer?.name ?? rec?.retailer_id ?? "—",
        order_id: rec?.order_id ?? null,
        summary: rec?.customer_description ?? s.title,
        category: rec?.category ?? "other",
        claimed_impact: impact,
        status: rec?.status ?? s.status,
        assigned_role: rec?.assigned_role ?? "credit desk",
        received_at: s.createdAt,
        signoff_status: s.status,
      };
    });
}

export function employeeDisputeWorkspace(erp: Erp, caseId: string) {
  const so = erp.signoff(caseId);
  if (!so || so.row !== "dispute") throw new Error(`${caseId} is not a dispute case`);
  const claimId = so.subjectRef!;
  const rec = claimToPortalRecord(erp, claimId);
  const proposal = (so.proposal ?? {}) as Record<string, unknown>;
  const conv = rec?.conversation_id ? loadConversation(erp, rec.conversation_id) : null;
  return {
    case: so,
    dispute: rec,
    customer_reported: {
      message: rec?.customer_description ?? null,
      claimed_quantity: rec?.claimed_quantity ?? null,
      claimed_amount: rec?.claimed_amount ?? null,
      category: rec?.category ?? null,
    },
    our_records: rec?.supporting_internal_records ?? proposal.evidence ?? null,
    matches: (proposal.analysis as { supported_facts?: string[] } | undefined)?.supported_facts ?? [],
    mismatches: (proposal.analysis as { missing_evidence?: string[] } | undefined)?.missing_evidence ?? [],
    grok_analysis: proposal.analysis ?? rec?.reconciliation ?? null,
    next_action: {
      assigned_role: rec?.assigned_role ?? "credit desk",
      recommended: (proposal.analysis as { recommended_action?: string } | undefined)?.recommended_action ?? proposal.recommended_action,
      requires_approval: true,
    },
    conversation: (conv?.messages ?? []).map((m) => ({ role: m.role, content: m.content, at: m.at })),
  };
}

/** Employee decision on a customer_dispute case — never auto-issues money. */
export function decideCustomerDispute(
  erp: Erp,
  caseId: string,
  d: { approve: boolean; by: string; reason: string; edits?: Record<string, unknown> | null },
): Record<string, unknown> {
  const so = erp.signoff(caseId);
  if (!so || so.kind !== "customer_dispute") throw new Error(`${caseId} is not a customer_dispute case`);
  const claimId = so.subjectRef!;
  const claim = erp.claim(claimId);
  if (!claim) throw new Error(`missing claim ${claimId}`);
  decide(erp, caseId, d);
  const portal = { ...portalMeta(claim) };
  const resolution = String(d.edits?.resolution ?? (d.approve ? "investigate" : "close"));
  let status: PortalStatus;
  if (!d.approve || resolution === "close" || resolution === "close_no_liability") status = "CLOSED";
  else if (resolution === "await_customer") status = "AWAITING_CUSTOMER_EVIDENCE";
  else if (resolution === "resolve") status = "RESOLVED";
  else status = "INVESTIGATING";
  portal.status = status;
  portal.updated_at = nowIso();
  portal.decision = { by: d.by, reason: d.reason, resolution };
  erp.setClaim(claimId, {
    status: status.toLowerCase(),
    extraction: { ...(claim.extraction ?? {}), portal } as Record<string, unknown>,
  });
  erp.log(`person:${d.by}`, "dispute.portal_decided", claimId, { detail: { status, reason: d.reason } });
  return { status, claim_id: claimId, case_id: caseId };
}
