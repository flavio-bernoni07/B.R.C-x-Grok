/**
 * The order workspace: one order read like an email thread. Built on `core/trace.ts` (the chain
 * of documents behind the order), the Shipping file and the stock ledger. Read-only: nothing here
 * decides, sends or changes a record. Every figure comes from a Mini ERP row or the audit log.
 */
import { caseProblem, caseRole } from "../core/case-view";
import type { Erp } from "../core/erp";
import { availableToPromise, batches, isoDate, OPEN_ORDER_STATUSES } from "../core/stock";
import { chain, type TraceChain } from "../core/trace";
import { orderStory, type StoryStep } from "./story";
import { openCases, shippingFile } from "../shipping/service";
import { orderDetail } from "./views";
import { type Caught, caughtProblems } from "./caught";
import { type ContractSummary, contractFor } from "../core/contracts";
import { orderDocuments } from "../core/document-file";

export type InboxStatus = "attention" | "on_track" | "waiting" | "completed";
export const STATUS_LABEL: Record<InboxStatus, string> = {
  attention: "Needs attention",
  on_track: "On track",
  waiting: "Waiting for retailer",
  completed: "Completed",
};

export type JourneyStep = {
  key: string;
  label: string;
  done: boolean;
  /** Who did it: Code, Grok, the retailer or a named person. */
  who: string | null;
  when: string | null;
  document: string | null;
  detail: string | null;
};

export type WorkspaceException = { caseId: string; text: string; href: string };

/** Who has the order now: an agent working it, a person who must decide, the retailer, or nobody. */
export type Owner = { kind: "agent" | "person" | "team" | "retailer" | "none"; name: string; doing: string };

/** An order delivered in two parts because stock was short: what ships now and what follows. */
export type Split = { now: number; later: number; laterDate: string | null; product: string | null; by: "grok" | "code"; message: string | null; why: string | null };

export type OrderWorkspace = {
  orderRef: string;
  retailer: string;
  deliveryDate: string | null;
  orderDate: string | null;
  status: InboxStatus;
  statusLabel: string;
  statusText: string;
  nextStep: string;
  counter: { agents: number; people: number; text: string };
  journey: JourneyStep[];
  /** Every step in plain words, from the audit log (order/story.ts). */
  story: StoryStep[];
  summary: {
    ordered: number;
    confirmed: number;
    reserved: number;
    shipped: number;
    remaining: number;
    received: number | null;
    invoiced: number;
    paid: number;
    moneyAtStake: number;
    moneyAtStakeNote: string;
    nextEvent: string;
  };
  details: {
    lines: { lineNo: number; product: string | null; gtin: string | null; ordered: number | null; confirmed: number | null; unitPrice: number | null; contractPrice: number | null }[];
    grokChanges: { what: string; before: string; after: string; why: string }[];
    contractId: string | null;
    ordersDoc: string | null;
    ordrspDoc: string | null;
  };
  inventory: {
    lines: { gtin: string; product: string | null; atp: number; released: number; held: number; committed: number }[];
    batches: { batch: string; gtin: string; qty: number; status: string }[];
    events: TraceChain["production"];
  };
  shipping: {
    truck: { id: string; plate: string | null; destination: string | null } | null;
    manifest: { id: string; status: string; orders: string[]; pallets: number } | null;
    pallets: number;
    scans: { ok: number; other: number; notes: string[] };
    loaded: boolean;
    shipments: { desadv: string; ddt: string | null; shipDate: string | null; qty: number; batches: string[]; notes: string | null; documents: { docId: string; kind: string }[] }[];
  } | null;
  finance: {
    invoices: { invoice: string; status: string; statusText: string; total: number; documents: { docId: string; kind: string }[] }[];
    payments: TraceChain["payments"];
    deductions: TraceChain["deductions"];
    paymentNote: string;
  };
  claims: TraceChain["claims"];
  exceptions: WorkspaceException[];
  history: { at: string; who: string; action: string; document: string | null }[];
  agents: string[];
  owner: Owner;
  split: Split | null;
  /** Net value: confirmed (else ordered) units × unit price on the order lines. */
  value: number;
  /** Core journey steps done, of the total (claims not counted). */
  progress: { done: number; total: number; current: string | null };
  askQuestion: string;
  /** What code and Grok caught on this order (README case study): problem, money at stake, status. */
  caught: Caught[];
  /** The retailer's annual contract (billed monthly), when there is one. */
  contract: ContractSummary | null;
  /** Every document tied to the order, each downloadable at its href. */
  documents: { docId: string; kind: string; ref: string | null; filename: string; href: string }[];
};

