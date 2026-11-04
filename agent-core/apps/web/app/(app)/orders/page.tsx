import { Suspense } from "react";
import { OrdersView } from "@/components/order";

export default function OrdersPage() {
  return (
    <Suspense fallback={<div className="h-48 animate-pulse rounded-[12px] bg-hh-honeydew" />}>
      <OrdersView />
    </Suspense>
  );
}
