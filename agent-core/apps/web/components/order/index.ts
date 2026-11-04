import type { ReactNode } from "react";
import { AvailabilityCard, OrderCard, OrdersTableCard } from "./order-card";

export { AvailabilityCard, OrderCard, OrdersTableCard } from "./order-card";
export { OrdersView } from "./orders-view";

/** Chat cards for the Order tools (tool name -> component). */
export const cards: Record<string, (props: { output: unknown }) => ReactNode> = {
  order_list: OrdersTableCard,
  order_get: OrderCard,
  order_receive: OrderCard,
  order_availability: AvailabilityCard,
};
