/**
 * Every action traceable to its source document: the chain behind one order. Port of `core/trace.py`.
 *
 * The chain goes ORDERS -> sign-off -> ORDRSP -> production batches -> truck and pallets ->
 * DESADV + DDT -> invoice (FatturaPA + INVOIC) -> proof of delivery -> claims -> verdict ->
 * credit note or reply. `gaps()` lists any output that cannot be walked back to the document it
 * came from; the demo must have none. Keys keep the Python names (it is a JSON document).
 */
import type { Erp } from "./erp";

type Row = Record<string, unknown>;

function all(erp: Erp, sql: string, params: unknown[] = []): Row[] {
  return erp.sqlite.prepare(sql).all(...params) as Row[];
}

export type TraceChain = {
  payments: { payment_id: string; remittance_ref: string | null; value_date: string | null; source_doc: string | null; invoice_ref: string; amount_paid: number }[];
  deductions: { deduction_id: string; amount: number; reason_code: string | null; note: string | null; status: string; credit_ref: string | null; claim_id: string | null }[];
  order: { order_ref: string; status: string; buyer: string | null; orders_doc: string | null; orders_file: string | null; ordrsp_doc: string | null };
  signoffs: { case_id: string; kind: string; status: string; decided_by: string | null; decision_reason: string | null }[];
  production: { event_id: string; kind: string; batch: string | null; qty: number | null; note: string | null }[];
  exception_cases: { case_id: string; type: string; status: string; approved_by: string | null }[];
  shipments: { desadv: string; desadv_doc: string | null; ddt: string | null; ship_date: string | null; batches: string[]; qty: number; notes: string | null }[];
  invoices: { invoice: string; desadv: string | null; fatturapa_doc: string | null; status: string; total: number | null }[];
  proofs: { doc_id: string; kind: string; summary: string | null }[];
  claims: { claim_id: string; email_doc: string | null; status: string; decision: string | null; amount: number | null; sources: string[]; outputs: string[] }[];
  claim_signoffs: { case_id: string; status: string; decided_by: string | null; decision_reason: string | null }[];
  audit: { at: string; actor: string; action: string; source_doc: string | null }[];
};

function eventsForBatches(erp: Erp, batchIds: Set<string>): Row[] {
  const names = new Set<string>();
  for (const b of batchIds) {
    names.add(b);
    names.add(b.endsWith("-HOLD") ? b.slice(0, -5) : b);
    names.add(`${b}-HOLD`);
  }
  if (!names.size) return [];
  const marks = [...names].map(() => "?").join(",");
  return all(erp, `SELECT * FROM production_events WHERE batch IN (${marks}) ORDER BY event_id`, [...names]);
}

