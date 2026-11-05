"use client";

/**
 * Overview widgets: the state of the back office in one short story, four numbers, the cases
 * waiting for a person and the latest actions. Rendered as the first message of the Overview
 * thread, and as the chat card for the `overview_snapshot` tool.
 */
import { caseAmount, caseNextStep, caseOrderRef, caseProblem, caseRole } from "@agent/lib/core/case-view";
import type { ImpactSummary } from "@agent/lib/core/impact";
import type { OverviewSnapshot } from "@agent/lib/core/overview";
import type { MarketSnapshot } from "@agent/lib/rice";
import type { Signoff } from "@agent/lib/core/erp";
import { useEffect, useState } from "react";
import { Panel, Stat, day, eur } from "@/components/kit";
import { AuditList } from "./audit";
import { SignoffQueue } from "./signoff";

export type Ask = (text: string, context?: Record<string, string | number | boolean>) => void;

function story(o: OverviewSnapshot, market?: MarketSnapshot): string {
  const c = o.counts;
  const parts = [
    `${c.orders} ${c.orders === 1 ? "order" : "orders"} in the Mini ERP`,
    `${c.invoicesSent} ${c.invoicesSent === 1 ? "invoice" : "invoices"} sent for ${eur(c.invoicedNet)} net`,
    `${c.claims} ${c.claims === 1 ? "claim" : "claims"}, ${c.creditNotes} credit ${c.creditNotes === 1 ? "note" : "notes"} issued`,
  ];
  let s = `${parts.join(", ")}.`;
  s += c.signoffsWaiting
    ? ` ${c.signoffsWaiting} ${c.signoffsWaiting === 1 ? "case waits" : "cases wait"} for a person.`
    : " Nothing waits for a person.";
  if (o.stockAlerts.length) s += ` ${o.stockAlerts.map((a) => `${a.held.toLocaleString("en-GB")} of ${a.name}`).join(", ")} on quality hold.`;
  const car = market?.paddy.find((p) => p.variety === "Carnaroli");
  if (car) s += ` Carnaroli paddy is at €${car.price_eur_t}/t.`;
  return s;
}

export function OverviewWidgets({ snapshot, market, waiting }: { readonly snapshot: OverviewSnapshot; readonly market?: MarketSnapshot; readonly waiting?: Signoff[] }) {
  const c = snapshot.counts;
  return (
    <div className="space-y-3">
      <p className="text-[15px] leading-relaxed">{story(snapshot, market)}</p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Orders" value={c.orders} hint={Object.entries(c.ordersByStatus).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(" · ") || "none yet"} />
        <Stat label="Invoiced, net" value={eur(c.invoicedNet, 0)} hint={`${c.invoicesSent} sent${c.invoicesHeld ? `, ${c.invoicesHeld} held` : ""}`} />
        <Stat label="Claims" value={c.claims} hint={`${c.creditNotes} credit ${c.creditNotes === 1 ? "note" : "notes"}`} />
        <Stat
          label="Waiting for a person"
          value={<span className={c.signoffsWaiting ? "text-st-attention-ink" : undefined}>{c.signoffsWaiting}</span>}
          hint={`${c.signoffsDecided} decided`}
        />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Waiting for a person" aside={<a href="/signoff" className="underline underline-offset-2">Sign-off</a>}>
          <SignoffQueue cases={(waiting ?? snapshot.waiting) as Signoff[]} compact />
        </Panel>
        <Panel title="Latest actions" aside={`${c.auditEvents} in the audit log`}>
          <AuditList entries={snapshot.recent} max={7} />
        </Panel>
      </div>
    </div>
  );
}

/** Chat card for `overview_snapshot`. */
export function OverviewCard({ output }: { readonly output: unknown }) {
  return <OverviewWidgets snapshot={output as OverviewSnapshot} />;
}

const EXAMPLES = [
  "Which orders need attention today?",
  "Will we have enough Carnaroli stock next week?",
  "Why is order ESS-GOLD-001 delayed?",
  "Which invoices have discrepancies?",
];

const pct = (x: number | null) => (x == null ? "–" : `${Math.round(x * 100)}%`);

/** Fuel saved by the truck plan, if Operations' plan route answers with a figure. Estimate only. */
function fuelSaved(plan: unknown): number | undefined {
  const p = (plan ?? {}) as Record<string, unknown>;
  const pick = (o: unknown, ...keys: string[]) => {
    const r = (o ?? {}) as Record<string, unknown>;
    for (const k of keys) if (typeof r[k] === "number") return r[k] as number;
    return undefined;
  };
  return pick(p, "fuel_saved_eur", "fuelSavedEur") ?? pick(p.savings, "eur", "fuel_eur", "fuelEur", "fuel_saved_eur") ?? pick(p.summary, "fuel_saved_eur", "fuelSavedEur");
}

/** One line on what the agents did, every figure from the records; estimates say so. */
export function ImpactLine({ impact, fuel }: { readonly impact: ImpactSummary; readonly fuel?: number }) {
  const parts = [
    `${impact.steps.byAgents} steps by agents, ${impact.steps.byPeople} by people`,
    `${pct(impact.cases.share)} of cases needed no person (${impact.cases.withoutPerson} of ${impact.cases.total})`,
    `${impact.invoiceGapsCaught.count} invoice ${impact.invoiceGapsCaught.count === 1 ? "gap" : "gaps"} caught`,
  ];
  if (impact.benchmark) parts.push(`benchmark: ${impact.benchmark.ours} of ${impact.benchmark.cases} causes right, threeway ${impact.benchmark.threeway}`);
  if (fuel != null && fuel > 0) parts.push(`fuel saved ${eur(fuel, 0)} (estimate)`);
  return (
    <p className="text-[13px] text-ink-78" title={`${impact.steps.source}; ${impact.cases.source}; ${impact.invoiceGapsCaught.source}`}>
      {parts.join(" · ")}.
    </p>
  );
}

