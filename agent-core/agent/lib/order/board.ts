/**
 * Order board: one row per order with a desk-friendly pipeline stage
 * (sign-off gates → assigned → WMS → preparing → shipped → done).
 */
import type { Erp } from "../core/erp";
import { listOrders } from "./views";

export type OrderBoardStage =
  | "signoff_edi"
  | "signoff_price"
  | "signoff_qty"
  | "signoff_sendoff"
  | "pending"
  | "assigned"
  | "ready_wms"
  | "preparing"
  | "shipped"
  | "done"
  | "rejected";

export const BOARD_STAGE_LABEL: Record<OrderBoardStage, string> = {
  signoff_edi: "Sign-off · EDI",
  signoff_price: "Sign-off · Price",
  signoff_qty: "Sign-off · Quantity",
  signoff_sendoff: "Sign-off · Send-off",
  pending: "Pending",
  assigned: "Assigned to shipping",
  ready_wms: "Sent to WMS",
  preparing: "Preparing",
  shipped: "Shipped",
  done: "Done",
  rejected: "Rejected",
};

export type OrderBoardRow = {
  orderRef: string;
  retailer: string;
  stage: OrderBoardStage;
  stageLabel: string;
  status: string;
  caseId: string | null;
  detail: string;
  qtyOrdered: number;
  qtyConfirmed: number | null;
};

function stageFor(erp: Erp, orderRef: string, status: string, caseKind: string | null): OrderBoardStage {
  if (status === "rejected") return "rejected";
  if (status === "invoiced" || status === "delivered" || status === "closed") return "done";
  if (status === "shipped") return "shipped";
  if (status === "ready_to_ship") {
    const ship = erp.shipments(orderRef);
    const notes = erp.order(orderRef)?.notes as { truck_id?: string } | null;
    if (ship.length || notes?.truck_id) return "preparing";
    return "ready_wms";
  }
  if (status === "confirmed") return "assigned";
  if (status === "pending") return "pending";
  if (status === "awaiting_confirmation" || caseKind === "confirm") return "signoff_sendoff";
  if (status === "pending_price" || status === "price_fix" || caseKind === "price_fix") return "signoff_price";
  if (
    status === "pending_qty" ||
    status === "qty_choice" ||
    status === "stock_short" ||
    caseKind === "qty_choice" ||
    caseKind === "stock_short"
  ) {
    return "signoff_qty";
  }
  if (status === "pending_manual_edi" || status === "manual_edi" || caseKind === "manual_edi") return "signoff_edi";
  return "signoff_sendoff";
}

/** Every order on the desk with its pipeline stage. */
export function orderBoard(erp: Erp): OrderBoardRow[] {
  return listOrders(erp)
    .map((s) => {
      const stage = stageFor(erp, s.orderRef, s.status, s.caseId ? erp.signoff(s.caseId)?.kind ?? null : null);
      return {
        orderRef: s.orderRef,
        retailer: s.retailer,
        stage,
        stageLabel: BOARD_STAGE_LABEL[stage],
        status: s.status,
        caseId: s.caseId,
        detail: s.check,
        qtyOrdered: s.qtyOrdered,
        qtyConfirmed: s.qtyConfirmed,
      };
    })
    .sort((a, b) => a.stageLabel.localeCompare(b.stageLabel) || a.orderRef.localeCompare(b.orderRef));
}
