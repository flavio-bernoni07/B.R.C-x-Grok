"use client";

import type { InventoryProduct } from "@agent/lib/core/inventory";
import type { ProjectionRow } from "@agent/lib/forecast/demand";
import type { PaddyPlan } from "@agent/lib/purchasing/paddy";
import type { PriceForecast } from "@agent/lib/rice";
import { useEffect, useState } from "react";
import { DataTable, Panel, Pill, qty, SourceTag } from "@/components/kit";
import { ForecastCard } from "@/components/rice/forecast-card";
import { PaddyToBuy } from "./paddy";

type Projection = {
  gtin: string;
  itemCode: string;
  forecast: { week: string; qty: number }[];
  rows: ProjectionRow[];
  suggestion: { short_from: string; make_before: string; qty: number; covers_weeks: number; why: string } | null;
};
export type InventoryResponse = { asOf: string; products: InventoryProduct[]; forecast: { label: string; start: string; projections: Projection[] } };

export function InventoryTable({ products }: { readonly products: InventoryProduct[] }) {
  const [open, setOpen] = useState<string>();
  const current = products.find((p) => p.gtin === open);
  return (
    <>
      <DataTable
        rows={products}
        rowKey={(p) => p.gtin}
        selectedKey={open}
        onRowClick={(p) => setOpen((o) => (o === p.gtin ? undefined : p.gtin))}
        columns={[
          { key: "p", header: "Product", main: true, cell: (p) => p.itemCode },
          { key: "ph", header: "Physical on hand", align: "right", cell: (p) => qty(p.physical) },
          { key: "h", header: "Quality held", align: "right", cell: (p) => (p.held ? <Pill tone="attention">{qty(p.held)}</Pill> : "0") },
          { key: "r", header: "Reserved", align: "right", cell: (p) => qty(p.reserved) },
          { key: "a", header: "Available to promise", align: "right", cell: (p) => <b>{qty(p.atp)}</b> },
          { key: "d", header: "Dispatched", align: "right", cell: (p) => qty(p.dispatched) },
          { key: "t", header: "In transit", align: "right", cell: (p) => qty(p.inTransit) },
          { key: "pl", header: "Planned production", align: "right", cell: (p) => qty(p.planned) },
        ]}
      />
      {current ? (
        <div className="mt-3 rounded-[10px] bg-hh-honeydew/60 px-3 py-2">
          <p className="mb-1 font-bold text-[13px]">{current.name}: batches</p>
          <DataTable
            rows={current.batches}
            rowKey={(b) => b.batch}
            columns={[
              { key: "b", header: "Batch", main: true, cell: (b) => b.batch },
              { key: "s", header: "Status", cell: (b) => <Pill tone={b.status === "hold" ? "attention" : b.status === "released" ? "ok" : "wait"}>{b.status}</Pill> },
              { key: "q", header: "Quantity", align: "right", cell: (b) => qty(b.qty) },
              { key: "f", header: "Available from", cell: (b) => b.availableFrom ?? "now" },
              { key: "src", header: "Source", cell: (b) => (b.source ? <SourceTag>{b.source}</SourceTag> : "–") },
            ]}
          />
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-ink-68">Physical = released + quality held. Reserved = confirmed orders not shipped. Held stock never counts as available. Click a product for its batches.</p>
      )}
    </>
  );
}

function ForecastTable({ projections, label }: { readonly projections: Projection[]; readonly label: string }) {
  return (
    <Panel title="Demand forecast and projected stock" aside={<Pill tone="quiet">Estimate</Pill>}>
      <p className="mb-3 text-[12px] text-ink-68">
        {label} Confirmed orders count in the first week, expected orders are the forecast; the two are kept apart. A shortage proposes a review, never a production change.
      </p>
      <div className="space-y-4">
        {projections.map((p) => (
          <div key={p.gtin}>
            <div className="mb-1 flex flex-wrap items-baseline gap-2">
              <b className="text-[14px]">{p.itemCode}</b>
              {p.suggestion ? (
                <Pill tone="attention">
                  Short from {p.suggestion.short_from}: review production ({qty(p.suggestion.qty)} units suggested) or evaluate a partial delivery
                </Pill>
              ) : (
                <Pill tone="ok">No shortage projected</Pill>
              )}
            </div>
            <DataTable
              rows={p.rows}
              rowKey={(r) => r.week}
              columns={[
                { key: "w", header: "Week", main: true, cell: (r) => r.week },
                { key: "o", header: "Opening", align: "right", cell: (r) => qty(r.opening) },
                { key: "pr", header: "Planned production", align: "right", cell: (r) => qty(r.production) },
                { key: "c", header: "Confirmed orders", align: "right", cell: (r) => qty(r.confirmed_orders) },
                { key: "e", header: "Expected orders (estimate)", align: "right", cell: (r) => qty(r.expected_orders) },
                { key: "cl", header: "Projected closing", align: "right", cell: (r) => (r.closing < 0 ? <b className="text-st-attention-ink">{qty(r.closing)}</b> : qty(r.closing)) },
              ]}
            />
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function InventoryTab() {
  const [inv, setInv] = useState<InventoryResponse | null>(null);
  const [paddy, setPaddy] = useState<PaddyPlan | null | "failed">(null);
  const [variety, setVariety] = useState("Carnaroli");
  const [price, setPrice] = useState<PriceForecast | null | "failed">(null);
  useEffect(() => {
    fetch("/api/inventory").then((r) => r.json()).then(setInv).catch(() => {});
    fetch("/api/purchasing")
      .then((r) => r.json())
      .then(setPaddy)
      .catch(() => setPaddy("failed"));
  }, []);
  useEffect(() => {
    let live = true;
    setPrice(null);
    fetch(`/api/rice/forecast?variety=${encodeURIComponent(variety)}&horizon=8`)
      .then((r) => r.json())
      .then((d) => live && setPrice(d.error ? "failed" : d))
      .catch(() => live && setPrice("failed"));
    return () => {
      live = false;
    };
  }, [variety]);
  return (
    <div className="space-y-5">
      <Panel title="Stock by product" aside={inv ? `from the Mini ERP batches and shipments` : undefined}>
        {inv ? <InventoryTable products={inv.products} /> : <div className="h-40 animate-pulse rounded-[12px] bg-hh-honeydew" />}
      </Panel>
      {inv ? <ForecastTable projections={inv.forecast.projections} label={inv.forecast.label} /> : null}
      {paddy === "failed" ? (
        <Panel title="Paddy to buy">
          <p className="text-[13px] text-ink-68">The purchasing plan could not be loaded. Please reload the page.</p>
        </Panel>
      ) : paddy ? (
        <PaddyToBuy plan={paddy} interactive />
      ) : (
        <div className="h-40 animate-pulse rounded-[14px] bg-hh-honeydew" />
      )}
      {price === "failed" ? (
        <Panel title="Paddy prices">
          <p className="text-[13px] text-ink-68">The price forecaster did not answer, so the price chart is not shown.</p>
        </Panel>
      ) : price ? (
        <ForecastCard
          forecast={price}
          picker={
            <select aria-label="Paddy variety" className="rounded-md border bg-background px-2 py-1 font-medium text-sm" value={variety} onChange={(e) => setVariety(e.target.value)}>
              {["Carnaroli", "Arborio"].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          }
        />
      ) : (
        <div className="h-80 animate-pulse rounded-[14px] bg-hh-honeydew" />
      )}
    </div>
  );
}
