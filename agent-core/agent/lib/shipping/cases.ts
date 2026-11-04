/**
 * Exception cases for the Shipping row: Grok proposes, code validates, an employee approves,
 * the action runs once, a recheck says whether it worked (port of shipping/cases.py).
 *
 * Rebuilt from Nicola's v0.5.0 write-up. There is no euro threshold: every proposed resolution
 * is approved by an employee in the case's role. A validated proposal also appears in the shared
 * sign-off queue (core/signoff.ts), so one desk lists all rows.
 *
 * Never allowed, whoever proposes it: releasing a quality hold, unblocking dispatch, issuing an
 * invoice or a credit note, sending a message, editing an amount, ignoring truck capacity or a
 * delivery window.
 *
 * Cases, proposals and Grok packages are JSON documents: Python key names (snake_case).
 */
import type { Erp, Order } from "../core/erp";
import { nowIso } from "../core/erp";
import { decide as decideSignoffRow, requestSignoff } from "../core/signoff";
import { batches } from "../core/stock";
import { type Caller, chatJson, hasKey } from "../grok/client";
import { pyG } from "./format";
import * as wh from "./warehouse";

type Json = Record<string, unknown>;

export const FORBIDDEN = new Set([
  "RELEASE_QUALITY_HOLD",
  "UNBLOCK_DISPATCH",
  "ISSUE_INVOICE",
  "ISSUE_CREDIT_NOTE",
  "SEND_MESSAGE",
  "EDIT_AMOUNT",
  "IGNORE_CAPACITY",
  "IGNORE_DELIVERY_WINDOW",
]);

/** type -> [department, role, candidate actions] */
export const TEMPLATES: Record<string, [string, string, string[]]> = {
  TRUCK_CAPACITY_EXCEEDED: ["logistics", "transport_planner", ["PLAN_ON_TRUCK"]],
  TRUCK_WEIGHT_EXCEEDED: ["logistics", "transport_planner", ["PLAN_ON_TRUCK"]],
  DELIVERY_WINDOW: ["logistics", "transport_planner", ["PLAN_ON_TRUCK"]],
  DESTINATION_MISMATCH: ["logistics", "transport_planner", ["PLAN_ON_TRUCK"]],
  TRUCK_UNAVAILABLE: ["logistics", "transport_planner", ["PLAN_ON_TRUCK"]],
  NO_TRUCK: ["logistics", "transport_planner", ["PLAN_ON_TRUCK"]],
  PLAN_MISSING_PRODUCT_DATA: ["master_data", "master_data_clerk", []],
  WRONG_TRUCK: ["warehouse", "warehouse_lead", ["RESCAN_PALLET"]],
  DUPLICATE_SCAN: ["warehouse", "warehouse_operator", ["IGNORE_DUPLICATE"]],
  MISSING_PALLET: ["warehouse", "warehouse_lead", ["RESCAN_PALLET", "SHIP_WITHOUT_PALLET"]],
  WRONG_PRODUCT: ["warehouse", "warehouse_lead", ["RESCAN_PALLET", "SHIP_WITHOUT_PALLET"]],
  WRONG_BATCH: ["warehouse", "warehouse_lead", ["RESCAN_PALLET", "SHIP_WITHOUT_PALLET"]],
  BAD_QUANTITY: ["warehouse", "warehouse_lead", ["RESCAN_PALLET", "SHIP_WITHOUT_PALLET"]],
  UNKNOWN_PALLET: ["warehouse", "warehouse_lead", []],
  QUALITY_HOLD: ["quality", "quality_manager", ["REPLACE_BATCH", "SHIP_WITHOUT_PALLET"]],
  SHORT_SHIPMENT: ["customer_service", "account_manager", ["BACKORDER", "CONFIRM_SHORT_SHIPMENT"]],
  INVOICE_QUANTITY: ["finance", "billing_clerk", ["HOLD_INVOICE"]],
  INVOICE_PRICE: ["finance", "billing_clerk", ["HOLD_INVOICE"]],
  RECEIVING_GAP: ["customer_service", "account_manager", ["REQUEST_POD"]],
  ORDER_NOT_READY: ["customer_service", "account_manager", []],
};

const TRUCK_TYPES = new Set(["TRUCK_CAPACITY_EXCEEDED", "TRUCK_WEIGHT_EXCEEDED", "DELIVERY_WINDOW", "DESTINATION_MISMATCH", "TRUCK_UNAVAILABLE", "NO_TRUCK"]);

export type ProposedAction = { action: string; params?: Json | null };
export type HistoryEntry = { at: string; actor: string; event: string; detail: unknown };

