import { Suspense } from "react";
import { OrdersView } from "@/components/order";

export const dynamic = "force-dynamic";

/** Orders is the new table. Rows load from /api/orders/inbox; a ref opens the panel. */
export default function OrdersPage() {
  return (
    <Suspense fallback={<div className="h-48 animate-pulse rounded-[12px] bg-hh-honeydew" />}>
      <OrdersView />
    </Suspense>
  );
}
