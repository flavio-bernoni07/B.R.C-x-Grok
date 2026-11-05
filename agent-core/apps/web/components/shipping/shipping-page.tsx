"use client";

/**
 * Shipping, three views behind the toolbar switch:
 * - Routes: Grok's routes for the next dispatch day on a map, what they save, and the trucks.
 *   Code plans the trucks (routes.ts), Grok briefs the transport planner, who approves in Sign-off.
 * - Loading (view=dock): each pallet scanned onto its truck; code says whose pallet it is, closing a truck flags what is missing.
 * - Invoices: each invoice against what shipped, with threeway's answer beside ours.
 */
import type { BenchResult } from "@agent/lib/bench/score";
import type { Signoff } from "@agent/lib/core/erp";
import type { DockTruck, ScanResult } from "@agent/lib/shipping/dock";
import type { DispatchPlan } from "@agent/lib/shipping/routes";
import type { ShippingListRow } from "@agent/lib/shipping/service";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn, Card, DataTable, GLASS, Kpi, Meter, PageHeader, Pill, Segmented, eur, qty } from "@/components/kit";
import { announceChange, Page } from "@/components/shell/app-shell";
import { cn } from "@/lib/utils";
import { RouteMap, TRUCK_COLORS, TruckGlyph } from "./route-map";
import { ShippingTable } from "./shipping-parts";
import { SectionChat } from "@/components/shell/section-chat";

type View = "routes" | "dock" | "invoices";
type RoutesData = { ship_date: string; ready: string[]; plan_case: Signoff | null; preview: DispatchPlan | null; error?: string };