const ATTENTION_STATUSES = new Set(["awaiting_confirmation", "pending_price", "price_fix", "pending_manual_edi", "manual_edi", "stock_short"]);

export function whoOf(actor: string, retailer: string): string {
  if (actor === "code") return "Code";
  if (actor === "grok") return "Grok";
  if (actor === "retailer") return retailer;
  if (actor.startsWith("person:")) return actor.slice(7);
  return actor;
}

/** Which agents worked on the order, from the audit actions. */
export function agentsOf(actions: string[]): string[] {
  const out = new Set<string>();
  for (const a of actions) {
    if (a.startsWith("order.")) out.add("Order");
    else if (/^shipping\.(invoic|reconcil|held)/.test(a)) out.add("Documents");
    else if (a.startsWith("shipping.")) out.add("Shipping");
    else if (a.startsWith("dispute.")) out.add("Dispute");
  }
  return ["Order", "Shipping", "Documents", "Dispute"].filter((x) => out.has(x));
}

const n = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
const money = (v: number) => `€${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ACTION_TEXT: Record<string, string> = {
  "signoff.requested": "Asked a person to confirm",
  "signoff.approved": "Approved",
  "signoff.rejected": "Rejected",
  "order.checks_passed": "Checked the order: EDI, stock and contract price",
  "order.parse_fix": "Corrected the EDI so the parser could read it",
  "order.qty_short": "Stock was short, proposed a split",
  "order.ordrsp_sent": "Sent the order response (ORDRSP)",
  "shipping.ingested": "Took the confirmed order into shipping and reserved the stock",
  "shipping.planned": "Planned the truck",
  "shipping.picking_list": "Made the picking list",
  "shipping.case_opened": "Opened a case for a person",
  "shipping.case_executed": "Carried out the approved resolution",
  "shipping.loaded": "Confirmed the loading",
  "shipping.dispatched": "Dispatched the truck, wrote DESADV and DDT",
  "shipping.invoiced": "Wrote the invoice (FatturaPA XML and INVOIC)",
  "shipping.invoice_sent": "Released the invoice (simulated send)",
  "shipping.invoice_held": "Held the invoice",
  "shipping.reconciled": "Reconciled order, delivery and invoice",
  "shipping.held": "Held the invoice for a check",
  "shipping.delivered": "Signed the delivery note",
  "dispute.claim_received": "Sent a claim",
  "dispute.claim_read": "Read the claim",
  "dispute.facts_pulled": "Pulled the documents for the claim",
  "dispute.verdict": "Proposed a verdict with a source per point",
  "dispute.td04_xml": "Wrote the credit note (FatturaPA TD04)",
  "dispute.edi_invoic_381": "Wrote the credit note EDI (INVOIC 381)",
  "dispute.outcome_json": "Recorded the claim outcome",
};

export function actionText(action: string): string {
  if (ACTION_TEXT[action]) return ACTION_TEXT[action];
  if (action.startsWith("shipping.exception.")) return `Flagged a problem: ${action.slice(19).toLowerCase().replace(/_/g, " ")}`;
  return action.replace(/[._]/g, " ");
}

/** Build the workspace for one order, or null when the Mini ERP has no such order. */
export function orderWorkspace(erp: Erp, ref: string): OrderWorkspace | null {
  const order = erp.order(ref);
  if (!order) return null;
  const c = chain(erp, ref);
  const detail = orderDetail(erp, ref);
  const retailer = erp.retailer(order.buyerGln)?.name ?? order.buyerGln ?? "Unknown retailer";
  const who = (actor: string) => whoOf(actor, retailer);
  const audit = c.audit;
  const firstOf = (action: string | ((a: string) => boolean)) =>
    audit.find((a) => (typeof action === "string" ? a.action === action : action(a.action)));
  const allAudit = erp.auditLog(ref);

  // quantities
  const ordered = order.lines.reduce((a, l) => a + (l.qtyOrdered ?? 0), 0);
  const isConfirmed = order.lines.some((l) => l.qtyConfirmed != null);
  const confirmed = isConfirmed ? order.lines.reduce((a, l) => a + (l.qtyConfirmed ?? 0), 0) : 0;
  const shipped = c.shipments.reduce((a, s) => a + s.qty, 0);
  const remaining = Math.max(confirmed - shipped, 0);
  const reserved = OPEN_ORDER_STATUSES.includes(order.status) ? remaining : 0;
  const delivered = allAudit.filter((a) => a.action === "shipping.delivered");
  const received = delivered.length
    ? delivered.reduce((a, d) => a + Object.values(((d.detail as { received?: Record<string, number> } | null)?.received ?? {})).reduce((x, y) => x + y, 0), 0)
    : null;
  const invoiced = c.invoices.reduce((a, i) => a + (i.total ?? 0), 0);
  const paid = c.payments.reduce((a, p) => a + p.amount_paid, 0);
  const openClaims = c.claims.filter((cl) => cl.status !== "closed");
  const claimAtStake = openClaims.reduce((a, cl) => a + (cl.amount ?? 0), 0);
  const moneyAtStake = Math.max(invoiced - paid, 0) + claimAtStake;

  // journey
  const step = (key: string, label: string, done: boolean, a: { actor: string; at: string; source_doc: string | null } | undefined, extra: Partial<JourneyStep> = {}): JourneyStep => ({
    key,
    label,
    done,
    who: done && a ? who(a.actor) : null,
    when: done && a ? a.at : null,
    document: done ? (a?.source_doc ?? null) : null,
    detail: null,
    ...extra,
  });
  const ordersDocRow = order.sourceDoc ? erp.document(order.sourceDoc) : undefined;
  const approved = c.signoffs.filter((s) => s.status === "approved").at(-1);
  const ordrspAt = firstOf("order.ordrsp_sent");
  const dispatched = audit.filter((a) => a.action === "shipping.dispatched");
  const journey: JourneyStep[] = [
    {
      key: "received",
      label: "Received",
      done: !!order.sourceDoc,
      who: retailer,
      when: ordersDocRow?.createdAt ?? null,
      document: order.sourceDoc,
      detail: c.order.orders_file ? `ORDERS ${c.order.orders_file}` : null,
    },
    step("confirmed", "Confirmed", !!c.order.ordrsp_doc, ordrspAt, {
      who: approved?.decided_by ?? (ordrspAt ? who(ordrspAt.actor) : null),
      document: c.order.ordrsp_doc,
      detail: approved ? `${approved.decided_by}: ${approved.decision_reason ?? ""}`.trim() : null,
    }),
    step("reserved", "Reserved", !!firstOf("shipping.ingested"), firstOf("shipping.ingested"), {
      detail: isConfirmed ? `${n(confirmed)} units confirmed against stock` : null,
    }),
    step("planned", "Planned", !!firstOf("shipping.planned"), firstOf("shipping.planned")),
    step("picked", "Picked", !!firstOf("shipping.picking_list"), firstOf("shipping.picking_list")),
    step("loaded", "Loaded", !!firstOf("shipping.loaded"), firstOf("shipping.loaded")),
    step("dispatched", "Dispatched", c.shipments.length > 0, dispatched.at(-1), {
      detail: c.shipments.length
        ? `${c.shipments.length > 1 ? `${c.shipments.length} shipments, ` : ""}${n(shipped)} units${remaining ? `, ${n(remaining)} not shipped` : ""}`
        : null,
    }),
    step("invoiced", "Invoiced", c.invoices.length > 0, firstOf("shipping.invoiced"), {
      document: c.invoices.at(-1)?.fatturapa_doc ?? null,
      detail: c.invoices.length ? c.invoices.map((i) => `${i.invoice} ${money(i.total ?? 0)}`).join(", ") : null,
    }),
    step("received_by_retailer", "Received by retailer", c.proofs.length > 0, firstOf("shipping.delivered"), {
      document: c.proofs.at(-1)?.doc_id ?? null,
      detail: received != null ? `${n(received)} units received of ${n(shipped)} shipped` : null,
    }),
    {
      key: "paid",
      label: "Paid",
      done: c.payments.length > 0,
      who: c.payments.length ? retailer : null,
      when: c.payments.at(-1)?.value_date ?? null,
      document: c.payments.at(-1)?.source_doc ?? null,
      detail: c.payments.length ? `${money(paid)} paid of ${money(invoiced)}` : "No payment recorded",
    },
  ];
  if (c.claims.length) {
    const read = firstOf("dispute.verdict") ?? firstOf("dispute.claim_received");
    journey.push(
      step("claim", "Claim", true, read, {
        document: c.claims.at(-1)?.email_doc ?? null,
        detail: c.claims.map((cl) => `${cl.claim_id}: ${cl.decision ?? "no verdict yet"}${cl.amount != null ? ` ${money(cl.amount)}` : ""}, ${cl.status === "closed" ? "closed" : "open"}`).join("; "),
      }),
    );
  }

  // exceptions: open sign-offs and shipping cases (people decide in Actions)
  const exceptions: WorkspaceException[] = [];
  const claimIds = new Set(c.claims.map((cl) => cl.claim_id));
  for (const s of erp.signoffs({ status: "pending" }).filter((x) => !x.decidedAt)) {
    if (s.subjectRef === ref || (order.sourceDoc && s.subjectRef === order.sourceDoc) || claimIds.has(s.subjectRef ?? "")) {
      exceptions.push({ caseId: s.caseId, text: s.title || (s.reasons ?? []).join("; ") || "Waiting for a person", href: `/signoff?case=${encodeURIComponent(s.caseId)}` });
    }
  }
  let ship: ReturnType<typeof shippingFile> | null = null;
  try {
    ship = shippingFile(erp, ref);
    for (const x of openCases(erp, ref)) {
      exceptions.push({ caseId: x.case_id, text: x.explanation, href: `/signoff?case=${encodeURIComponent(x.case_id)}` });
    }
  } catch {
    ship = null;
  }

  // status in plain words
  const hasHold = c.shipments.some((s) => /quality hold/i.test(s.notes ?? ""));
  let status: InboxStatus;
  if (exceptions.length || ATTENTION_STATUSES.has(order.status) || openClaims.some((cl) => cl.status === "awaiting_person")) status = "attention";
  else if (order.status === "rejected" || order.status === "closed" || (invoiced > 0 && paid >= invoiced - 0.005 && !openClaims.length)) status = "completed";
  else if (order.status === "pending" || c.invoices.length || c.proofs.length) status = "waiting";
  else status = "on_track";

  const parts: string[] = [];
  if (shipped) {
    if (remaining) parts.push(`${n(remaining)} units ${hasHold ? "on quality hold" : "still to ship"}, shipped ${n(shipped)}`);
    else parts.push(`Shipped all ${n(shipped)} units`);
    if (received != null && received !== shipped) parts.push(`retailer received ${n(received)}`);
    else if (received != null) parts.push("retailer received everything");
    if (c.claims.length) parts.push(`${c.claims.length === 1 ? "claim" : `${c.claims.length} claims`} ${openClaims.length ? "open" : "settled"}`);
    if (c.invoices.length) parts.push(c.payments.length ? `paid ${money(paid)}` : "no payment recorded");
  } else {
    parts.push(detail?.check ?? "Checks running");
  }
  const statusText = parts.join(", ").replace(/^./, (x) => x.toUpperCase());

  const firstOpen = journey.find((s) => !s.done && s.key !== "claim");
  const nextStep = exceptions.length
    ? `A person reviews ${exceptions[0].caseId}: ${exceptions[0].text}`
    : status === "completed"
      ? "Nothing to do"
      : order.status === "pending"
        ? "Waiting for a new ORDERS from the retailer"
        : firstOpen?.key === "paid"
          ? "Wait for the retailer's payment"
          : firstOpen
            ? `Next: ${firstOpen.label.toLowerCase()}`
            : "Nothing to do";
  const nextEvent = firstOpen ? (firstOpen.key === "paid" ? "Payment from the retailer" : firstOpen.label) : "None";

  // counter from the audit log by actor, plus shipping case approvals (kept in the case history)
  const agents = audit.filter((a) => a.actor === "code" || a.actor === "grok").length;
  const caseApprovals = c.exception_cases.filter((x) => x.approved_by).length;
  const people = audit.filter((a) => a.actor.startsWith("person:")).length + caseApprovals;

  // Grok's changes, from the audit (order.parse_fix, order.qty_short by grok)
  const grokChanges: OrderWorkspace["details"]["grokChanges"] = [];
  for (const a of detail?.audit ?? []) {
    if (a.actor !== "grok") continue;
    if (a.action === "order.parse_fix") {
      for (const ch of (a.detail as { segment?: string; before?: string; after?: string }[] | null) ?? []) {
        grokChanges.push({ what: ch.segment ?? "EDI", before: ch.before ?? "", after: ch.after ?? "", why: "The parser could not read the EDI safely" });
      }
    } else if (a.action === "order.qty_short") {
      const d = (a.detail ?? {}) as { action?: string };
      grokChanges.push({ what: "Quantity", before: "As ordered", after: d.action ?? "split", why: "Not enough stock by the delivery date" });
    }
  }

  const gtins = [...new Set(order.lines.map((l) => l.gtin).filter((g): g is string => !!g))];

  // Who has it now. A waiting sign-off names the role that decides; else the step that is open.
  const waitingCase = erp
    .signoffs({ status: "pending" })
    .find(
      (s) =>
        s.subjectRef === ref ||
        (order.sourceDoc && s.subjectRef === order.sourceDoc) ||
        claimIds.has(s.subjectRef ?? "") ||
        exceptions.some((x) => x.caseId === s.subjectRef) ||
        (s.kind === "dispatch_plan" && ((s.proposal as { plan?: { orders?: string[] } } | null)?.plan?.orders ?? []).includes(ref)),
    );
  let owner: Owner;
  if (waitingCase) {
    const role = waitingCase.kind === "dispatch_plan" ? "Transport planner" : caseRole(waitingCase);
    // An exception case reads as its short card line ("Pallet 04 on the wrong truck"), not the sign-off title.
    const card = waitingCase.kind === "exception_case" ? caughtProblems(erp, ref).find((x) => x.caseId === waitingCase.subjectRef) : undefined;
    owner = { kind: "person", name: role, doing: waitingCase.kind === "dispatch_plan" ? "Approve the truck plan" : (card?.problem ?? caseProblem(waitingCase)) };
  } else if (exceptions.length) owner = { kind: "person", name: "Warehouse lead", doing: exceptions[0].text.replace(/^pallet /, "Pallet ") };
  else if (status === "completed") owner = { kind: "none", name: "Nobody", doing: "Done" };
  else if (order.status === "pending") owner = { kind: "retailer", name: retailer, doing: "Send a corrected order" };
  else {
    const open = firstOpen?.key;
    // No sign-off is waiting, so nobody has to approve this step. Grok (and code) has the order.
    // A warehouse team face here read as a person on the hook for work that needs no approval.
    owner =
      open === "confirmed"
        ? { kind: "agent", name: "Order agent", doing: "Checking the order" }
        : open === "reserved" || open === "planned"
          ? { kind: "agent", name: "Logistics agent", doing: "Planning the truck" }
          : open === "picked" || open === "loaded" || open === "dispatched"
            ? { kind: "agent", name: "Back office", doing: open === "picked" ? "Picking the pallets" : open === "loaded" ? "Scanning and loading" : "Shipment is on the road" }
            : open === "invoiced"
              ? { kind: "agent", name: "Documents agent", doing: "Writing the invoice" }
              : open === "received_by_retailer"
                ? { kind: "retailer", name: retailer, doing: "Receiving the delivery" }
                : open === "paid"
                  ? { kind: "retailer", name: retailer, doing: "Paying the invoice" }
                  : { kind: "none", name: "Nobody", doing: "Done" };
  }

  // A split delivery: the backorders saved on the order, with the stock-short step that proposed them.
  const backorders = ((order.notes ?? {}) as { backorders?: { qty: number; date: string | null; gtin: string | null }[] }).backorders ?? [];
  const qtyStep = allAudit.filter((a) => a.action === "order.qty_short").at(-1);
  const qtyDetail = (qtyStep?.detail ?? {}) as { message?: string; why?: unknown; action?: string };
  const later = backorders.reduce((a, b) => a + b.qty, 0);
  const split: Split | null = later
    ? {
        now: confirmed,
        later,
        laterDate: backorders.map((b) => b.date).filter((d): d is string => !!d).sort()[0] ?? null,
        product: backorders[0]?.gtin ? (erp.product({ gtin: backorders[0].gtin })?.name ?? null) : null,
        by: qtyStep?.actor === "grok" ? "grok" : "code",
        message: qtyDetail.message ?? null,
        why: typeof qtyDetail.why === "string" ? qtyDetail.why : null,
      }
    : null;

  const value = Math.round(order.lines.reduce((a, l) => a + (l.qtyConfirmed ?? l.qtyOrdered ?? 0) * (l.unitPrice ?? 0), 0) * 100) / 100;
  const core = journey.filter((j) => j.key !== "claim");
  const progress = { done: core.filter((j) => j.done).length, total: core.length, current: firstOpen?.label ?? null };

  return {
    orderRef: ref,
    retailer,
    deliveryDate: isoDate(order.deliveryDate),
    orderDate: isoDate(order.orderDate),
    status,
    statusLabel: STATUS_LABEL[status],
    statusText,
    nextStep,
    counter: {
      agents,
      people,
      text: `Grok and code did ${agents} steps, people approved ${people}`,
    },
    journey,
    story: orderStory(erp, ref),
    summary: {
      ordered,
      confirmed,
      reserved,
      shipped,
      remaining,
      received,
      invoiced,
      paid,
      moneyAtStake,
      moneyAtStakeNote: c.invoices.length ? `Invoiced and not yet paid${claimAtStake ? ", plus open claims" : ""}` : "Nothing invoiced yet",
      nextEvent,
    },
    details: {
      lines: (detail?.lines ?? []).map((l) => ({
        lineNo: l.lineNo,
        product: l.product,
        gtin: l.gtin,
        ordered: l.qtyOrdered,
        confirmed: l.qtyConfirmed,
        unitPrice: l.unitPrice,
        contractPrice: l.contractPrice,
      })),
      grokChanges,
      contractId: order.contractId,
      ordersDoc: order.sourceDoc,
      ordrspDoc: order.ordrspRef,
    },
    inventory: {
      lines: gtins.map((g) => {
        const atp = availableToPromise(erp, g);
        return { gtin: g, product: erp.product({ gtin: g })?.name ?? null, atp: atp.atp, released: atp.released, held: atp.held, committed: atp.committed };
      }),
      batches: gtins.flatMap((g) => batches(erp, g).map((b) => ({ batch: b.batch, gtin: b.gtin, qty: b.qty, status: b.status }))),
      events: c.production,
    },
    shipping: ship
      ? {
          truck: ship.plan.truck ? { id: ship.plan.truck.truck_id, plate: ship.plan.truck.plate ?? null, destination: ship.plan.truck.destination ?? null } : null,
          manifest: ship.plan.manifest
            ? { id: ship.plan.manifest.manifest_id, status: ship.plan.manifest.status, orders: ship.plan.manifest.orders, pallets: ship.plan.manifest.pallets }
            : null,
          pallets: ship.pallets.length,
          scans: {
            ok: ship.scans.filter((s) => s.result === "OK").length,
            other: ship.scans.filter((s) => s.result !== "OK").length,
            notes: ship.exceptions.map((e) => e.explanation),
          },
          loaded: !!ship.loading,
          shipments: ship.shipments.map((s) => {
            const t = c.shipments.find((x) => x.desadv === s.desadvRef);
            return {
              desadv: s.desadvRef,
              ddt: s.ddtRef,
              shipDate: s.shipDate,
              qty: t?.qty ?? 0,
              batches: t?.batches ?? [],
              notes: s.notes,
              documents: s.documents.map((d) => ({ docId: d.doc_id, kind: d.kind })),
            };
          }),
        }
      : null,
    finance: {
      invoices: c.invoices.map((i) => ({
        invoice: i.invoice,
        status: i.status,
        statusText:
          i.status === "sent"
            ? "Released to the retailer (simulated send, no SdI submission recorded)"
            : i.status === "held"
              ? "Held for a check"
              : i.status,
        total: i.total ?? 0,
        documents: erp.documents({ ref: i.invoice }).map((d) => ({ docId: d.docId, kind: d.kind })),
      })),
      payments: c.payments,
      deductions: c.deductions,
      paymentNote: c.payments.length ? `${money(paid)} paid` : "No payment recorded",
    },
    claims: c.claims,
    exceptions,
    history: audit.map((a) => ({ at: a.at, who: who(a.actor), action: actionText(a.action), document: a.source_doc })),
    agents: agentsOf(audit.map((a) => a.action)),
    owner,
    split,
    value,
    progress,
    askQuestion: `Tell me about order ${ref}: where is it, what is open, and what should happen next?`,
    caught: caughtProblems(erp, ref),
    contract: contractFor(order.buyerGln),
    documents: orderDocuments(erp, ref, [...c.invoices.map((i) => i.invoice), ...c.claims.map((cl) => cl.claim_id), ...c.shipments.map((sh) => sh.desadv)]),
  };
}
