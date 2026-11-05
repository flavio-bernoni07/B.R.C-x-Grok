"use client";

import type { ClaimRow } from "@agent/lib/dispute/views";
import { type Column, DataTable, Panel, Pill } from "@/components/kit";
import { GrokMark } from "@/components/kit/icons";
import { confidencePct, grokSays, outcomePill, retailerSays } from "./format";

const columns: Column<ClaimRow>[] = [
  {
    key: "claim",
    header: "Claim",
    main: true,
    cell: (r) => (
      <span className="flex flex-col leading-tight">
        <span>{r.claim_id}</span>
        <span className="font-normal text-[12px] text-ink-68">{[r.customer, r.order_ref].filter(Boolean).join(" · ") || "no order found"}</span>
      </span>
    ),
  },
  { key: "says", header: "Retailer says", cell: (r) => retailerSays(r) },
  {
    key: "grok",
    header: "Grok suggests",
    cell: (r) => (
      <span className="flex items-center gap-2">
        {r.grok && !r.grok.needs_sign_off && !r.outcome?.approved_by ? <GrokMark size={15} title="Settled by Grok, no person needed" /> : null}
        <span className={r.grok?.needs_sign_off ? "font-bold text-ink" : undefined}>{grokSays(r.grok)}</span>
      </span>
    ),
  },
  {
    key: "conf",
    header: "Grok confidence level",
    align: "right",
    cell: (r) =>
      r.grok ? (
        <b className={r.grok.lowest_confidence < 0.55 ? "font-bold text-st-pending-ink tabular-nums" : "font-bold text-ink tabular-nums"}>{confidencePct(r.grok.lowest_confidence)}</b>
      ) : (
        "–"
      ),
  },
  {
    key: "outcome",
    header: "Outcome",
    align: "right",
    cell: (r) => {
      const p = outcomePill(r);
      return <Pill tone={p.tone}>{p.label}</Pill>;
    },
  },
];

export function ClaimsTable({
  rows,
  selected,
  onSelect,
}: {
  readonly rows: ClaimRow[];
  readonly selected?: string;
  readonly onSelect?: (row: ClaimRow) => void;
}) {
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.claim_id}
      selectedKey={selected}
      onRowClick={onSelect}
      empty="No claims yet. Paste a claim email to start."
    />
  );
}

/** Chat card for `dispute_list`. */
export function ClaimsTableCard({ output }: { readonly output: unknown }) {
  const rows = (output as { claims?: ClaimRow[] })?.claims ?? [];
  const waiting = rows.filter((r) => r.status === "awaiting_sign_off").length;
  return (
    <Panel title="Disputes" aside={`${rows.length} ${rows.length === 1 ? "claim" : "claims"}${waiting ? `, ${waiting} waiting for a person` : ""}`}>
      <ClaimsTable rows={rows} />
    </Panel>
  );
}