const n0 = (v: number) => Math.round(v).toLocaleString("en-GB");
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Where Grok's route beats the planner's way (orders consolidated by warehouse, one truck per
 * warehouse): each truck that serves more than one warehouse, how many of the planner's trucks it
 * replaces and the road km saved (those trucks' round trips, from plan.baseline, minus this loop).
 */
function shared(plan: DispatchPlan) {
  return plan.routes
    .map((r, i) => {
      const names = [...new Set(r.stops.map((s) => s.retailer ?? s.point))];
      const before = plan.baseline.trips.filter((t) => (t.orders ?? [t.order_ref]).some((o) => r.orders.includes(o)));
      return {
        truck: r.truck_id,
        color: TRUCK_COLORS[i % TRUCK_COLORS.length],
        stops: names.join(" and "),
        was: before.length,
        km: before.reduce((a, t) => a + t.km, 0) - r.km,
      };
    })
    .filter((w) => w.was > 1 && w.km > 0);
}

function RoutesView({ data, reload }: { readonly data: RoutesData; readonly reload: () => void }) {
  const so = data.plan_case;
  const plan = so && so.status !== "rejected" ? (so.proposal as { plan?: DispatchPlan }).plan : data.preview;
  const [focus, setFocus] = useState<string | null>(null);
  const [show, setShow] = useState<"plan" | "baseline">("plan");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDrawn(true), 250);
    return () => clearTimeout(t);
  }, []);

  if (!plan) return <p className="text-[15px] text-ink-68">No orders are waiting for a truck.</p>;
  const status = !so || so.status === "rejected" ? "draft" : so.status;

  const send = () => {
    setBusy(true);
    setError(undefined);
    fetch("/api/shipping/routes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ship_date: data.ship_date }) })
      .then(async (r) => {
        if (!r.ok) setError(((await r.json()) as RoutesData).error ?? "Grok could not plan the day.");
        reload();
        announceChange();
      })
      .catch(() => setError("Grok could not plan the day."))
      .finally(() => setBusy(false));
  };

  const old = plan.baseline;
  const showOld = show === "baseline";
  return (
    <div className="space-y-6">
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <Card title={`Routes, ${day(plan.ship_date)}`}>
          <RouteMap plan={plan} mode={drawn && !showOld ? "plan" : "baseline"} focus={focus} hideBaseline={!showOld} zoom moving />
          <div className="mt-3 flex items-center justify-between gap-3 border-hairline border-t pt-3">
            <span className="min-w-0 text-[13px] leading-snug text-ink-68">Max 33 pallets, 24 t and 9 h driving per truck</span>
            {status === "draft" ? (
              <Btn onClick={send} disabled={busy}>
                {busy ? "Grok is briefing…" : "Send to the transport planner"}
              </Btn>
            ) : status === "pending" ? (
              <Link href={`/signoff?case=${encodeURIComponent(so!.caseId)}`} className="shrink-0">
                <Pill tone="attention">Waiting for the transport planner ›</Pill>
              </Link>
            ) : (
              <span className="shrink-0">
                <Pill tone="live">Booked by {so!.decidedBy?.replace(/,.*$/, "")}</Pill>
              </span>
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3">
            <Kpi tone="good" label="Saved" value={eur(plan.saving.fuel_eur, 0)} sub={`${plan.saving.fuel_pct}% less diesel`} />
            <Kpi label="Trucks" value={plan.plan.trucks} sub={`was ${old.trucks}`} />
            <Kpi label="Road km" value={n0(plan.plan.km)} sub={`was ${n0(old.km)}`} />
          </div>

          <Card title="Old way vs Grok's route">
            <div className="space-y-2" onMouseLeave={() => setShow("plan")}>
              {(
                [
                  { key: "baseline", name: "By hand: one truck per warehouse", t: old },
                  { key: "plan", name: "Grok's route", t: plan.plan },
                ] as const
              ).map((row) => (
                <button
                  key={row.key}
                  type="button"
                  onMouseEnter={() => setShow(row.key)}
                  onFocus={() => setShow(row.key)}
                  onClick={() => setShow(row.key)}
                  className={cn("block w-full rounded-[12px] px-3 py-2.5 text-left transition-colors", show === row.key ? "bg-white shadow-[0_1px_2px_rgb(32_49_25/0.08)]" : "hover:bg-white/60")}
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <b className="text-[15px] tracking-[-0.01em]">{row.name}</b>
                    <span className="text-[13px] text-ink-78 tabular-nums">
                      {row.t.trucks} trucks · {n0(row.t.km)} km · {eur(row.t.fuel_eur, 0)}
                    </span>
                  </span>
                  <span className="mt-2 block h-[8px] overflow-hidden rounded-full bg-hh-dark/[0.07]">
                    <span
                      className={cn("block h-full rounded-full transition-[width] duration-700", row.key === "plan" ? "bg-hh-asparagus" : "bg-hh-dark/35")}
                      style={{ width: `${(row.t.km / old.km) * 100}%` }}
                    />
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 px-3 text-[12px] text-ink-68">
              Old way: orders grouped by warehouse, one truck each, as Riso Scotti&apos;s logistics office plans today (
              <a className="underline" href="https://www.politesi.polimi.it/handle/10589/170825" target="_blank" rel="noreferrer">
                Politecnico di Milano, 2020
              </a>
              )
            </p>
            <ul className="mt-4 space-y-2.5 border-hairline border-t pt-4">
              {shared(plan).map((w) => (
                <li key={w.truck} className="flex gap-3 text-[14px] leading-snug" onMouseEnter={() => setFocus(w.truck)} onMouseLeave={() => setFocus(null)}>
                  <span className="mt-0.5 shrink-0 self-start">
                    <TruckGlyph color={w.color} size={22} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <b>{w.stops}</b> <span className="text-ink-68">share one truck instead of {w.was}</span>
                  </span>
                  <b className="shrink-0 self-end text-hh-asparagus tabular-nums">−{n0(w.km)} km</b>
                </li>
              ))}
            </ul>
          </Card>
          {error ? <p className="text-[13px] text-st-wrong">{error}</p> : null}
        </div>
      </div>

      <h2 className="font-bold text-[17px] tracking-[-0.02em]">Trucks</h2>
      <DataTable
        rows={plan.routes}
        rowKey={(r) => r.truck_id ?? r.orders.join()}
        columns={[
          {
            key: "t",
            header: "Truck",
            main: true,
            cell: (r) => (
              <span className="flex items-center gap-2.5" onMouseEnter={() => setFocus(r.truck_id)} onMouseLeave={() => setFocus(null)}>
                <TruckGlyph color={TRUCK_COLORS[plan.routes.indexOf(r) % TRUCK_COLORS.length]} size={22} />
                <span className="leading-tight">
                  {r.truck_id?.replace("TRUCK-", "") ?? "Carrier"}
                  {r.plate ? <span className="block font-normal text-[12px] text-ink-68">{r.plate}</span> : null}
                </span>
              </span>
            ),
          },
          { key: "s", header: "Stops", cell: (r) => r.stops.map((s) => s.retailer).join(" → ") },
          { key: "o", header: "Orders", cell: (r) => r.orders.length },
          {
            key: "l",
            header: "Load",
            cell: (r) => (
              <span className="flex w-[160px] items-center gap-3">
                <Meter value={r.pallets} max={33} />
                <span className="shrink-0 text-[13px]">{r.fill_pct}%</span>
              </span>
            ),
          },
          { key: "k", header: "Km", align: "right", cell: (r) => <b className="font-bold text-ink">{n0(r.km)}</b> },
        ]}
      />
    </div>
  );
}

const SCAN_TONE: Record<string, string> = {
  ok: "bg-hh-flex shadow-[inset_0_0_0_1px_rgb(32_49_25/0.18)]",
  loaded: "bg-hh-dark",
  flagged: "bg-st-wrong",
  todo: "bg-hh-dark/[0.07] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.12)]",
};
const tone = (s: string) => (s === "loaded" || s === "dispatched" ? "loaded" : s === "verified" ? "ok" : s === "rejected" ? "flagged" : "todo");

function DockView() {
  const [trucks, setTrucks] = useState<DockTruck[]>();
  const [at, setAt] = useState("");
  const [label, setLabel] = useState("");
  const [last, setLast] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/shipping/dock")
      .then((r) => r.json())
      .then((d: { trucks: DockTruck[] }) => setTrucks(d.trucks))
      .catch(() => setTrucks([]));
  }, []);
  const open = useMemo(() => (trucks ?? []).filter((t) => t.status !== "dispatched"), [trucks]);
  useEffect(() => {
    if (!at && open.length) setAt(open[0].truckId);
  }, [open, at]);
  const truck = open.find((t) => t.truckId === at);

  const post = (body: Record<string, string>) => {
    setBusy(true);
    fetch("/api/shipping/dock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json())
      .then((d: { trucks?: DockTruck[]; scan?: ScanResult }) => {
        if (d.trucks) setTrucks(d.trucks);
        if (d.scan) {
          setLast(d.scan);
          setLabel("");
        }
        announceChange();
      })
      .finally(() => setBusy(false));
  };

  if (!trucks) return <div className="h-60 animate-pulse rounded-[16px] bg-hh-honeydew" />;
  if (!open.length) return <p className="text-[15px] text-ink-68">No truck is loading yet. Trucks show up here once the transport planner approves the routes.</p>;

  const pallets = truck?.orders.flatMap((o) => o.pallets) ?? [];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented options={open.map((t) => ({ value: t.truckId, label: t.truckId.replace("TRUCK-", "") }))} value={at} onChange={setAt} />
        <form
          className="flex min-w-[300px] flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim()) post({ action: "scan", truck_id: at, pallet_id: label.trim() });
          }}
        >
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Scan a pallet label"
            className={cn("h-[38px] flex-1 rounded-full px-4 text-[15px] outline-none placeholder:text-ink-68", GLASS)}
          />
          <Btn type="submit" disabled={busy || !label.trim()} className="h-[38px]">
            Scan
          </Btn>
        </form>
        {truck && !pallets.length ? (
          <Btn variant="quiet" className="h-[38px]" disabled={busy} onClick={() => post({ action: "pick", truck_id: at })}>
            Print picking list
          </Btn>
        ) : truck && truck.status !== "loaded" ? (
          <Btn variant="outline" className="h-[38px]" disabled={busy} onClick={() => post({ action: "close", truck_id: at })}>
            Close the truck
          </Btn>
        ) : null}
      </div>

      {last ? (
        <p className={cn("rounded-[14px] px-4 py-3 text-[15px]", last.result === "OK" ? "bg-hh-flex/50" : "bg-st-attention text-st-attention-ink")}>
          <b>{last.result === "OK" ? "✓ " : "✗ "}</b>
          {last.text}
        </p>
      ) : null}

      {truck ? (
        <DataTable
          rows={truck.orders}
          rowKey={(o) => o.orderRef}
          columns={[
            { key: "o", header: "Order", main: true, cell: (o) => o.orderRef },
            { key: "r", header: "Retailer", cell: (o) => o.retailer },
            {
              key: "p",
              header: "Pallets",
              cell: (o) => (
                <span className="flex flex-wrap gap-[5px]">
                  {o.pallets.length
                    ? o.pallets.map((p) => (
                        <button
                          key={p.pallet_id}
                          type="button"
                          title={`${p.pallet_id} · click to read its label`}
                          onClick={() => setLabel(p.pallet_id)}
                          className={cn("block size-[18px] rounded-[5px] transition-transform hover:scale-110", SCAN_TONE[tone(p.status)])}
                        />
                      ))
                    : Array.from({ length: o.expected }, (_, k) => <i key={k} className="block size-[18px] rounded-[5px] border border-hh-dark/15 border-dashed" />)}
                </span>
              ),
            },
            { key: "n", header: "Scanned", align: "right", cell: (o) => <b className="font-bold text-ink">{o.pallets.length ? `${o.verified}/${o.pallets.length}` : "–"}</b> },
            {
              key: "s",
              header: "Status",
              cell: (o) =>
                o.flagged.length ? <Pill tone="attention">{o.flagged.length} flagged</Pill> : o.loaded ? <Pill tone="live">Loaded</Pill> : <Pill tone="quiet">{o.pallets.length ? "Scanning" : "To pick"}</Pill>,
            },
          ]}
        />
      ) : null}
    </div>
  );
}

function InvoicesView() {
  const [rows, setRows] = useState<ShippingListRow[]>();
  const [bench, setBench] = useState<BenchResult>();
  useEffect(() => {
    fetch("/api/shipping")
      .then((r) => r.json())
      .then((d: { orders: ShippingListRow[] }) => setRows(d.orders.filter((o) => o.invoice_refs.length)))
      .catch(() => setRows([]));
    fetch("/api/bench")
      .then((r) => r.json())
      .then(setBench)
      .catch(() => {});
  }, []);
  return (
    <div className="space-y-6">
      {bench ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Kpi label="Right call, ours" value={`${bench.totals.ours_attention_ok}/${bench.n}`} />
          <Kpi label="Right call, threeway (old CRM)" value={`${bench.totals.threeway_attention_ok}/${bench.n}`} />
        </div>
      ) : null}
      {rows ? (
        <ShippingTable rows={rows} onSelect={(r) => (window.location.href = `/orders?ref=${encodeURIComponent(r.order_ref)}`)} />
      ) : (
        <div className="h-24 animate-pulse rounded-[16px] bg-hh-honeydew" />
      )}
    </div>
  );
}

