/**
 * The Orders inbox: every order read like an email row. Built from listOrders + light ERP
 * reads — not the full order workspace (that was ~0.5s+ and felt hung through the tunnel).
 */
import type { Erp } from "../core/erp";
import { isoDate } from "../core/stock";
import { agentsOf, type InboxStatus, STATUS_LABEL } from "./workspace";
import { listOrders } from "./views";

export type InboxFilter = "all" | "attention" | "progress" | "completed";

export type InboxRow = {
  orderRef: string;
  retailer: string;
  description: string;
  statusLine: string;
  deliveryDate: string | null;
  status: InboxStatus;
  statusLabel: string;
  agents: string[];
  /** False for a sign-off case whose order was never saved (no workspace to open). */
  hasWorkspace: boolean;
  /** True when Grokbot stepped in on this order. */
  grokUsed: boolean;
};

const ORDER: Record<InboxStatus, number> = { attention: 0, on_track: 1, waiting: 2, completed: 3 };

const ATTENTION_STATUSES = new Set([
  "awaiting_confirmation",
  "pending_price",
  "price_fix",
  "pending_manual_edi",
  "manual_edi",
  "stock_short",
  "pending_qty",
  "qty_choice",
]);

const n = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

function inboxStatus(status: string, openGate: boolean): InboxStatus {
  if (openGate || ATTENTION_STATUSES.has(status)) return "attention";
  if (status === "rejected" || status === "closed" || status === "delivered" || status === "invoiced") return "completed";
  if (status === "pending") return "waiting";
  return "on_track";
}

function statusLineFor(erp: Erp, orderRef: string, check: string, status: string): string {
  if (status === "shipped" || status === "delivered" || status === "invoiced" || status === "closed" || status === "ready_to_ship") {
    const shipped = erp.shipments(orderRef).reduce((a, s) => a + (s.lines?.reduce((x, l) => x + (l.qty ?? 0), 0) ?? 0), 0);
    if (shipped > 0) {
      const order = erp.order(orderRef);
      const confirmed = order?.lines.reduce((a, l) => a + (l.qtyConfirmed ?? l.qtyOrdered ?? 0), 0) ?? 0;
      const remaining = Math.max(confirmed - shipped, 0);
      if (remaining > 0) return `${n(remaining)} units still to ship, shipped ${n(shipped)}`;
      return `Shipped all ${n(shipped)} units`;
    }
  }
  return check;
}

export function ordersInbox(erp: Erp, opts: { filter?: InboxFilter; q?: string } = {}): InboxRow[] {
  // One pass over open gates + audit — avoid orderWorkspace per row.
  const openByRef = new Set(
    erp
      .signoffs({ status: "pending", row: "order" })
      .filter((c) => !c.decidedAt && c.subjectRef)
      .map((c) => c.subjectRef as string),
  );
  const auditByRef = new Map<string, string[]>();
  for (const a of erp.auditLog()) {
    if (!a.subjectRef) continue;
    const list = auditByRef.get(a.subjectRef) ?? [];
    list.push(a.action);
    auditByRef.set(a.subjectRef, list);
  }

  const rows: InboxRow[] = [];
  for (const s of listOrders(erp)) {
    const order = erp.order(s.orderRef);
    let description = "No lines";
    if (order?.lines.length) {
      const first = order.lines[0];
      const name = erp.product({ gtin: first.gtin })?.name ?? first.gtin ?? "Product";
      description = `${name} · ${n(first.qtyOrdered ?? 0)} units${order.lines.length > 1 ? ` + ${order.lines.length - 1} more lines` : ""}`;
    } else if (s.qtyOrdered) {
      description = `${s.lineCount} lines · ${n(s.qtyOrdered)} units`;
    }
    const grokUsed = s.pill.tone === "grok" || !!(s.grokExplain && /Grokbot|\bGrok\b/i.test(s.grokExplain));
    if (!order) {
      const status: InboxStatus = s.caseStatus === "pending" || openByRef.has(s.orderRef) ? "attention" : "completed";
      rows.push({
        orderRef: s.orderRef,
        retailer: s.retailer === "–" ? "Retailer not read yet" : s.retailer,
        description,
        statusLine: s.check,
        deliveryDate: null,
        status,
        statusLabel: STATUS_LABEL[status],
        agents: ["Order"],
        hasWorkspace: false,
        grokUsed,
      });
      continue;
    }
    const status = inboxStatus(order.status, openByRef.has(s.orderRef) || s.caseStatus === "pending");
    rows.push({
      orderRef: s.orderRef,
      retailer: s.retailer === "–" ? (erp.retailer(order.buyerGln)?.name ?? order.buyerGln ?? "Unknown retailer") : s.retailer,
      description,
      statusLine: statusLineFor(erp, s.orderRef, s.check, order.status),
      deliveryDate: isoDate(order.deliveryDate),
      status,
      statusLabel: STATUS_LABEL[status],
      agents: agentsOf(auditByRef.get(s.orderRef) ?? []),
      hasWorkspace: true,
      grokUsed,
    });
  }
  const q = opts.q?.trim().toLowerCase();
  const f = opts.filter ?? "all";
  return rows
    .filter((r) =>
      f === "attention" ? r.status === "attention" : f === "progress" ? r.status === "on_track" || r.status === "waiting" : f === "completed" ? r.status === "completed" : true,
    )
    .filter((r) => !q || [r.orderRef, r.retailer, r.description, r.statusLine].some((x) => x.toLowerCase().includes(q)))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.orderRef.localeCompare(b.orderRef));
}
