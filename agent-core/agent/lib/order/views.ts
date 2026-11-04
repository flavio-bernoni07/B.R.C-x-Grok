/**
 * Read models for the Orders page, the chat cards and the agent tools. Read-only: everything
 * here comes from the Mini ERP (orders, sign-off queue, documents, audit log, stock) as the
 * Order service wrote it. Nothing here decides or confirms.
 */
import type { AuditEntry, Erp, Order, Signoff } from "../core/erp";
import { type Atp, availableToPromise, isoDate, nextReadyDate } from "../core/stock";
import type { PriceCheckDict } from "./contract";
import type { AvailabilityLineCheck } from "./pipeline";
import type { Backorder } from "./service";

export type OrderPillTone = "ok" | "grok" | "attention" | "wait" | "quiet" | "pending" | "reject";
export type OrderPill = { tone: OrderPillTone; label: string };

export type OrderSummary = {
  orderRef: string;
  retailer: string;
  buyerGln: string | null;
  orderDate: string | null; // YYYY-MM-DD
  status: string; // the ERP status, or the sign-off kind when no order row was saved
  pill: OrderPill;
  /** The check that decided where the order is now, in one line. */
  check: string;
  caseId: string | null;
  caseStatus: string | null;
  lineCount: number;
  qtyOrdered: number;
  qtyConfirmed: number | null;
  /** Friendly prose of what Grok did for this order, or null when Grok did not step in. */
  grokExplain: string | null;
};

export type OrderCheck = { name: string; ok: boolean | null; detail: string; source: string };

export type OrderDetailLine = {
  lineNo: number;
  gtin: string | null;
  product: string | null;
  qtyOrdered: number | null;
  qtyConfirmed: number | null;
  unitPrice: number | null;
  contractPrice: number | null;
};

export type OrderDocument = { docId: string; kind: string; ref: string | null; path: string | null; createdAt: string; body: string | null };

export type OrderStockPromise = {
  gtin: string;
  product: string | null;
  atp: number;
  released: number;
  planned: number;
  committed: number;
  held: number;
  nextReadyDate: string | null;
  source: string;
};

export type OrderDetail = OrderSummary & {
  contractId: string | null;
  ordrspRef: string | null;
  lines: OrderDetailLine[];
  checks: OrderCheck[];
  availability: AvailabilityLineCheck[] | null;
  /** Live available-to-promise from Mini ERP stock (prediction of what can ship). */
  stockPromise: OrderStockPromise[];
  priceCheck: PriceCheckDict | null;
  backorders: Backorder[];
  grokbot: string[];
  draftMail: string | null;
  draftOrdrsp: string | null;
  ordrsp: string | null;
  documents: OrderDocument[];
  signoffs: Signoff[];
  audit: AuditEntry[];
};

const DONE_STATUSES = new Set(["confirmed", "ready_to_ship", "shipped", "delivered", "invoiced", "closed"]);

const decidedBy = (c: Signoff | undefined) => (c?.decidedBy ? ` by ${c.decidedBy}` : "");

function casesFor(erp: Erp, ref: string, sourceDoc?: string | null): Signoff[] {
  return erp.signoffs({ row: "order" }).filter((c) => c.subjectRef === ref || (!!sourceDoc && c.subjectRef === sourceDoc));
}

function auditFor(erp: Erp, ref: string, docIds: string[]): AuditEntry[] {
  const ids = new Set(docIds);
  return erp.auditLog().filter((a) => a.subjectRef === ref || (!!a.sourceDoc && ids.has(a.sourceDoc)));
}

function lastWith<T>(cases: Signoff[], key: string): T | null {
  for (let i = cases.length - 1; i >= 0; i--) {
    const v = cases[i].proposal?.[key];
    if (v != null) return v as T;
  }
  return null;
}