export type ExceptionCase = {
  case_id: string;
  exception_id: string;
  type: string;
  severity: string;
  order_ref: string | null;
  truck_id: string | null;
  pallet_id: string | null;
  shipment_ref: string | null;
  invoice_ref: string | null;
  explanation: string;
  evidence: Json | null;
  financial_impact_eur: number | null;
  department: string;
  role: string;
  possible_actions: { action: string; selected: boolean }[];
  approval_required: string;
  assigned_to: { employee_id: string; role: string } | null;
  status: string;
  proposals: string[];
  approved_proposal: string | null;
  signoff_case: string | null;
  executed: boolean;
  history: HistoryEntry[];
  resolution?: "resolved" | "unresolved";
};

export type Proposal = {
  proposal_id: string;
  case_id: string;
  by: string;
  actions: ProposedAction[];
  rationale: unknown;
  confidence: unknown;
  status: "validated" | "rejected";
  problems: string[];
  at: string;
};

function save(erp: Erp, c: ExceptionCase) {
  wh.run(erp, "INSERT OR REPLACE INTO si_exception_cases(case_id, data) VALUES(?, ?)", c.case_id, JSON.stringify(c));
}

function history(c: ExceptionCase, actor: string, event: string, detail: unknown = null) {
  c.history.push({ at: nowIso(), actor, event, detail });
}

export function viewExceptionCase(erp: Erp, caseId: string): ExceptionCase | undefined {
  const row = wh.one<{ data: string }>(erp, "SELECT data FROM si_exception_cases WHERE case_id = ?", caseId);
  return row ? (JSON.parse(row.data) as ExceptionCase) : undefined;
}

function mustCase(erp: Erp, caseId: string): ExceptionCase {
  const c = viewExceptionCase(erp, caseId);
  if (!c) throw new Error(`no exception case ${caseId}`);
  return c;
}

/** Every exception case (optionally for one order), oldest first. */
export function exceptionCases(erp: Erp, orderRef?: string): ExceptionCase[] {
  return wh
    .all<{ data: string }>(erp, "SELECT data FROM si_exception_cases ORDER BY case_id")
    .map((r) => JSON.parse(r.data) as ExceptionCase)
    .filter((c) => !orderRef || c.order_ref === orderRef);
}

/** One case per exception, from its template. Candidates start unselected. */
export function openExceptionCases(erp: Erp, exceptions: wh.ShippingException[]): string[] {
  const ids: string[] = [];
  for (const exc of exceptions) {
    const [department, role, actions] = TEMPLATES[exc.type] ?? ["operations", "operations_lead", []];
    const c: ExceptionCase = {
      case_id: erp.nextId("si_case", "CASE-"),
      exception_id: exc.exception_id,
      type: exc.type,
      severity: exc.severity,
      order_ref: exc.order_ref ?? null,
      truck_id: exc.truck_id ?? null,
      pallet_id: exc.pallet_id ?? null,
      shipment_ref: exc.shipment_ref ?? null,
      invoice_ref: exc.invoice_ref ?? null,
      explanation: exc.explanation,
      evidence: exc.evidence ?? null,
      financial_impact_eur: exc.financial_impact_eur ?? null,
      department,
      role,
      possible_actions: [...actions, "REQUEST_CLARIFICATION"].map((a) => ({ action: a, selected: false })),
      approval_required: `an employee with role ${role}`,
      assigned_to: null,
      status: "open",
      proposals: [],
      approved_proposal: null,
      signoff_case: null,
      executed: false,
      history: [],
    };
    history(c, "code", "opened", exc.explanation);
    save(erp, c);
    erp.log("code", "shipping.case_opened", exc.order_ref ?? null, { sourceDoc: c.case_id, detail: exc.type });
    ids.push(c.case_id);
  }
  return ids;
}

export function assignException(erp: Erp, caseId: string, a: { employeeId: string; role: string }): ExceptionCase {
  const c = mustCase(erp, caseId);
  if (a.role !== c.role) throw new Error(`${caseId} needs role ${c.role}, not ${a.role}`);
  c.assigned_to = { employee_id: a.employeeId, role: a.role };
  history(c, "code", "assigned", a.employeeId);
  save(erp, c);
  return c;
}

