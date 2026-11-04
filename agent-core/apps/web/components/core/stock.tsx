"use client";

/** Stock per product and its batches (core/stock): the number the Order row promises from. */
import type { StockStatus } from "@agent/lib/core/overview";
import { useState } from "react";
import { DataTable, Panel, Pill, type PillTone, qty } from "@/components/kit";

const BATCH_TONE: Record<string, PillTone> = { released: "ok", planned: "wait", hold: "attention", cancelled: "quiet" };
const BATCH_LABEL: Record<string, string> = { released: "Released", planned: "Planned", hold: "Quality hold", cancelled: "Line stopped" };

export function AtpTable({ stock }: { readonly stock: StockStatus }) {
  return (
    <DataTable
      rows={stock.products}
      rowKey={(p) => p.gtin}
      columns={[
        { key: "name", header: "Product", main: true, cell: (p) => p.name },
        { key: "released", header: "Released", align: "right", cell: (p) => qty(p.released) },
        { key: "planned", header: "Planned", align: "right", cell: (p) => qty(p.planned) },
        { key: "held", header: "On hold", align: "right", cell: (p) => (p.held ? <span className="font-bold text-st-attention-ink">{qty(p.held)}</span> : "–") },
        { key: "committed", header: "Committed", align: "right", cell: (p) => qty(p.committed) },
        { key: "atp", header: "Can promise", align: "right", cell: (p) => <b className="text-ink">{qty(p.atp)}</b> },
      ]}
    />
  );
}

export function BatchTable({ stock }: { readonly stock: StockStatus }) {
  const names = Object.fromEntries(stock.products.map((p) => [p.gtin, p.name]));
  return (
    <DataTable
      rows={stock.batches}
      rowKey={(b) => b.batch}
      columns={[
        { key: "batch", header: "Batch", main: true, cell: (b) => b.batch },
        { key: "product", header: "Product", cell: (b) => names[b.gtin] ?? b.gtin },
        { key: "qty", header: "Quantity", align: "right", cell: (b) => qty(b.qty) },
        { key: "from", header: "Ready", cell: (b) => b.availableFrom ?? "now" },
        { key: "status", header: "Status", cell: (b) => <Pill tone={BATCH_TONE[b.status] ?? "quiet"}>{BATCH_LABEL[b.status] ?? b.status}</Pill> },
        { key: "src", header: "Source", cell: (b) => <span className="text-[12px] text-ink-68">{b.sourceDoc}</span> },
      ]}
    />
  );
}

/** Chat card for `stock_status`. */
export function StockCard({ output }: { readonly output: unknown }) {
  const stock = output as StockStatus;
  const [showBatches, setShowBatches] = useState(false);
  return (
    <Panel
      title="Stock we can promise"
      aside={
        <button type="button" className="underline underline-offset-2" onClick={() => setShowBatches(!showBatches)}>
          {showBatches ? "Hide batches" : `${stock.batches.length} batches`}
        </button>
      }
    >
      <AtpTable stock={stock} />
      {showBatches ? (
        <div className="mt-4">
          <BatchTable stock={stock} />
        </div>
      ) : null}
      <p className="mt-3 text-[12px] text-ink-68">
        Released + planned ready by the date − confirmed not shipped. Batches on quality hold never count. Source: production events in the Mini ERP.
      </p>
    </Panel>
  );
}