/** Pill + deciding check, from the ERP status, the latest sign-off case and the audit log. */
function judge(order: Order | undefined, kind: string | null, cases: Signoff[], audit: AuditEntry[]): { pill: OrderPill; check: string } {
  const last = cases.at(-1);
  const grokFix = audit.some((a) => a.actor === "grok" && a.action === "order.parse_fix");
  const qtyShort = audit.filter((a) => a.action === "order.qty_short");
  const grokSplit = qtyShort.some((a) => a.actor === "grok");
  const codeSplit = qtyShort.find((a) => a.actor === "code");
  const status = order?.status ?? kind ?? "";

  const personSplit = audit.some((a) => a.action === "order.qty_split");
  if (DONE_STATUSES.has(status)) {
    const via = grokFix
      ? "Grok corrected the EDI, checks passed"
      : personSplit || grokSplit || codeSplit
        ? "Stock short: split accepted, checks passed"
        : "All checks passed";
    if (status === "ready_to_ship") {
      return { pill: { tone: "ok", label: "In shipping" }, check: `${via}; sent to Shipping${decidedBy(last)}` };
    }
    return { pill: { tone: "ok", label: "Confirmed" }, check: `${via}; confirmed${decidedBy(last)}` };
  }
  if (status === "awaiting_confirmation") {
    if (grokFix) return { pill: { tone: "grok", label: "Grok: fixed" }, check: "EDI corrected by Grok and parsed again; a person confirms" };
    if (personSplit || grokSplit || codeSplit) {
      return { pill: { tone: "attention", label: "Needs a person" }, check: "Stock short: available qty accepted; a person confirms before ORDRSP" };
    }
    return { pill: { tone: "attention", label: "Needs a person" }, check: "All checks passed; a person confirms before ORDRSP" };
  }
  if (status === "pending_price" || status === "price_fix") {
    return { pill: { tone: "attention", label: "Needs a person" }, check: "Price does not match the contract; manual EDI or Pending" };
  }
  if (status === "pending_manual_edi" || status === "manual_edi") {
    return { pill: { tone: "attention", label: "Needs a person" }, check: "EDI cannot be read safely; manual EDI or Pending" };
  }
  if (status === "pending_qty" || status === "qty_choice") {
    return {
      pill: { tone: "attention", label: "Needs a person" },
      check: "Stock short: choose split (ORDRSP for available qty) or mail (Pending, no ORDRSP)",
    };
  }
  if (status === "stock_short") {
    return { pill: { tone: "attention", label: "Needs a person" }, check: "Not enough stock and no split possible" };
  }
  if (status === "pending") {
    const why = last?.kind === "qty_choice" ? "Stock short (mail)" : "Price mismatch";
    return { pill: { tone: "pending", label: "Pending" }, check: `${why}: Pending${decidedBy(last)} until a new ORDERS` };
  }
  if (status === "rejected") return { pill: { tone: "reject", label: "Rejected" }, check: `Rejected${decidedBy(last)}` };
  return { pill: { tone: "wait", label: "Checking" }, check: "Checks running" };
}

function retailerName(erp: Erp, gln: string | null | undefined): string {
  return erp.retailer(gln)?.name ?? gln ?? "–";
}

type ParseChange = { segment?: string; before?: string; after?: string; why?: string };

/** Build a short, person-facing explanation of Grok's work on one order (no log jargon). */
export function grokExplainFor(order: Order | undefined, cases: Signoff[], audit: AuditEntry[]): string | null {
  const parts: string[] = [];
  const parseFix = audit.find((a) => a.actor === "grok" && a.action === "order.parse_fix");
  if (parseFix) {
    parts.push("Grok cleaned up the EDI so the order could be read safely.");
    const detail = (parseFix.detail ?? {}) as { changes?: ParseChange[] };
    for (const ch of detail.changes ?? []) {
      const seg = ch.segment?.trim();
      const before = ch.before?.trim();
      const after = ch.after?.trim();
      const why = ch.why?.trim();
      if (seg && before != null && after != null) {
        parts.push(
          why
            ? `On ${seg}, “${before}” became “${after}” (${why}).`
            : `On ${seg}, “${before}” became “${after}”.`,
        );
      }
    }
  }
  const notes = [
    ...(((order?.notes ?? {}) as { grokbot?: string[] }).grokbot ?? []),
    ...cases.flatMap((c) => {
      const g = c.proposal?.grokbot;
      return Array.isArray(g) ? (g as string[]) : [];
    }),
  ];
  for (const raw of notes) {
    const line = String(raw ?? "").trim();
    if (!line) continue;
    // Drop raw key=value / snake_case log fragments.
    if (/^[a-z0-9_]+=/.test(line) || /^[a-z]+_[a-z0-9_]+$/.test(line)) continue;
    if (parts.some((p) => p.includes(line))) continue;
    if (/^Grok corrected the EDI/i.test(line)) {
      if (!parseFix) parts.push("Grok corrected the EDI and the order was parsed again.");
      continue;
    }
    parts.push(line.endsWith(".") ? line : `${line}.`);
  }
  if (!parts.length && audit.some((a) => a.actor === "grok")) {
    parts.push("Grok reviewed this order and left a note for the desk.");
  }
  return parts.length ? parts.join(" ") : null;
}

