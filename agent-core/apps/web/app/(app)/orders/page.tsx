import { Suspense } from "react";
import { getReadyErp } from "@agent/lib/db/app";
import { ordersInbox } from "@agent/lib/order/inbox";
import { OrdersView } from "@/components/order";

export const dynamic = "force-dynamic";

export default async function OrdersPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await searchParams) ?? {};
  const sim = typeof sp.sim === "string" ? sp.sim : undefined;
  const total = typeof sp.total === "string" ? sp.total : undefined;
  const waiting = typeof sp.waiting === "string" ? sp.waiting : undefined;
  const simBanner =
    sim === "1" && total
      ? `Desk cleared. Loaded ${total} orders · ${waiting ?? "?"} waiting in Actions.`
      : undefined;

  const erp = await getReadyErp();
  const initialRows = ordersInbox(erp, { filter: "all", q: "" });
  return (
    <Suspense fallback={<div className="h-48 animate-pulse rounded-[12px] bg-hh-honeydew" />}>
      <OrdersView initialRows={initialRows} simBanner={simBanner} />
    </Suspense>
  );
}
