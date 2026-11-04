/**
 * The Orders inbox: every order read like an email row. Status, status line and agent badges are
 * written by code from the order workspace (trace chain, shipping file, audit log). Read-only.
 */
import type { Erp } from "../core/erp";
import { listOrders } from "./views";
import { type InboxStatus, orderWorkspace, STATUS_LABEL } from "./workspace";

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
};

const ORDER: Record<InboxStatus, number> = { attention: 0, on_track: 1, waiting: 2, completed: 3 };

const n = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

export function ordersInbox(erp: Erp, opts: { filter?: InboxFilter; q?: string } = {}): InboxRow[] {
  const rows: InboxRow[] = [];
  for (const s of listOrders(erp)) {
    const order = erp.order(s.orderRef);
    const ws = order ? orderWorkspace(erp, s.orderRef) : null;
    let description = "No lines";
    if (order?.lines.length) {
      const first = order.lines[0];
      const name = erp.product({ gtin: first.gtin })?.name ?? first.gtin ?? "Product";
      description = `${name} · ${n(first.qtyOrdered ?? 0)} units${order.lines.length > 1 ? ` + ${order.lines.length - 1} more lines` : ""}`;
    } else if (s.qtyOrdered) {
      description = `${s.lineCount} lines · ${n(s.qtyOrdered)} units`;
    }
    if (ws) {
      rows.push({
        orderRef: s.orderRef,
        retailer: ws.retailer,
        description,
        statusLine: ws.statusText,
        deliveryDate: ws.deliveryDate,
        status: ws.status,
        statusLabel: ws.statusLabel,
        agents: ws.agents,
        hasWorkspace: true,
      });
    } else {
      const status: InboxStatus = s.caseStatus === "pending" ? "attention" : "completed";
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
      });
    }
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
