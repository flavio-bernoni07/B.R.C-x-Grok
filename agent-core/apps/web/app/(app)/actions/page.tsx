import { Suspense } from "react";
import { getReadyErp } from "@agent/lib/db/app";
import { orderBoard } from "@agent/lib/order/board";
import { SignoffView, type DeskTab } from "@/components/core/signoff-view";

export const dynamic = "force-dynamic";

const TABS = new Set<DeskTab>(["board", "sendoff", "price", "quantity", "pending", "other", "decided"]);

/** Actions = Sign-off desk with Board / Send-off / Price / Quantity / Pending / Decided. */
export default async function ActionsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await searchParams) ?? {};
  const sim = typeof sp.sim === "string" ? sp.sim : undefined;
  const total = typeof sp.total === "string" ? sp.total : undefined;
  const waiting = typeof sp.waiting === "string" ? sp.waiting : undefined;
  const tabRaw = typeof sp.tab === "string" ? sp.tab : "board";
  const tab: DeskTab = TABS.has(tabRaw as DeskTab) ? (tabRaw as DeskTab) : "board";
  const caseId = typeof sp.case === "string" ? sp.case : undefined;
  const simBanner =
    sim === "1" && total
      ? `Simulation loaded ${total} orders · ${waiting ?? "?"} waiting on this desk (Send-off / Price / Quantity).`
      : undefined;

  const erp = await getReadyErp();
  const initialCases = erp.signoffs().slice().reverse();
  const initialBoard = orderBoard(erp);
  return (
    <Suspense fallback={<div className="h-48 animate-pulse rounded-[12px] bg-hh-honeydew" />}>
      <SignoffView
        initialCases={initialCases}
        initialBoard={initialBoard}
        simBanner={simBanner}
        initialTab={tab}
        initialCaseId={caseId}
      />
    </Suspense>
  );
}
