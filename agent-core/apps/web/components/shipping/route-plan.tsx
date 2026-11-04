"use client";

/**
 * The logistics agent's plan (agent/lib/shipping/routes.ts): which orders share a truck, the stop order,
 * and what it saves against one truck per order. The same card shows in chat (shipping_plan_routes)
 * and on the Shipping page. Code planned it, Grok wrote the briefing, the transport planner approves.
 */
import type { Signoff } from "@agent/lib/core/erp";
import type { Briefing, DispatchPlan, Route } from "@agent/lib/shipping/routes";
import { useCallback, useEffect, useState } from "react";
import { SignoffCard, SignoffStatus } from "@/components/core/signoff";
import { Panel, Pill, SourceTag, Stat, day, eur, qty } from "@/components/kit";

type PlanOutput = {
  ship_date?: string;
  ready?: string[];
  case_id?: string;
  plan?: DispatchPlan;
  briefing?: Briefing;
  plan_case?: Signoff | null;
  error?: string;
};

const hours = (min: number) => `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;

function BriefingBox({ briefing }: { readonly briefing: Briefing }) {
  const pill =
    briefing.by === "code" ? (
      <Pill tone="quiet">Written by code</Pill>
    ) : (
      <Pill tone="grok">{briefing.by === "grok" ? "Grok" : "Grok, recorded answer"}</Pill>
    );
  return (
    <div className="space-y-2 rounded-[12px] bg-hh-honeydew p-3 text-[13px]">
      <div className="flex items-center gap-2">
        {pill}
        <span className="text-[12px] text-ink-68">every figure checked against the plan by code</span>
      </div>
      <p className="leading-relaxed">{briefing.summary}</p>
      {briefing.watch.length ? (
        <ul className="list-disc space-y-0.5 pl-5 text-ink-78">
          {briefing.watch.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RouteBlock({ route, plant }: { readonly route: Route; readonly plant: string }) {
  return (
    <div className="rounded-[12px] p-3 shadow-[inset_0_0_0_1.5px_rgb(32_49_25/0.09)]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-bold text-[14px]">
          {route.truck_id ?? "Carrier to book"}
          {route.plate ? <span className="ml-2 font-normal text-[12px] text-ink-68">{route.plate}</span> : null}
        </div>
        <div className="text-[12px] text-ink-68 tabular-nums">
          {route.pallets} of 33 pallets ({route.fill_pct}%) · {qty(route.km)} km · {hours(route.drive_min)} driving
          {route.driver_days > 1 ? ` · ${route.driver_days} driver days` : ""} · {qty(route.litres)} l · {eur(route.fuel_eur)}
        </div>
      </div>
      <ol className="mt-2 space-y-1 text-[13px]">
        <li className="text-ink-68">Leaves {plant}</li>
        {route.stops.map((s, i) => (
          <li key={`${s.point}-${i}`} className="grid grid-cols-[20px_1fr_auto] items-baseline gap-2">
            <span className="text-ink-68 tabular-nums">{i + 1}.</span>
            <span>
              <b>{s.point}</b>
              <span className="text-ink-68">
                {" "}
                · {s.retailer}, {s.town}
              </span>
              <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                {s.orders.map((o) => (
                  <SourceTag key={o}>{o}</SourceTag>
                ))}
              </span>
            </span>
            <span className="text-[12px] text-ink-68 tabular-nums">
              {s.pallets} pallets · after {hours(s.arrive_drive_min)}
            </span>
          </li>
        ))}
        <li className="text-ink-68">Back to {plant}</li>
      </ol>
    </div>
  );
}

/** The plan: savings first, Grok's briefing, then each truck's stops, then how the numbers were made. */
export function RoutePlanBody({ plan, briefing }: { readonly plan: DispatchPlan; readonly briefing?: Briefing | null }) {
  const b = plan.baseline;
  const p = plan.plan;
  const s = plan.saving;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="Trucks" value={p.trucks} hint={`instead of ${b.trucks}, one per order`} />
        <Stat label="Km" value={qty(p.km)} hint={`instead of ${qty(b.km)}, ${s.km_pct}% less`} />
        <Stat label="Diesel" value={eur(p.fuel_eur)} hint={`instead of ${eur(b.fuel_eur)}, ${eur(s.fuel_eur)} saved`} />
        <Stat label="Driver days" value={p.driver_days} hint={`instead of ${b.driver_days}`} />
      </div>
      <p className="text-[12px] text-ink-68">
        {qty(p.litres)} l of diesel instead of {qty(b.litres)}. CO2 about {qty(p.co2_kg)} kg instead of {qty(b.co2_kg)} (estimate).
      </p>
      {briefing ? <BriefingBox briefing={briefing} /> : null}
      <div className="space-y-2">
        {plan.routes.map((r) => (
          <RouteBlock key={`${r.truck_id}-${r.orders.join()}`} route={r} plant={plan.plant.name} />
        ))}
      </div>
      {plan.unplanned.length ? (
        <div className="text-[13px]">
          <div className="mb-1 text-[12px] text-ink-68">Not planned</div>
          <ul className="list-disc space-y-0.5 pl-5">
            {plan.unplanned.map((u) => (
              <li key={u.order_ref}>
                <b>{u.order_ref}</b>: {u.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <details className="text-[12px]">
        <summary className="cursor-pointer select-none text-ink-68">How we got these numbers</summary>
        <div className="mt-2 space-y-2">
          <div>
            <div className="text-ink-68">Code checked</div>
            <ul className="list-disc pl-5">
              {plan.checks.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-ink-68">Sources</div>
            <ul className="list-disc pl-5">
              {plan.sources.map((x) => (
                <li key={x.what}>
                  <b>{x.what}</b>: {x.url ? <a className="underline" href={x.url} target="_blank" rel="noreferrer">{x.source}</a> : x.source}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-ink-68">Today: one truck per order</div>
            <ul className="list-disc pl-5 tabular-nums">
              {b.trips.map((t) => (
                <li key={t.order_ref}>
                  {t.order_ref}: Pavia to {t.point} and back, {qty(t.km)} km
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>
    </div>
  );
}

/** Chat card for shipping_plan_routes, also used on the page. Takes the tool's or the API's output. */
export function RoutePlanCard({ output, onDecided }: { readonly output: unknown; readonly onDecided?: () => void }) {
  const o = (output ?? {}) as PlanOutput;
  const so = o.plan_case ?? null;
  const proposal = (so?.proposal ?? {}) as { plan?: DispatchPlan; briefing?: Briefing };
  const plan = o.plan ?? proposal.plan;
  const briefing = o.briefing ?? proposal.briefing ?? null;
  if (o.error) {
    return (
      <Panel title="Logistics agent">
        <p className="text-[13px]">{o.error}</p>
      </Panel>
    );
  }
  if (!plan) return null;
  return (
    <Panel
      title={`Trucks for ${day(plan.ship_date)}`}
      aside={
        <span className="flex items-center gap-2">
          {so ? <SourceTag>{so.caseId}</SourceTag> : null}
          <span>Logistics agent</span>
          {so ? <SignoffStatus status={so.status} /> : null}
        </span>
      }
    >
      <RoutePlanBody plan={plan} briefing={briefing} />
      {so?.status === "pending" ? (
        <div className="mt-3">
          <SignoffCard signoff={so} onDecided={() => onDecided?.()} />
        </div>
      ) : so ? (
        <p className="mt-3 text-[12px] text-ink-68">
          {so.status === "approved" ? "Approved" : "Rejected"} by {so.decidedBy}: {so.decisionReason}
          {so.status === "approved" ? ". Trucks booked and manifests written; picking and scans follow per order." : "."}
        </p>
      ) : null}
    </Panel>
  );
}

/** The Shipping page's dispatch section: the waiting or last plan, or a button to ask for one. */
export function RoutePlanPanel() {
  const [data, setData] = useState<PlanOutput>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    fetch("/api/shipping/routes")
      .then((r) => r.json())
      .then((d: PlanOutput) => setData(d))
      .catch(() => setError("Could not load the dispatch plan."));
  }, []);
  useEffect(load, [load]);

  const plan = useCallback(() => {
    setBusy(true);
    setError(undefined);
    fetch("/api/shipping/routes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ship_date: data?.ship_date }) })
      .then(async (r) => {
        const d = (await r.json()) as PlanOutput;
        if (!r.ok) setError(d.error ?? "The logistics agent could not plan the day.");
        else setData(d);
      })
      .catch(() => setError("The logistics agent could not plan the day."))
      .finally(() => setBusy(false));
  }, [data?.ship_date]);

  if (!data) return null;
  const so = data.plan_case;
  const canPlan = data.ready?.length && (!so || so.status === "rejected");
  return (
    <div className="space-y-2">
      {so ? <RoutePlanCard output={data} onDecided={load} /> : null}
      {canPlan ? (
        <Panel title={`Dispatch ${day(data.ship_date)}`} aside="Logistics agent">
          <div className="flex flex-wrap items-center justify-between gap-3 text-[13px]">
            <p>
              {data.ready!.length} orders are ready to ship and not on a truck yet: {data.ready!.join(", ")}. Today each would get its own truck.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={plan}
              className="h-8 rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window disabled:opacity-40"
            >
              {busy ? "Planning…" : "Plan the trucks with Grok"}
            </button>
          </div>
          {error ? <p className="mt-2 text-[12px] text-st-wrong">{error}</p> : null}
        </Panel>
      ) : null}
    </div>
  );
}
