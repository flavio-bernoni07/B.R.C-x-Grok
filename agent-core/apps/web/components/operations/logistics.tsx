"use client";

import type { LogisticsPlan } from "@agent/lib/logistics/plan";
import { type ReactNode, useEffect, useState } from "react";
import { eur, Panel, Pill, qty, Stat } from "@/components/kit";

const km = (v: number) => `${qty(v)} km`;

/** The Logistics agent's plan: trucks, stops with km, and what it saves against one truck per order. */
export function LogisticsPlanCard({ plan, toolbar }: { readonly plan: LogisticsPlan; readonly toolbar?: ReactNode }) {
  return (
    <Panel
      title="Logistics plan"
      aside={
        <span className="flex items-center gap-2">
          {plan.scenario ? <Pill tone="attention">Demo orders added</Pill> : null}
          <Pill tone="quiet">Estimate</Pill>
          {toolbar}
        </span>
      }
    >
      <p className="mb-3 text-[14px] leading-relaxed">{plan.explanation}</p>
      {plan.trucks.length ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat label="Trucks saved" value={qty(plan.savings.trucks)} hint={`${plan.trucks.length} instead of ${plan.baseline.trucks}`} />
            <Stat label="Km saved" value={qty(plan.savings.km)} hint={`baseline ${km(plan.baseline.km)}`} />
            <Stat label="Diesel saved" value={`${qty(plan.savings.litres)} L`} />
            <Stat label="Fuel cost saved" value={eur(plan.savings.eur, 0)} hint={`baseline ${eur(plan.baseline.eur, 0)}`} />
            <Stat label="CO2 saved" value={`${qty(plan.savings.co2_kg)} kg`} />
          </div>
          <div className="space-y-2">
            {plan.trucks.map((t) => (
              <div key={t.truck} className="rounded-[10px] bg-white/60 px-3 py-2 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.07)]">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <b>{t.truck}</b> · {t.date} · {t.orders.join(", ")}
                  </span>
                  <span className="text-ink-68 tabular-nums">
                    {t.pallets}/33 pallets · {qty(t.weight_kg)} kg · {km(t.km)} · {qty(t.litres)} L · {eur(t.eur, 0)} · {qty(t.co2_kg)} kg CO2
                  </span>
                </div>
                <ol className="mt-1 flex flex-wrap gap-x-3 text-ink-78">
                  <li>Pavia</li>
                  {t.stops.map((s, i) => (
                    <li key={i}>
                      → {s.name} <span className="text-ink-68">({km(s.km)})</span>
                    </li>
                  ))}
                </ol>
                {t.note ? <p className="mt-1 text-[12px] text-st-attention-ink">{t.note}</p> : null}
              </div>
            ))}
          </div>
        </>
      ) : null}
      {plan.skipped.length ? (
        <p className="mt-3 text-[12px] text-ink-68">Not planned: {plan.skipped.map((s) => `${s.order_ref} (${s.why})`).join("; ")}.</p>
      ) : null}
      <details className="mt-3 text-[12px] text-ink-68">
        <summary className="cursor-pointer">Assumptions</summary>
        <ul className="mt-1 space-y-0.5">
          {plan.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </details>
    </Panel>
  );
}

/** The plan with a toggle for the demo scenario, fetching GET /api/logistics/plan. */
export function LogisticsPlanPanel() {
  const [scenario, setScenario] = useState(false);
  const [plan, setPlan] = useState<LogisticsPlan | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    fetch(`/api/logistics/plan${scenario ? "?scenario=1" : ""}`)
      .then((r) => r.json())
      .then((d: LogisticsPlan) => live && setPlan(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [scenario]);
  if (failed) return <Panel title="Logistics plan"><p className="text-[13px] text-ink-68">The plan could not be loaded. Please reload the page.</p></Panel>;
  if (!plan) return <div className="h-40 animate-pulse rounded-[14px] bg-hh-honeydew" />;
  return (
    <LogisticsPlanCard
      plan={plan}
      toolbar={
        <button type="button" onClick={() => setScenario((v) => !v)} className="text-ink-68 hover:text-ink">
          {scenario ? "Hide demo orders" : "Show with demo orders"}
        </button>
      }
    />
  );
}
