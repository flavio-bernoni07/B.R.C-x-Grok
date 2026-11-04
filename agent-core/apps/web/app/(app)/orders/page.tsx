import { Suspense } from "react";
import { getReadyErp } from "@agent/lib/db/app";
import { ordersInbox } from "@agent/lib/order/inbox";
import { OrdersView } from "@/components/order";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const erp = await getReadyErp();
  const initialRows = ordersInbox(erp, { filter: "all", q: "" });
  return (
    <Suspense fallback={<div className="h-48 animate-pulse rounded-[12px] bg-hh-honeydew" />}>
      <OrdersView initialRows={initialRows} />
    </Suspense>
  );
}