/** An ERP order in the Python dict shape (what Grok and the hand-overs read). */
export function orderDict(order: Order | undefined | null): Json | null {
  if (!order) return null;
  return {
    order_ref: order.orderRef,
    buyer_gln: order.buyerGln,
    supplier_gln: order.supplierGln,
    order_date: order.orderDate,
    delivery_date: order.deliveryDate,
    status: order.status,
    contract_id: order.contractId,
    ordrsp_ref: order.ordrspRef,
    source_doc: order.sourceDoc,
    notes: order.notes,
    lines: order.lines.map((l) => ({
      order_ref: l.orderRef,
      line_no: l.lineNo,
      gtin: l.gtin,
      qty_ordered: l.qtyOrdered,
      qty_confirmed: l.qtyConfirmed,
      unit_price: l.unitPrice,
    })),
  };
}

const batchDict = (b: { batch: string; gtin: string; qty: number; status: string; availableFrom: string | null; sourceDoc: string | null }) => ({
  batch: b.batch,
  gtin: b.gtin,
  qty: b.qty,
  status: b.status,
  available_from: b.availableFrom,
  source_doc: b.sourceDoc,
});

export const PARAMS_BY_ACTION: Record<string, Json> = {
  PLAN_ON_TRUCK: { truck_id: "string" },
  REPLACE_BATCH: { batch: "a released batch of the same product" },
  RESCAN_PALLET: {},
  SHIP_WITHOUT_PALLET: {},
  IGNORE_DUPLICATE: {},
  BACKORDER: { date: "YYYY-MM-DD" },
  CONFIRM_SHORT_SHIPMENT: {},
  HOLD_INVOICE: {},
  REQUEST_POD: {},
  REQUEST_CLARIFICATION: { question: "string" },
};

/** Read-only facts for Grok: the case, what may be proposed, and the data to check it against. */
export function grokCasePackage(erp: Erp, caseId: string): Json {
  const c = mustCase(erp, caseId);
  const order = c.order_ref ? erp.order(c.order_ref) : undefined;
  const facts: Json = { order: orderDict(order) };
  if (TRUCK_TYPES.has(c.type) && order) {
    facts.load = wh.orderLoad(erp, c.order_ref!);
    facts.trucks = wh.trucks(erp);
  }
  if (c.pallet_id) {
    const p = wh.pallet(erp, c.pallet_id) ?? null;
    facts.pallet = p;
    if (p) facts.released_batches = batches(erp, p.gtin, "released").map(batchDict);
  }
  return {
    task: "shipping.case_resolution",
    case: {
      case_id: c.case_id,
      type: c.type,
      severity: c.severity,
      order_ref: c.order_ref,
      truck_id: c.truck_id,
      pallet_id: c.pallet_id,
      explanation: c.explanation,
      evidence: c.evidence,
      financial_impact_eur: c.financial_impact_eur,
      role: c.role,
    },
    allowed_actions: c.possible_actions.map((a) => a.action),
    never_allowed: [...FORBIDDEN].sort(),
    facts,
    answer_format: { actions: [{ action: "one of allowed_actions", params: {} }], rationale: "string", confidence: "0..1" },
    params_by_action: PARAMS_BY_ACTION,
  };
}

/** null if the action is valid; otherwise why not. */
export function checkAction(erp: Erp, c: ExceptionCase, action: ProposedAction): string | null {
  const code = action?.action;
  const params = (action?.params ?? {}) as Json;
  if (FORBIDDEN.has(code)) return `${code} is never allowed`;
  if (!c.possible_actions.some((a) => a.action === code)) return `${code} is not an option for a ${c.type} case`;
  if (code === "PLAN_ON_TRUCK") {
    const t = wh.truck(erp, String(params.truck_id || ""));
    if (!t) return `truck ${params.truck_id == null ? "None" : `'${params.truck_id}'`} does not exist`;
    const problems = wh.truckFits(erp, t, wh.orderLoad(erp, c.order_ref!));
    if (problems.length) return `truck ${t.truck_id} does not fit: ${problems.join(", ")}`;
  }
  if (code === "REPLACE_BATCH") {
    const p = wh.pallet(erp, c.pallet_id);
    const b = wh.one<{ batch: string; gtin: string; qty: number; status: string }>(erp, "SELECT * FROM batches WHERE batch = ?", params.batch ?? null);
    if (!p || !b) return "pallet or batch not found";
    if (b.status !== "released" || b.gtin !== p.gtin) return `batch ${b.batch} is ${b.status} or another product`;
    if (b.qty - wh.reserved(erp, b.batch) < p.qty) return `batch ${b.batch} has not enough free stock for ${pyG(p.qty)}`;
  }
  if (code === "BACKORDER" && !params.date) return "BACKORDER needs a date";
  return null;
}

