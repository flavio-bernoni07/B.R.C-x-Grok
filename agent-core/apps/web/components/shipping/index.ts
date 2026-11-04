import type { ReactNode } from "react";
import { BenchCard, ExceptionCaseCard, ReconcileCard, ShipmentCard, ShippingListCard } from "./cards";

export { BenchCard, ExceptionCaseCard, ReconcileCard, ShipmentCard, ShippingListCard } from "./cards";
export { ShippingView } from "./shipping-view";

/** Chat cards for the Shipping and benchmark tools (tool name → component). */
export const cards: Record<string, (props: { output: unknown }) => ReactNode> = {
  shipping_list: ShippingListCard,
  shipping_get: ShipmentCard,
  shipping_reconcile: ReconcileCard,
  shipping_exception_cases: ExceptionCaseCard,
  shipping_propose_resolution: ExceptionCaseCard,
  bench_score: BenchCard,
};
