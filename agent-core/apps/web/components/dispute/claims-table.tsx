"use client";

import type { ClaimRow } from "@agent/lib/dispute/views";
import { type Column, DataTable, Panel, Pill } from "@/components/kit";
import { grokSays, outcomePill, retailerSays } from "./format";

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
    header: "Grok",
    cell: (r) => <span className={r.grok?.needs_sign_off ? "text-st-attention-ink" : undefined}>{grokSays(r.grok)}</span>,
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
