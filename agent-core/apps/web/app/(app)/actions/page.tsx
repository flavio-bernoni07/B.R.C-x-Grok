import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getReadyErp } from "@agent/lib/db/app";
import { deskTabForSignoff, type DeskTab as CoreDeskTab } from "@agent/lib/core/actions-desk";
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
  const tabRaw = typeof sp.tab === "string" ? sp.tab : undefined;
  let tab: DeskTab = tabRaw && TABS.has(tabRaw as DeskTab) ? (tabRaw as DeskTab) : "board";
  const caseId = typeof sp.case === "string" ? sp.case : undefined;
  const openMail = sp.mail === "1" || sp.mail === "true";
  const formError = typeof sp.err === "string" ? sp.err : undefined;
  const simBanner =
    sim === "1" && total
      ? `Simulation loaded ${total} orders · ${waiting ?? "?"} waiting on this desk (Send-off / Price / Quantity).`
      : undefined;

  const erp = await getReadyErp();
  const initialCases = erp.signoffs().slice().reverse();
  const initialBoard = orderBoard(erp);

  // Deep links often omit ?tab= (workspace / Home / search). Canonicalize so SignoffCard SSR-mounts.
  if (caseId) {
    const c = initialCases.find((x) => x.caseId === caseId) ?? erp.signoff(caseId) ?? undefined;
    if (c) {
      const resolved = deskTabForSignoff(c) as Exclude<CoreDeskTab, "board">;
      if (!tabRaw || tabRaw === "board" || tab !== resolved) {
        const q = new URLSearchParams();
        q.set("tab", resolved);
        q.set("case", caseId);
        if (openMail) q.set("mail", "1");
        if (formError) q.set("err", formError);
        if (sim) q.set("sim", sim);
        if (total) q.set("total", total);
        if (waiting) q.set("waiting", waiting);
        // Full redirect when tab was missing/wrong — reliable without client JS.
        if (!tabRaw || tabRaw === "board") redirect(`/actions?${q.toString()}`);
        tab = resolved as DeskTab;
      }
    }
  }

  return (
    <Suspense fallback={<div className="h-48 animate-pulse rounded-[12px] bg-hh-honeydew" />}>
      <SignoffView
        initialCases={initialCases}
        initialBoard={initialBoard}
        simBanner={simBanner}
        initialTab={tab}
        initialCaseId={caseId}
        openMail={openMail}
        formError={formError}
      />
    </Suspense>
  );
}