export function chain(erp: Erp, orderRef: string): TraceChain {
  const order = erp.order(orderRef);
  if (!order) throw new Error(`no order ${orderRef}`);
  const ordersDoc = order.sourceDoc ? erp.document(order.sourceDoc) : undefined;
  const allSignoffs = erp.signoffs();
  const signoffs = allSignoffs.filter((s) => s.subjectRef === orderRef);
  const shipments = erp.shipments(orderRef);
  const batchIds = new Set(shipments.flatMap((s) => s.lines.map((l) => l.batch).filter((b): b is string => !!b)));
  const invoices = erp.invoices(orderRef);
  const claims = erp.claims().filter((c) => c.orderRef === orderRef);
  const claimIds = new Set(claims.map((c) => c.claimId));
  const claimSignoffs = allSignoffs.filter((s) => claimIds.has(s.subjectRef ?? ""));
  let exceptionCases: Row[] = [];
  try {
    exceptionCases = all(erp, "SELECT data FROM si_exception_cases")
      .map((r) => JSON.parse(String(r.data)) as Row)
      .filter((c) => c.order_ref === orderRef);
  } catch {
    // the shipping tables exist only once a truck was planned
  }
  let payments: Row[] = [];
  let deductions: Row[] = [];
  try {
    const refs = invoices.map((i) => i.invoiceRef);
    if (refs.length) {
      const marks = refs.map(() => "?").join(",");
      payments = all(
        erp,
        `SELECT p.payment_id, p.remittance_ref, p.value_date, p.source_doc, l.invoice_ref, l.amount_paid FROM payment_lines l JOIN payments p USING(payment_id) WHERE l.invoice_ref IN (${marks}) ORDER BY p.payment_id`,
        refs,
      );
      deductions = all(erp, `SELECT * FROM deductions WHERE invoice_ref IN (${marks}) ORDER BY deduction_id`, refs);
    }
  } catch {
    // finance tables exist once a remittance was recorded
  }
  const subjects = new Set([orderRef, ...claimIds]);
  return {
    payments: payments as TraceChain["payments"],
    deductions: deductions.map((d) => ({
      deduction_id: d.deduction_id,
      amount: d.amount,
      reason_code: d.reason_code,
      note: d.note,
      status: d.status,
      credit_ref: d.credit_ref,
      claim_id: d.claim_id,
    })) as TraceChain["deductions"],
    order: {
      order_ref: orderRef,
      status: order.status,
      buyer: order.buyerGln,
      orders_doc: order.sourceDoc,
      orders_file: ordersDoc?.path ?? null,
      ordrsp_doc: order.ordrspRef,
    },
    signoffs: signoffs.map((s) => ({ case_id: s.caseId, kind: s.kind, status: s.status, decided_by: s.decidedBy, decision_reason: s.decisionReason })),
    production: eventsForBatches(erp, batchIds).map((e) => ({
      event_id: e.event_id as string,
      kind: e.kind as string,
      batch: (e.batch as string) ?? null,
      qty: (e.qty as number) ?? null,
      note: (e.note as string) ?? null,
    })),
    exception_cases: exceptionCases.map((c) => ({
      case_id: c.case_id as string,
      type: c.type as string,
      status: c.status as string,
      approved_by: ((c.history as { event: string; actor: string }[]) ?? []).find((h) => h.event === "approve")?.actor ?? null,
    })),
    shipments: shipments.map((s) => ({
      desadv: s.desadvRef,
      desadv_doc: s.sourceDoc,
      ddt: s.ddtRef,
      ship_date: s.shipDate,
      batches: [...new Set(s.lines.map((l) => l.batch).filter((b): b is string => !!b))].sort(),
      qty: s.lines.reduce((a, l) => a + l.qty, 0),
      notes: s.notes,
    })),
    invoices: invoices.map((i) => ({ invoice: i.invoiceRef, desadv: i.desadvRef, fatturapa_doc: i.sourceDoc, status: i.status, total: i.total })),
    proofs: erp.proofs(orderRef).map((p) => ({ doc_id: p.docId, kind: p.kind, summary: p.summary })),
    claims: claims.map((c) => {
      const v = (c.verdict ?? {}) as { decision?: string; amount?: number; points?: { source: { ref: string } }[] };
      return {
        claim_id: c.claimId,
        email_doc: c.sourceDoc,
        status: c.status,
        decision: v.decision ?? null,
        amount: v.amount ?? null,
        sources: (v.points ?? []).map((p) => p.source.ref),
        outputs: erp.documents({ ref: c.claimId }).map((d) => `${d.docId} ${d.kind}`),
      };
    }),
    claim_signoffs: claimSignoffs.map((s) => ({ case_id: s.caseId, status: s.status, decided_by: s.decidedBy, decision_reason: s.decisionReason })),
    audit: erp
      .auditLog()
      .filter((a) => subjects.has(a.subjectRef ?? ""))
      .map((a) => ({ at: a.at, actor: a.actor, action: a.action, source_doc: a.sourceDoc })),
  };
}