export function HomeNumbers({ impact }: { readonly impact: ImpactSummary }) {
  const c = impact.counts;
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <Stat label="Active orders" value={c.activeOrders} />
      <Stat label="Running automatically" value={c.runningAutomatically} hint="no sign-off waiting" />
      <Stat
        label="Needing a person"
        value={<span className={c.casesWaiting ? "text-st-attention-ink" : undefined}>{c.casesWaiting}</span>}
        hint={`${c.casesWaiting === 1 ? "case" : "cases"} waiting · ${c.needingPerson} ${c.needingPerson === 1 ? "order" : "orders"}`}
      />
      <Stat
        label="Deliveries at risk"
        value={<span className={c.deliveriesAtRisk ? "text-st-attention-ink" : undefined}>{c.deliveriesAtRisk}</span>}
        hint={impact.atRisk.map((r) => r.orderRef).join(", ") || "none"}
      />
    </div>
  );
}

export function RecentlyCompleted({ items }: { readonly items: ImpactSummary["recent"] }) {
  if (!items.length) return <p className="py-2 text-[13px] text-ink-68">Nothing completed yet.</p>;
  return (
    <ul className="divide-y divide-[var(--color-hairline)]">
      {items.map((r, i) => (
        <li key={`${r.at}${i}`} className="flex items-center gap-3 py-1.5 text-[13px]">
          <span className="w-[56px] shrink-0 text-[12px] text-ink-68">{day(r.at)}</span>
          {r.href ? (
            <a href={r.href} className="min-w-0 flex-1 truncate hover:underline">
              {r.text}
            </a>
          ) : (
            <span className="min-w-0 flex-1 truncate">{r.text}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function AttentionCard({ c }: { readonly c: Signoff }) {
  const amount = caseAmount(c);
  const ref = caseOrderRef(c) ?? c.subjectRef;
  return (
    <li className="rounded-[12px] bg-hh-seasalt p-3 shadow-[inset_0_0_0_1.5px_rgb(32_49_25/0.09)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1 text-[13px]">
          <p className="font-bold text-[14px]">{caseProblem(c)}</p>
          <p className="text-ink-68">
            {ref ? <b className="text-ink">{ref}</b> : null}
            {amount ? ` · ${eur(amount.eur)} ${amount.label}` : ""} · {caseRole(c)}
          </p>
          <p>Next step: {caseNextStep(c)}</p>
        </div>
        <a href={`/signoff?case=${encodeURIComponent(c.caseId)}`} className="h-8 shrink-0 rounded-full bg-hh-dark px-4 font-bold text-[13px] leading-8 text-hh-window">
          Review action
        </a>
      </div>
    </li>
  );
}

/** Chat card for `impact_summary`. */
export function ImpactCard({ output }: { readonly output: unknown }) {
  const impact = output as ImpactSummary;
  return (
    <Panel title="What the agents did" aside="from the records">
      <div className="space-y-3">
        <HomeNumbers impact={impact} />
        <ImpactLine impact={impact} />
        <RecentlyCompleted items={impact.recent} />
      </div>
    </Panel>
  );
}

/** The first message of the Home thread: the title, example questions, then the state of things. */
export function OverviewIntro({ onAsk }: { readonly onAsk: Ask }) {
  const [impact, setImpact] = useState<ImpactSummary>();
  const [waiting, setWaiting] = useState<Signoff[]>();
  const [fuel, setFuel] = useState<number>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetch("/api/impact")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setImpact(d)))
      .catch(() => setError("the records did not load"));
    fetch("/api/signoffs")
      .then((r) => r.json())
      .then((d) => setWaiting(d.pending ?? []))
      .catch(() => {});
    fetch("/api/logistics/plan")
      .then((r) => (r.ok ? r.json() : undefined))
      .then((d) => setFuel(fuelSaved(d)))
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <h2 className="font-bold text-[24px] tracking-[-0.035em]">Ask anything about your operations</h2>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => onAsk(text)}
              className="rounded-full bg-hh-seasalt px-3 py-1.5 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.12)] transition-colors hover:bg-hh-honeydew"
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="text-[13px] text-st-wrong">Could not load the Mini ERP: {error}</p> : null}
      {impact ? (
        <div className="space-y-2">
          <HomeNumbers impact={impact} />
          <ImpactLine impact={impact} fuel={fuel} />
        </div>
      ) : !error ? (
        <div className="h-20 animate-pulse rounded-[14px] bg-hh-honeydew" />
      ) : null}

      <div className="space-y-2">
        <h3 className="font-bold text-[15px] tracking-[-0.02em]">Needs your attention</h3>
        {waiting == null ? null : waiting.length ? (
          <ul className="space-y-2">
            {waiting.map((c) => (
              <AttentionCard key={c.caseId} c={c} />
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-ink-68">Nothing needs a person right now.</p>
        )}
      </div>

      {impact ? (
        <div className="space-y-1">
          <h3 className="font-bold text-[15px] tracking-[-0.02em]">Recently completed</h3>
          <RecentlyCompleted items={impact.recent} />
        </div>
      ) : null}
    </div>
  );
}
