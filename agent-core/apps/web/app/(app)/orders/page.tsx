import { Suspense } from "react";
import { getReadyErp } from "@agent/lib/db/app";
import { type InboxFilter, ordersInbox } from "@agent/lib/order/inbox";
import { orderWorkspace } from "@agent/lib/order/workspace";
import { OrdersView } from "@/components/order";

export const dynamic = "force-dynamic";

const FILTERS = new Set<InboxFilter>(["all", "attention", "progress", "completed"]);

export default async function OrdersPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await searchParams) ?? {};
  const sim = typeof sp.sim === "string" ? sp.sim : undefined;
  const total = typeof sp.total === "string" ? sp.total : undefined;
  const waiting = typeof sp.waiting === "string" ? sp.waiting : undefined;
  const ref = typeof sp.ref === "string" ? sp.ref : undefined;
  const filterRaw = typeof sp.filter === "string" ? sp.filter : "all";
  const filter: InboxFilter = FILTERS.has(filterRaw as InboxFilter) ? (filterRaw as InboxFilter) : "all";
  const q = typeof sp.q === "string" ? sp.q : "";
  const simBanner =
    sim === "1" && total
      ? `Desk cleared. Loaded ${total} orders · ${waiting ?? "?"} waiting in Actions.`
      : undefined;

  const erp = await getReadyErp();
  const initialRows = ordersInbox(erp, { filter, q });
  const initialWorkspace = ref ? orderWorkspace(erp, ref) : null;
  return (
    <Suspense fallback={<div className="h-48 animate-pulse rounded-[12px] bg-hh-honeydew" />}>
      <OrdersView
        initialRows={initialRows}
        simBanner={simBanner}
        initialFilter={filter}
        initialQ={q}
        initialWorkspace={initialWorkspace ?? undefined}
        initialWorkspaceMissing={!!ref && !initialWorkspace}
      />
    </Suspense>
  );
}