function summarize(erp: Erp, order: Order): OrderSummary {
  const cases = casesFor(erp, order.orderRef, order.sourceDoc);
  const docIds = [order.sourceDoc, order.ordrspRef, ...cases.map((c) => c.caseId)].filter((x): x is string => !!x);
  const audit = auditFor(erp, order.orderRef, docIds);
  const { pill, check } = judge(order, null, cases, audit);
  const last = cases.at(-1);
  const confirmed = order.lines.some((l) => l.qtyConfirmed != null)
    ? order.lines.reduce((a, l) => a + (l.qtyConfirmed ?? l.qtyOrdered ?? 0), 0)
    : null;
  return {
    orderRef: order.orderRef,
    retailer: retailerName(erp, order.buyerGln),
    buyerGln: order.buyerGln,
    orderDate: isoDate(order.orderDate),
    status: order.status,
    pill,
    check,
    caseId: last?.caseId ?? null,
    caseStatus: last?.status ?? null,
    lineCount: order.lines.length,
    qtyOrdered: order.lines.reduce((a, l) => a + (l.qtyOrdered ?? 0), 0),
    qtyConfirmed: confirmed,
    grokExplain: grokExplainFor(order, cases, audit),
  };
}

/** Sign-off cases whose order was never saved (stock short, unreadable EDI without a number). */
function orphanCases(erp: Erp): Signoff[] {
  return erp
    .signoffs({ row: "order" })
    .filter(
      (c) =>
        (c.kind === "stock_short" || c.kind === "manual_edi" || c.kind === "qty_choice") &&
        c.subjectRef &&
        !erp.order(c.subjectRef),
    );
}

function summarizeCase(erp: Erp, c: Signoff): OrderSummary {
  const avail = (c.proposal?.availability as AvailabilityLineCheck[] | undefined) ?? [];
  const holdPending = (c.status === "pending" && !!c.decidedAt) || c.status === "parked";
  const closedTone: OrderPillTone = c.status === "rejected" ? "reject" : holdPending ? "pending" : "quiet";
  const closedLabel = c.status === "rejected" ? "Rejected" : holdPending ? "Pending" : "Decided";
  const { pill, check } =
    c.status === "pending" && !c.decidedAt
      ? judge(undefined, c.kind, [c], [])
      : { pill: { tone: closedTone, label: closedLabel }, check: `${c.kind} case ${c.status}${decidedBy(c)}` };
  return {
    orderRef: c.subjectRef ?? c.caseId,
    retailer: "–",
    buyerGln: null,
    orderDate: null,
    status: c.kind,
    pill,
    check,
    caseId: c.caseId,
    caseStatus: c.status,
    lineCount: avail.length,
    qtyOrdered: avail.reduce((a, l) => a + (l.ordered_qty ?? 0), 0),
    qtyConfirmed: null,
    grokExplain: grokExplainFor(undefined, [c], []),
  };
}

/** Every order in the Mini ERP, newest first, with its pill and the check that decided it. */
export function listOrders(erp: Erp, opts: { status?: string } = {}): OrderSummary[] {
  const rows = [...erp.orders(opts.status).map((o) => summarize(erp, o)), ...(opts.status ? [] : orphanCases(erp).map((c) => summarizeCase(erp, c)))];
  return rows.sort((a, b) => (b.caseId ?? "").localeCompare(a.caseId ?? "") || a.orderRef.localeCompare(b.orderRef));
}

