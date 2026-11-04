"use client";

/**
 * Overview widgets: the state of the back office in one short story, four numbers, the cases
 * waiting for a person and the latest actions. Rendered as the first message of the Overview
 * thread, and as the chat card for the `overview_snapshot` tool.
 */
import type { OverviewSnapshot } from "@agent/lib/core/overview";
import type { MarketSnapshot } from "@agent/lib/rice";
import type { Signoff } from "@agent/lib/core/erp";
import { useEffect, useState } from "react";
import { Panel, Stat, eur } from "@/components/kit";
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
        <Panel title="Waiting for a person" aside={<a href="/signoff" className="underline underline-offset-2">Sign-off Pending</a>}>
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

/** The first message of the Overview thread. */
export function OverviewIntro({ onAsk }: { readonly onAsk: Ask }) {
  const [snapshot, setSnapshot] = useState<OverviewSnapshot>();
  const [waiting, setWaiting] = useState<Signoff[]>();
  const [market, setMarket] = useState<MarketSnapshot>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetch("/api/overview")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setSnapshot(d)))
      .catch((e: Error) => setError(e.message));
    fetch("/api/signoffs")
      .then((r) => r.json())
      .then((d) => setWaiting(d.pending))
      .catch(() => {});
    fetch("/api/rice/market")
      .then((r) => r.json())
      .then((d) => !d.error && setMarket(d))
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      {error ? <p className="text-[13px] text-st-wrong">Could not load the Mini ERP: {error}</p> : null}
      {snapshot ? (
        <OverviewWidgets snapshot={snapshot} market={market} waiting={waiting} />
      ) : (
        <div className="space-y-3">
          <div className="h-5 w-2/3 animate-pulse rounded bg-hh-honeydew" />
          <div className="h-24 animate-pulse rounded-[14px] bg-hh-honeydew" />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {[
          "What needs a person today, and why?",
          "Walk me through the golden order end to end.",
          "Should we buy Carnaroli paddy now or wait?",
        ].map((text) => (
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
  );
}
