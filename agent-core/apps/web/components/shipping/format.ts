import type { Answer, ShippingListRow } from "@agent/lib/shipping/service";
import { eur, type PillTone, qty } from "@/components/kit";

const CAUSE_LABEL: Record<string, string> = {
  short_delivery: "Short delivery",
  over_delivery: "Over delivery",
  overbilled: "Overbilled",
  underbilled: "Underbilled",
  price_difference: "Price difference",
  orphan_invoice: "Invoice with no order",
  orphan_receipt: "Receipt with no order",
  not_shipped: "Not shipped",
  uom_unknown: "Units unclear",
  timing: "Timing",
};

const BILLING = new Set(["overbilled", "underbilled", "price_difference", "orphan_invoice", "uom_unknown"]);

export const causeLabel = (c: string) => CAUSE_LABEL[c] ?? c.replace(/_/g, " ");

/** Billing errors need a person (attention); fulfilment gaps are followed up (quiet). */
export const causeTone = (c: string): PillTone => (BILLING.has(c) ? "attention" : "quiet");

/** threeway's answer in words: "matched" or its causes. */
export const answerText = (a: Answer) => (a.attention ? (a.causes.length ? a.causes.map(causeLabel).join(", ") : "act") : "matched");

const CASE_TYPE: Record<string, string> = {
  TRUCK_CAPACITY_EXCEEDED: "Truck full",
  TRUCK_WEIGHT_EXCEEDED: "Truck too heavy",
  DELIVERY_WINDOW: "Delivery window",
  DESTINATION_MISMATCH: "Wrong destination",
  TRUCK_UNAVAILABLE: "Truck unavailable",
  NO_TRUCK: "No truck",
  PLAN_MISSING_PRODUCT_DATA: "Product data missing",
  WRONG_TRUCK: "Wrong truck",
  DUPLICATE_SCAN: "Duplicate scan",
  MISSING_PALLET: "Missing pallet",
  WRONG_PRODUCT: "Wrong product",
  WRONG_BATCH: "Wrong batch",
  BAD_QUANTITY: "Bad quantity",
  UNKNOWN_PALLET: "Unknown pallet",
  QUALITY_HOLD: "Quality hold",
  SHORT_SHIPMENT: "Short shipment",
  INVOICE_QUANTITY: "Invoice quantity",
  INVOICE_PRICE: "Invoice price",
  RECEIVING_GAP: "Receiving gap",
  ORDER_NOT_READY: "Order not ready",
};

export const caseTypeLabel = (t: string) => CASE_TYPE[t] ?? t.replace(/_/g, " ").toLowerCase();

/** RESCAN_PALLET → "Rescan pallet". */
export const actionLabel = (a: string) => {
  const s = a.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function caseStatusPill(status: string, resolution?: string | null): { tone: PillTone; label: string } {
  if (status === "executed") return resolution === "resolved" ? { tone: "ok", label: "Resolved" } : { tone: "attention", label: "Done, unresolved" };
  if (status === "awaiting_approval") return { tone: "attention", label: "Needs approval" };
  if (status === "approved") return { tone: "wait", label: "Approved" };
  if (status === "clarification_requested") return { tone: "attention", label: "Clarify" };
  return { tone: "attention", label: "Open" };
}

/** The invoice and shipment state of a row, as one pill. */
export function rowPill(r: ShippingListRow): { tone: PillTone; label: string } {
  if (r.pending_signoffs > 0) return { tone: "attention", label: "Needs a person" };
  if (r.open_cases > 0) return { tone: "attention", label: "Open case" };
  if (r.invoice_status === "sent") return { tone: "ok", label: "Invoice sent" };
  if (r.invoice_status === "draft") return { tone: "wait", label: "Invoice draft" };
  if (r.invoice_status) return { tone: "wait", label: `Invoice ${r.invoice_status}` };
  if (r.order_status === "shipped") return { tone: "wait", label: "Shipped" };
  return { tone: "wait", label: "Ready to ship" };
}

/** "10,800 of 12,000 shipped, 10,800 invoiced" from the reconcile lines. */
export function whatHappened(r: ShippingListRow): string {
  const rec = r.reconcile;
  if (!r.shipments) return r.order_status === "ready_to_ship" ? "confirmed, waiting for a truck" : r.order_status;
  if (!rec) return r.short ? "shipped short, not invoiced yet" : "shipped, not invoiced yet";
  return rec.report.lines
    .map((l) => {
      const short = l.received < l.ordered ? `${qty(l.received)} of ${qty(l.ordered)}` : qty(l.received);
      const billed = l.invoiced === l.received ? "invoiced" : `${qty(l.invoiced)} invoiced`;
      const price = l.causes.some((c) => c.code === "price_difference") ? ` at ${eur(l.invoice_price)} not ${eur(l.po_price)}` : "";
      return `${l.item_code}: ${short} shipped, ${billed}${price}`;
    })
    .join("; ");
}

export const moneyOrDash = (v: number | null | undefined) => (v == null ? "–" : eur(v));
export { qty };