/** Validate every action. One failing action rejects the whole proposal. */
export function submitResolutionProposal(erp: Erp, caseId: string, proposal: Json, opts: { by?: string } = {}): Proposal {
  const by = opts.by ?? "grok";
  const c = mustCase(erp, caseId);
  const actions = (Array.isArray(proposal.actions) ? proposal.actions : []) as ProposedAction[];
  const problems = actions.length ? actions.map((a) => checkAction(erp, c, a)).filter((p): p is string => !!p) : ["no actions"];
  const pid = erp.nextId("si_proposal", "PRP-");
  const record: Proposal = {
    proposal_id: pid,
    case_id: caseId,
    by,
    actions,
    rationale: proposal.rationale ?? null,
    confidence: proposal.confidence ?? null,
    status: problems.length ? "rejected" : "validated",
    problems,
    at: nowIso(),
  };
  wh.run(erp, "INSERT INTO si_proposals(proposal_id, case_id, data) VALUES(?,?,?)", pid, caseId, JSON.stringify(record));
  c.proposals.push(pid);
  history(c, by, `proposal_${record.status}`, problems.length ? problems : actions);
  if (!problems.length) {
    const chosen = new Set(actions.map((a) => a.action));
    for (const opt of c.possible_actions) opt.selected = chosen.has(opt.action);
    c.status = "awaiting_approval";
    const typeText = c.type.replace(/_/g, " ").toLowerCase();
    c.signoff_case = requestSignoff(erp, {
      row: "shipping",
      kind: "exception_case",
      subjectRef: caseId,
      title: `${typeText.charAt(0).toUpperCase()}${typeText.slice(1)} on ${c.order_ref}: approve ${actions.map((a) => a.action).join(", ")}?`,
      proposal: { exception_case: caseId, proposal_id: pid, actions, rationale: record.rationale },
      reasons: [`Shipping rule: an employee with role ${c.role} approves every exception resolution`],
    });
  }
  save(erp, c);
  return record;
}

export function proposal(erp: Erp, proposalId: string): Proposal | undefined {
  const row = wh.one<{ data: string }>(erp, "SELECT data FROM si_proposals WHERE proposal_id = ?", proposalId);
  return row ? (JSON.parse(row.data) as Proposal) : undefined;
}

export function proposals(erp: Erp, caseId: string): Proposal[] {
  return wh.all<{ data: string }>(erp, "SELECT data FROM si_proposals WHERE case_id = ? ORDER BY proposal_id", caseId).map((r) => JSON.parse(r.data) as Proposal);
}

/** Send the package to Grok and hand its answer to the validator. null without a key. */
export async function proposeWithGrok(erp: Erp, caseId: string, opts: { caller?: Caller | null } = {}): Promise<Proposal | null> {
  const caller = opts.caller ?? null;
  if (caller === null && !hasKey()) return null;
  const pkg = grokCasePackage(erp, caseId);
  const messages = [
    {
      role: "system" as const,
      content:
        "You resolve shipping exception cases for the Riso Scotti back office. Choose only from " +
        "allowed_actions, never from never_allowed, with the params listed. Use only trucks and batches " +
        "present in the facts. Return one JSON object in answer_format.",
    },
    { role: "user" as const, content: JSON.stringify(pkg) },
  ];
  const validate = (payload: Json): string[] => {
    if (!Array.isArray(payload.actions) || !payload.actions.length) return ["actions must be a non-empty list"];
    const c = mustCase(erp, caseId);
    return (payload.actions as ProposedAction[]).map((a) => checkAction(erp, c, a)).filter((p): p is string => !!p);
  };
  let payload: Json;
  try {
    payload = await chatJson(messages, { task: "shipping.case_resolution", validate, caller });
  } catch {
    // GrokAnswerRejected, MissingApiKeyError or a network error: the case stays with a person.
    return null;
  }
  return submitResolutionProposal(erp, caseId, payload, { by: "grok" });
}

/** approve | reject | clarify, by an employee in the case's role. Approving runs nothing. */
export function decideResolution(
  erp: Erp,
  caseId: string,
  d: { employeeId: string; role: string; decision: "approve" | "reject" | "clarify" | string; reason: string },
): ExceptionCase {
  const c = mustCase(erp, caseId);
  if (d.role !== c.role) throw new Error(`${caseId} needs role ${c.role}, not ${d.role}`);
  if (!["approve", "reject", "clarify"].includes(d.decision)) throw new Error("decision is approve, reject or clarify");
  if ((d.decision === "approve" || d.decision === "reject") && c.status !== "awaiting_approval") {
    throw new Error(`${caseId} has no validated proposal to ${d.decision}`);
  }
  const last = c.proposals.length ? c.proposals[c.proposals.length - 1] : null;
  if (d.decision === "clarify") c.status = "clarification_requested";
  else if (d.decision === "approve") {
    c.status = "approved";
    c.approved_proposal = last;
  } else c.status = "open";
  if (c.signoff_case && (d.decision === "approve" || d.decision === "reject")) {
    decideSignoffRow(erp, c.signoff_case, { approve: d.decision === "approve", by: d.employeeId, reason: d.reason });
  }
  history(c, `person:${d.employeeId}`, d.decision, d.reason);
  save(erp, c);
  return c;
}