/** One order: lines, checks with their sources, documents, sign-off cases and audit trail. */
export function orderDetail(erp: Erp, ref: string): OrderDetail | null {
  const order = erp.order(ref);
  const orphan = order ? undefined : erp.signoffs({ row: "order" }).find((c) => c.subjectRef === ref || c.caseId === ref);
  if (!order && !orphan) return null;

  const cases = order ? casesFor(erp, ref, order.sourceDoc) : [orphan!];
  const summary = order ? summarize(erp, order) : summarizeCase(erp, orphan!);
  const availability = lastWith<AvailabilityLineCheck[]>(cases, "availability");
  const priceCheck = lastWith<PriceCheckDict>(cases, "price_check");
  const notes = (order?.notes ?? {}) as { backorders?: Backorder[]; grokbot?: string[]; draft_mail?: string; flags?: { message: string }[] };
  const flags = notes.flags ?? lastWith<{ message: string }[]>(cases, "flags") ?? [];

  // documents: the ORDERS it came from (and any earlier ORDERS of the same order), plus ORDRSP
  const sourceDocs = new Set<string>();
  if (order?.sourceDoc) sourceDocs.add(order.sourceDoc);
  const auditRef = summary.orderRef;
  const firstAudit = auditFor(erp, auditRef, [...sourceDocs, ...cases.map((c) => c.caseId)]);
  for (const a of firstAudit) if (a.sourceDoc?.startsWith("DOC-")) sourceDocs.add(a.sourceDoc);
  const docs = new Map<string, OrderDocument>();
  for (const id of sourceDocs) {
    const d = erp.document(id);
    if (d) docs.set(d.docId, d);
  }
  if (order) for (const d of erp.documents({ ref })) docs.set(d.docId, d);
  const documents = [...docs.values()].sort((a, b) => a.docId.localeCompare(b.docId));
  const audit = auditFor(erp, auditRef, [...docs.keys(), ...cases.map((c) => c.caseId)]);

  const priceByGtin = new Map((priceCheck?.lines ?? []).map((l) => [l.gtin, l.expected_price]));
  const lines: OrderDetailLine[] = order
    ? order.lines.map((l) => ({
        lineNo: l.lineNo,
        gtin: l.gtin,
        product: erp.product({ gtin: l.gtin })?.name ?? null,
        qtyOrdered: l.qtyOrdered,
        qtyConfirmed: l.qtyConfirmed,
        unitPrice: l.unitPrice,
        contractPrice: priceByGtin.get(l.gtin) ?? null,
      }))
    : (availability ?? []).map((a, i) => ({
        lineNo: i + 1,
        gtin: a.gtin,
        product: erp.product({ gtin: a.gtin })?.name ?? null,
        qtyOrdered: a.ordered_qty,
        qtyConfirmed: null,
        unitPrice: null,
        contractPrice: null,
      }));

  const parseFix = audit.find((a) => a.action === "order.parse_fix");
  const ordersDoc = order?.sourceDoc ?? [...sourceDocs][0] ?? "ORDERS";
  const status = order?.status ?? orphan!.kind;
  const checks: OrderCheck[] = [];

  // 1. Parse EDI
  if (status === "pending_manual_edi" || status === "manual_edi") {
    checks.push({ name: "Parse EDI", ok: false, detail: flags.map((f) => f.message).join("; ") || "The parser flagged the EDI", source: ordersDoc });
  } else {
    const changes = (parseFix?.detail as { segment?: string; before?: string; after?: string }[] | null) ?? [];
    checks.push({
      name: "Parse EDI",
      ok: true,
      detail: parseFix
        ? `Grok corrected ${changes.map((c) => `${c.segment}: ${c.before} -> ${c.after}`).join(", ") || "the EDI"}; the parser read it again`
        : "Read cleanly: BGM, DTM, NAD+BY, NAD+SU, LIN, QTY",
      source: parseFix ? `${ordersDoc} + Grok fix` : ordersDoc,
    });
  }

  // 2. Stock
  if (availability?.length) {
    const backorders = notes.backorders ?? [];
    const short = availability.some((a) => !a.ok);
    const parts = availability.map((a) => `${a.gtin}: ordered ${a.ordered_qty ?? "–"}, available ${a.available_qty ?? "–"}`);
    for (const b of backorders) parts.push(`line ${b.line_no}: ${b.qty} later on ${b.date}`);
    checks.push({ name: "Stock", ok: !short, detail: parts.join("; "), source: [...new Set(availability.map((a) => a.source))].join("; ") });
  } else if (status === "pending_qty" || status === "qty_choice") {
    checks.push({
      name: "Stock",
      ok: false,
      detail: "Short versus available to promise; waiting for split or mail in Sign-off Pending",
      source: "Mini ERP stock (available to promise)",
    });
  } else if (status === "pending_price" || status === "pending" || status === "awaiting_confirmation" || DONE_STATUSES.has(status)) {
    const short = audit.filter((a) => a.action === "order.qty_short" || a.action === "order.qty_split");
    const detail = short.length
      ? `Stock was short; operator ${audit.some((a) => a.action === "order.qty_split") ? "split" : "change"} then the revised quantity passed available-to-promise`
      : "Within available to promise";
    checks.push({ name: "Stock", ok: true, detail, source: "Mini ERP stock (available to promise)" });
  } else {
    checks.push({ name: "Stock", ok: null, detail: "Not reached", source: "Mini ERP stock" });
  }

  // 3. Price
  if (priceCheck) {
    const parts = priceCheck.lines.map((l) =>
      l.reason === "no_PRI_on_order"
        ? `${l.gtin}: no price on the order`
        : l.ok
          ? `${l.gtin}: €${l.order_price} matches the contract`
          : `${l.gtin}: ordered €${l.order_price ?? "–"}, contract €${l.expected_price ?? "–"} (${l.reason})`,
    );
    checks.push({ name: "Price vs contract", ok: priceCheck.ok, detail: parts.join("; "), source: `contract ${priceCheck.contract_id}` });
  } else {
    checks.push({ name: "Price vs contract", ok: null, detail: "Not reached", source: order?.contractId ? `contract ${order.contractId}` : "contract" });
  }

  // 4. Sign-off
  const last = cases.at(-1);
  if (last) {
    checks.push({
      name: "Sign-off",
      ok: last.status === "approved" ? true : last.status === "rejected" ? false : null,
      detail:
        last.status === "pending"
          ? `${last.title ?? "Waiting for a person"}`
          : `${last.status}${decidedBy(last)}: ${last.decisionReason ?? ""}`.trim(),
      source: last.caseId,
    });
  }

  const ordrspDoc = order?.ordrspRef ? erp.document(order.ordrspRef) : undefined;
  const gtins = [...new Set(lines.map((l) => l.gtin).filter((g): g is string => !!g))];
  const stockPromise: OrderStockPromise[] = gtins.map((gtin) => {
    const atp = availableToPromise(erp, gtin, order?.orderDate ?? null);
    return {
      gtin,
      product: erp.product({ gtin })?.name ?? null,
      atp: atp.atp,
      released: atp.released,
      planned: atp.planned,
      committed: atp.committed,
      held: atp.held,
      nextReadyDate: nextReadyDate(erp, gtin),
      source: `erp_atp(released ${atp.released} + planned ${atp.planned} - committed ${atp.committed})`,
    };
  });
  return {
    ...summary,
    contractId: order?.contractId ?? null,
    ordrspRef: order?.ordrspRef ?? null,
    lines,
    checks,
    availability,
    stockPromise,
    priceCheck,
    backorders: notes.backorders ?? lastWith<Backorder[]>(cases, "backorders") ?? [],
    grokbot: notes.grokbot ?? lastWith<string[]>(cases, "grokbot") ?? [],
    draftMail: notes.draft_mail ?? lastWith<string>(cases, "draft_mail"),
    draftOrdrsp: lastWith<string>(cases, "draft_ordrsp"),
    ordrsp: ordrspDoc?.body ?? null,
    documents,
    signoffs: cases,
    audit,
  };
}

export type OrderAvailability = Atp & { product: string | null; nextReadyDate: string | null; source: string };

/** Available to promise for one product by a date (YYYY-MM-DD or YYYYMMDD) from the Mini ERP stock. */
export function orderAvailability(erp: Erp, gtin: string, byDate?: string | null): OrderAvailability | null {
  const product = erp.product({ gtin });
  if (!product) return null;
  return {
    ...availableToPromise(erp, gtin, byDate),
    product: product.name,
    nextReadyDate: nextReadyDate(erp, gtin),
    source: "Mini ERP: released batches + planned batches ready by the date − confirmed orders not shipped (held batches never count)",
  };
}