/** Outputs that cannot be walked back to their source. Empty means fully traceable. */
export function gaps(erp: Erp): string[] {
  const problems: string[] = [];
  for (const order of erp.orders()) {
    const ref = order.orderRef;
    if (!order.sourceDoc || !erp.document(order.sourceDoc)) problems.push(`${ref}: no ORDERS document`);
    if (["confirmed", "ready_to_ship", "shipped", "invoiced"].includes(order.status) && !order.ordrspRef) {
      problems.push(`${ref}: confirmed without an ORDRSP`);
    }
    for (const s of erp.shipments(ref)) {
      if (!s.sourceDoc || !erp.document(s.sourceDoc)) problems.push(`${s.desadvRef}: no DESADV document`);
      for (const line of s.lines) if (!line.batch) problems.push(`${s.desadvRef}: a line has no batch`);
    }
    for (const inv of erp.invoices(ref)) {
      if (!inv.sourceDoc || !erp.document(inv.sourceDoc)) problems.push(`${inv.invoiceRef}: no FatturaPA document`);
      if (!inv.desadvRef || !erp.shipment(inv.desadvRef)) problems.push(`${inv.invoiceRef}: invoices a shipment that does not exist`);
    }
  }
  for (const claim of erp.claims()) {
    if (!claim.sourceDoc || !erp.document(claim.sourceDoc)) problems.push(`${claim.claimId}: no claim email`);
    if (claim.status === "closed" && !erp.documents({ ref: claim.claimId }).length) {
      problems.push(`${claim.claimId}: closed with no outcome document`);
    }
  }
  try {
    for (const pay of all(erp, "SELECT * FROM payments")) {
      if (!erp.document(String(pay.source_doc))) problems.push(`${pay.payment_id}: no remittance document`);
    }
  } catch {
    // no finance tables yet
  }
  for (const c of erp.signoffs()) {
    if (c.status !== "pending" && !c.decisionReason) problems.push(`${c.caseId}: decided without a reason`);
  }
  return problems;
}

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function count(items: Iterable<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return out;
}

export function render(c: TraceChain): string {
  const o = c.order;
  const out = [`Order ${o.order_ref} (${o.status}), buyer ${o.buyer}`, `  ORDERS   ${o.orders_doc} from ${o.orders_file}`];
  for (const s of c.signoffs) out.push(`  sign-off ${s.case_id} ${s.kind}: ${s.status} by ${s.decided_by}: ${s.decision_reason}`);
  out.push(`  ORDRSP   ${o.ordrsp_doc}`);
  for (const e of c.production) out.push(`  batch    ${e.batch}: ${e.kind} ${e.qty || ""} (${e.event_id}) ${e.note || ""}`.trimEnd());
  for (const x of c.exception_cases) out.push(`  case     ${x.case_id} ${x.type}: ${x.status}, approved by ${x.approved_by}`);
  for (const s of c.shipments) {
    out.push(`  DESADV   ${s.desadv} (${s.desadv_doc}), DDT ${s.ddt}, ${s.qty} units from ${s.batches.join(", ")}${s.notes ? " | " + s.notes : ""}`);
  }
  for (const i of c.invoices) out.push(`  invoice  ${i.invoice} for ${i.desadv} (${i.fatturapa_doc}): ${i.status}, €${money(i.total ?? 0)}`);
  for (const p of c.proofs) out.push(`  proof    ${p.doc_id}: ${p.summary}`);
  for (const cl of c.claims) {
    out.push(`  claim    ${cl.claim_id} (${cl.email_doc}): ${cl.decision} ${cl.amount}, sources ${cl.sources.join(", ")}; ${cl.status}; outputs ${cl.outputs.join(", ")}`);
  }
  for (const p of c.payments) {
    out.push(`  payment  ${p.payment_id} (${p.source_doc}, remittance ${p.remittance_ref}, ${p.value_date}): €${money(p.amount_paid)} on ${p.invoice_ref}`);
  }
  for (const d of c.deductions) {
    out.push(`  deducted €${money(d.amount)} ${d.reason_code} ${d.note}: ${d.status}` + (d.credit_ref ? ` (credit note ${d.credit_ref})` : ` (claim ${d.claim_id})`));
  }
  for (const s of c.claim_signoffs) out.push(`  sign-off ${s.case_id}: ${s.status} by ${s.decided_by}: ${s.decision_reason}`);
  out.push(
    `  ${c.audit.length} logged actions: ` +
      Object.entries(count(c.audit.map((a) => a.actor.split(":")[0])))
        .map(([k, v]) => `${k} ${v}`)
        .join(", "),
  );
  return out.join("\n");
}
