"use client";

import type { BenchResult } from "@agent/lib/bench/score";
import type { Proposal } from "@agent/lib/shipping/cases";
import type { openCases, ReconcileView, ShippingFile, ShippingListRow } from "@agent/lib/shipping/service";
import { Panel, Pill } from "@/components/kit";
import { actionLabel, caseStatusPill, caseTypeLabel } from "./format";
import { BenchSummary, BenchTable, ProposalLine, ReconcileBody, ShippingSteps, ShippingTable } from "./shipping-parts";

type OpenCase = ReturnType<typeof openCases>[number];

/** shipping_list: the invoices table, threeway beside ours. */
export function ShippingListCard({ output }: { readonly output: unknown }) {
  const rows = (output as { orders?: ShippingListRow[] })?.orders ?? [];
  return (
    <Panel title="Shipments and invoices" aside="Mini ERP · reconciled by code">
      <ShippingTable rows={rows} />
    </Panel>
  );
}

/** shipping_get: one order's shipping file, step by step. */
export function ShipmentCard({ output }: { readonly output: unknown }) {
  const file = output as ShippingFile & { error?: string };
  const ref = String(file?.order?.order_ref ?? "");
  if (!file?.order) return <Panel title="Shipping file">{file?.error ?? "No such order."}</Panel>;
  const status = String(file.order.status ?? "");
  const tone = status === "invoiced" ? "ok" : status === "shipped" ? "wait" : "quiet";
  return (
    <Panel title={`${ref} · ${file.customer ?? ""}`} aside={<Pill tone={tone}>{status.replace(/_/g, " ")}</Pill>}>
      <ShippingSteps file={file} />
    </Panel>
  );
}

/** shipping_reconcile: threeway beside ours, causes with € share. */
export function ReconcileCard({ output }: { readonly output: unknown }) {
  const view = output as ReconcileView;
  if (!view?.report) return null;
  return (
    <Panel title={`Reconciliation · ${view.order_ref}`} aside="order vs DESADV vs invoice">
      <ReconcileBody view={view} />
    </Panel>
  );
}

/** shipping_exception_cases and shipping_propose_resolution. */
export function ExceptionCaseCard({ output }: { readonly output: unknown }) {
  const o = output as { cases?: OpenCase[]; case_id?: string; status?: string; role?: string; proposal?: Proposal | null; note?: string; error?: string };
  if (o?.cases) {
    return (
      <Panel title="Shipping exception cases" aside={`${o.cases.length} open`}>
        {o.cases.length ? (
          <ul className="space-y-3">
            {o.cases.map((c) => {
              const pill = caseStatusPill(c.status, c.resolution);
              return (
                <li key={c.case_id} className="space-y-1 border-hairline border-t pt-3 first:border-t-0 first:pt-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-[14px]">
                      {caseTypeLabel(c.type)} <span className="font-normal text-ink-68">· {c.case_id} · {c.order_ref}</span>
                    </span>
                    <Pill tone={pill.tone}>{pill.label}</Pill>
                  </div>
                  <p className="text-[13px] text-ink-78">{c.explanation}</p>
                  <p className="text-[12px] text-ink-68">
                    {c.role.replace(/_/g, " ")} approves · may propose {c.allowed_actions.map(actionLabel).join(", ")}
                  </p>
                  {c.proposals.map((p) => (
                    <ProposalLine key={p.proposal_id} p={p} />
                  ))}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[13px] text-ink-68">No open case.</p>
        )}
      </Panel>
    );
  }
  if (o?.error) return <Panel title="Exception case">{o.error}</Panel>;
  const pill = caseStatusPill(o?.status ?? "open");
  return (
    <Panel title={`Proposal for ${o?.case_id ?? ""}`} aside={<Pill tone={pill.tone}>{pill.label}</Pill>}>
      <div className="space-y-2">
        {o?.proposal ? <ProposalLine p={o.proposal} /> : null}
        {o?.note ? <p className="text-[13px] text-ink-78">{o.note}</p> : null}
      </div>
    </Panel>
  );
}

/** bench_score: 21/22 against 14/22 and 10/22. */
export function BenchCard({ output }: { readonly output: unknown }) {
  const res = output as BenchResult;
  if (!res?.totals) return null;
  return (
    <Panel title="Reconciliation against threeway" aside={`${res.n} labelled cases`}>
      <div className="space-y-4">
        <BenchSummary res={res} />
        <BenchTable res={res} />
      </div>
    </Panel>
  );
}

