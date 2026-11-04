/**
 * What the agents did, counted from the Mini ERP: the Home's four numbers, the impact line,
 * and the "Recently completed" list. Every figure comes from a table or the audit log; the
 * benchmark comes from agent/lib/bench/score.ts on the labelled bench cases.
 */
import { score } from "../bench/score";
import type { AuditEntry, Erp } from "./erp";
import { stockStatus } from "./overview";

const CLOSED = new Set(["closed", "cancelled", "rejected", "paid", "completed"]);

export type ImpactSummary = {
  asOf: string;
  counts: { activeOrders: number; runningAutomatically: number; needingPerson: number; casesWaiting: number; deliveriesAtRisk: number };
  atRisk: { orderRef: string; why: string }[];
  steps: { byAgents: number; byPeople: number; source: string };
  cases: { total: number; withoutPerson: number; share: number | null; source: string };
  invoiceGapsCaught: { count: number; causes: string[]; source: string };
  benchmark: { cases: number; ours: number; threeway: number; source: string } | null;
  recent: { text: string; ref: string | null; at: string; href: string | null }[];
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);

function openShippingCases(erp: Erp): { caseId: string; orderRef: string | null; status: string }[] {
  try {
    const rows = erp.sqlite.prepare("select data from si_exception_cases").all() as { data: string }[];
    return rows
      .map((r) => JSON.parse(r.data) as Json)
      .map((d) => ({ caseId: String(d.case_id), orderRef: (d.order_ref as string) ?? null, status: String(d.status ?? "") }))
      .filter((c) => !["executed", "closed", "resolved", "rejected"].includes(c.status));
  } catch {
    return [];
  }
}

/** The order refs a pending sign-off is about (order cases directly; claims through their order). */
function ordersWithPendingSignoff(erp: Erp): Set<string> {
  const refs = new Set<string>();
  const known = new Set(erp.orders().map((o) => o.orderRef));
  for (const s of erp.signoffs({ status: "pending" })) {
    if (s.subjectRef && known.has(s.subjectRef)) refs.add(s.subjectRef);
    const claim = s.subjectRef ? erp.claim(s.subjectRef) : undefined;
    if (claim?.orderRef && known.has(claim.orderRef)) refs.add(claim.orderRef);
    const m = /\bon ([A-Z0-9][A-Z0-9-]+\d)\b/.exec(s.title ?? "");
    if (m && known.has(m[1])) refs.add(m[1]);
  }
  return refs;
}

function recentlyCompleted(erp: Erp, audit: AuditEntry[]): ImpactSummary["recent"] {
  const out: ImpactSummary["recent"] = [];
  const invoiceOf = (orderRef: string | null) => (orderRef ? erp.invoices(orderRef)[0]?.invoiceRef : undefined);
  for (const e of [...audit].reverse()) {
    if (out.length >= 6) break;
    const ref = e.subjectRef;
    const d = obj(e.detail);
    const orderHref = ref ? `/orders?ref=${encodeURIComponent(ref)}` : null;
    if (e.action === "shipping.dispatched") out.push({ text: `${ref} dispatched${d?.truck ? ` on ${d.truck}` : ""}`, ref, at: e.at, href: orderHref });
    else if (e.action === "shipping.invoice_sent") out.push({ text: `Invoice ${invoiceOf(ref) ?? ""} sent for ${ref}`.replace("  ", " "), ref, at: e.at, href: orderHref });
    else if (e.action === "shipping.reconciled") out.push({ text: `${invoiceOf(ref) ?? ref} reconciled`, ref, at: e.at, href: orderHref });
    else if (e.action === "dispute.td04_xml") {
      const claim = ref ? erp.claim(ref) : undefined;
      out.push({ text: `Credit note written for ${ref}`, ref, at: e.at, href: claim?.orderRef ? `/orders?ref=${encodeURIComponent(claim.orderRef)}` : null });
    } else if (e.action === "order.ordrsp_sent") out.push({ text: `${ref} confirmed, ORDRSP sent`, ref, at: e.at, href: orderHref });
  }
  return out;
}

export function impactSummary(erp: Erp, opts: { bench?: boolean } = {}): ImpactSummary {
  const orders = erp.orders();
  const audit = erp.auditLog();
  const active = orders.filter((o) => !CLOSED.has(o.status));
  const needs = ordersWithPendingSignoff(erp);

  // Deliveries at risk: a fulfilment gap, stock on quality hold for an order not yet shipped, or an open shipping case.
  const held = new Set(stockStatus(erp).products.filter((p) => p.held > 0).map((p) => p.gtin));
  const shippingOpen = openShippingCases(erp);
  const atRisk: ImpactSummary["atRisk"] = [];
  for (const o of active) {
    const gap = typeof o.notes?.fulfilment_gap === "string" ? (o.notes.fulfilment_gap as string) : null;
    const shipped = erp.shipments(o.orderRef).length > 0;
    const hold = !shipped && o.lines.some((l) => l.gtin && held.has(l.gtin));
    const sc = shippingOpen.find((c) => c.orderRef === o.orderRef);
    const why = gap ?? (sc ? `open shipping case ${sc.caseId}` : hold ? "stock on quality hold for this product" : null);
    if (why) atRisk.push({ orderRef: o.orderRef, why });
  }

  let byAgents = 0;
  let byPeople = 0;
  for (const e of audit) {
    if (e.actor === "code" || e.actor === "grok") byAgents++;
    else if (e.actor.startsWith("person:")) byPeople++;
  }

  // Cases: orders, claims and shipping exception cases. "With a person" = a sign-off was asked for it.
  const signed = new Set(erp.signoffs().map((s) => s.subjectRef).filter(Boolean) as string[]);
  const caseRefs = [
    ...orders.map((o) => o.orderRef),
    ...erp.claims().map((c) => c.claimId),
    ...((() => {
      try {
        return (erp.sqlite.prepare("select case_id from si_exception_cases").all() as { case_id: string }[]).map((r) => r.case_id);
      } catch {
        return [];
      }
    })()),
  ];
  const withoutPerson = caseRefs.filter((r) => !signed.has(r)).length;

  const causes: string[] = [];
  for (const e of audit) if (e.action === "shipping.reconciled") for (const c of (obj(e.detail)?.causes as string[] | undefined) ?? []) causes.push(`${e.subjectRef}: ${c.replace(/_/g, " ")}`);

  let benchmark: ImpactSummary["benchmark"] = null;
  if (opts.bench !== false) {
    try {
      const b = score();
      benchmark = { cases: b.n, ours: b.totals.ours_causes_ok, threeway: b.totals.threeway_causes_ok, source: "data/bench/cases.json, causes found right" };
    } catch {
      benchmark = null;
    }
  }

  return {
    asOf: new Date().toISOString(),
    counts: {
      activeOrders: active.length,
      runningAutomatically: active.filter((o) => !needs.has(o.orderRef)).length,
      needingPerson: active.filter((o) => needs.has(o.orderRef)).length,
      // Every case in the sign-off queue, including claims whose order is not in the Mini ERP.
      casesWaiting: erp.signoffs({ status: "pending" }).length,
      deliveriesAtRisk: atRisk.length,
    },
    atRisk,
    steps: { byAgents, byPeople, source: "audit log, by actor" },
    cases: { total: caseRefs.length, withoutPerson, share: caseRefs.length ? withoutPerson / caseRefs.length : null, source: "orders, claims and shipping cases against sign-offs" },
    invoiceGapsCaught: { count: causes.length, causes, source: "reconciliation results in the audit log" },
    benchmark,
    recent: recentlyCompleted(erp, audit),
  };
}