export function ShippingPage() {
  const params = useSearchParams();
  const router = useRouter();
  const view = (["routes", "dock", "invoices"].includes(params.get("view") ?? "") ? params.get("view") : "routes") as View;
  const [data, setData] = useState<RoutesData>();
  const load = useCallback(() => {
    fetch("/api/shipping/routes")
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  return (
    <Page
      ask={
        <SectionChat
          className="border-t-0 pt-0"
          placeholder="Ask Grok about trucks, pallets or invoices…"
          context={{ page: "shipping", view }}
          suggestions={["How were the orders grouped into trucks?", "Which pallets are not scanned yet?"]}
        />
      }
    >
      <PageHeader title="Shipping">
        <Segmented
          options={[
            { value: "routes", label: "Routes" },
            { value: "dock", label: "Loading" },
            { value: "invoices", label: "Invoices" },
          ]}
          value={view}
          onChange={(v) => router.replace(v === "routes" ? "/shipping" : `/shipping?view=${v}`, { scroll: false })}
        />
      </PageHeader>
      {view === "routes" ? data ? <RoutesView data={data} reload={load} /> : <div className="h-[460px] animate-pulse rounded-[16px] bg-hh-honeydew" /> : null}
      {view === "dock" ? <DockView /> : null}
      {view === "invoices" ? <InvoicesView /> : null}
    </Page>
  );
}