export type ExecutionResult = { status: "EXECUTED" | "DUPLICATE_EXECUTION"; case_id: string; results?: unknown[] };

/** Run the approved actions once. A second call returns DUPLICATE_EXECUTION. */
export function executeResolution(erp: Erp, caseId: string): ExecutionResult {
  const c = mustCase(erp, caseId);
  if (c.executed) return { status: "DUPLICATE_EXECUTION", case_id: caseId };
  if (c.status !== "approved") throw new Error(`${caseId} is ${c.status}: approve a proposal first`);
  const record = proposal(erp, c.approved_proposal!)!;
  const done: unknown[] = [];
  for (const action of record.actions) {
    const code = action.action;
    const params = (action.params ?? {}) as Json;
    if (code === "PLAN_ON_TRUCK") {
      done.push(wh.planTruckLoads(erp, [c.order_ref!], { onlyTruckId: String(params.truck_id) }));
    } else if (code === "REPLACE_BATCH") {
      wh.run(erp, "UPDATE si_pallets SET batch = ?, status = 'picked' WHERE pallet_id = ?", params.batch, c.pallet_id);
      done.push({ pallet: c.pallet_id, batch: params.batch });
    } else if (code === "RESCAN_PALLET") {
      wh.run(erp, "UPDATE si_pallets SET status = 'picked' WHERE pallet_id = ?", c.pallet_id);
      done.push({ pallet: c.pallet_id, status: "picked, waiting for a scan" });
    } else if (code === "SHIP_WITHOUT_PALLET") {
      wh.run(erp, "UPDATE si_pallets SET status = 'excluded' WHERE pallet_id = ?", c.pallet_id);
      done.push({ pallet: c.pallet_id, status: "excluded" });
    } else if (code === "BACKORDER") {
      const order = erp.order(c.order_ref!)!;
      const notes: Json = { ...(order.notes ?? {}) };
      const backorders = Array.isArray(notes.backorders) ? [...(notes.backorders as unknown[])] : [];
      backorders.push({ date: params.date, case: caseId });
      notes.backorders = backorders;
      erp.setOrder(c.order_ref!, { notes });
      done.push({ backorder: params.date });
    } else if (code === "HOLD_INVOICE" && c.invoice_ref) {
      erp.setInvoiceStatus(c.invoice_ref, "held");
      done.push({ invoice: c.invoice_ref, status: "held" });
    } else {
      done.push({ recorded: code });
    }
  }
  c.executed = true;
  c.status = "executed";
  history(c, "code", "executed", done);
  save(erp, c);
  erp.log("code", "shipping.case_executed", c.order_ref, { sourceDoc: caseId, detail: done });
  return { status: "EXECUTED", case_id: caseId, results: done };
}

/** Set resolved or unresolved from the stored facts. Changes no stock and no document. */
export function recheckExceptionCase(erp: Erp, caseId: string): { case_id: string; resolution: "resolved" | "unresolved" } {
  const c = mustCase(erp, caseId);
  let resolved = false;
  const p = c.pallet_id ? wh.pallet(erp, c.pallet_id) : undefined;
  const t = c.type;
  if (TRUCK_TYPES.has(t)) {
    resolved = wh.manifestForOrder(erp, c.order_ref!) !== undefined;
  } else if (p !== undefined) {
    if (t === "QUALITY_HOLD") {
      resolved = p.status === "excluded" || (wh.batchStatus(erp, p.batch) === "released" && ["picked", "verified", "loaded", "dispatched"].includes(p.status));
    } else {
      resolved = ["verified", "loaded", "dispatched", "excluded"].includes(p.status);
    }
  } else if (t === "DUPLICATE_SCAN") {
    resolved = c.executed;
  }
  c.resolution = resolved ? "resolved" : "unresolved";
  history(c, "code", "rechecked", c.resolution);
  save(erp, c);
  return { case_id: caseId, resolution: c.resolution };
}
