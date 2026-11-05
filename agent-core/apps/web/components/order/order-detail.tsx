"use client";

/**
 * One order in the side panel: who has it, where it is, the split if Grok split it, three numbers,
 * the retailer's contract, what happened, more details on demand, the documents to download, and a
 * chat about this order. A pending sign-off is decided here, with the same buttons as Sign-off.
 */
import type { Signoff } from "@agent/lib/core/erp";
import type { JourneyStep, OrderWorkspace } from "@agent/lib/order/workspace";
import { useEffect, useState } from "react";
import { DocLink, Kpi, Owner, Pill, SourceTag, day, eur, qty } from "@/components/kit";
import { GrokMark } from "@/components/kit/icons";
import { SignoffInline } from "@/components/core/signoff-desk";
import { StoryList } from "./story-list";
import { announceChange } from "@/components/shell/app-shell";
import { SectionChat } from "@/components/shell/section-chat";
import { cn } from "@/lib/utils";
import { STATUS_TONE } from "./workspace";
import { CaughtList } from "./caught-list";

/** Fields the order workspace carries for contracts and documents (agent/lib/order/workspace.ts). */
type ContractSummary = {
  id: string;
  retailer: string;
  start: string;
  end: string;
  billing: "monthly";
  paymentTermsDays: number;
  products: number;
  annualVolumeUnits: number;
  annualValueEur: number;
  status: string;
  href: string;
};
type Doc = { docId: string; kind: string; ref: string | null; filename: string; href: string };
type Ws = OrderWorkspace & { contract?: ContractSummary | null; documents?: Doc[] };

const short = (iso: string | null) =>
  iso ? new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : null;

/** The eight steps a person asks about; each says what it means on hover. */
const RAIL: Record<string, [string, string]> = {
  received: ["Received", "The retailer's ORDERS arrived"],
  confirmed: ["Confirmed", "Checks passed and the ORDRSP went back to the retailer"],
  planned: ["Truck booked", "The order is on an approved truck plan for its ship date"],
  loaded: ["Loaded", "Every pallet was scanned at the dock and loaded on its truck"],
  dispatched: ["Shipped", "The truck left the plant with the DESADV and the DDT"],
  invoiced: ["Invoiced", "The invoice for what shipped was issued (FatturaPA and INVOIC)"],
  received_by_retailer: ["Delivered", "The retailer signed the DDT at its warehouse"],
  paid: ["Paid", "The retailer's payment was recorded"],
};

function StageRail({ journey }: { readonly journey: JourneyStep[] }) {
  const steps = journey.filter((s) => s.key in RAIL);
  const current = steps.findIndex((s) => !s.done);
  return (
    <ol className="grid" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
      {steps.map((s, i) => (
        <li key={s.key} className="flex flex-col items-start" title={`${RAIL[s.key][1]}${s.done && s.who ? ` · ${s.who}` : ""}`}>
          <div className="flex w-full items-center">
            <span
              className={cn(
                "block size-[12px] shrink-0 rounded-full",
                s.done ? "bg-hh-dark" : i === current ? "bg-hh-flex ring-[1.5px] ring-hh-dark" : "bg-hh-seasalt ring-[1.5px] ring-hh-dark/20",
              )}
            />
            {i < steps.length - 1 ? <span className={cn("h-[2px] flex-1", s.done && steps[i + 1].done ? "bg-hh-dark" : "bg-hh-dark/12")} /> : null}
          </div>
          <span className={cn("mt-2 pr-1 text-[11px] leading-tight tracking-[-0.01em]", s.done || i === current ? "text-ink" : "text-ink-50", i === current && "font-bold")}>
            {RAIL[s.key][0]}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Sign-off cases for this order that the caught cards do not already decide. Approve and reject stay on this page. */
function OrderDecisions({ ws }: { readonly ws: OrderWorkspace }) {
  const covered = new Set(
    ws.caught.filter((c) => !c.done).flatMap((c) => {
      const m = c.href?.match(/[?&]case=([^&]+)/);
      return m ? [decodeURIComponent(m[1])] : c.caseId ? [c.caseId] : [];
    }),
  );
  const ids = [...new Set(ws.exceptions.map((e) => e.caseId).filter((id) => !covered.has(id)))];
  const [cases, setCases] = useState<Signoff[]>([]);
  const key = ids.join("|");

  useEffect(() => {
    if (!key) return;
    let live = true;
    Promise.all(
      key.split("|").map((id) =>
        fetch(`/api/signoffs/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null)),
      ),
    )
      .then((rows) => {
        if (!live) return;
        setCases(rows.flatMap((d) => (d?.case?.status === "pending" ? [d.case as Signoff] : [])));
      })
      .catch(() => live && setCases([]));
    return () => {
      live = false;
    };
  }, [key]);

  if (!cases.length) return null;
  return (
    <div className="space-y-3">
      {cases.map((c) => (
        <SignoffInline key={c.caseId} c={c} onDecided={() => announceChange()} />
      ))}
    </div>
  );
}

export function OrderDetail({ ws: base }: { readonly ws: OrderWorkspace }) {
  const ws = base as Ws;
  const s = ws.split;
  const product = ws.details.lines[0]?.product?.replace(/^Riso Scotti |^Scotti /, "") ?? "";
  const k = ws.contract;
  return (
    <article className="space-y-8 px-8 pt-8 pb-10">
      <header className="space-y-3 pr-12">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-bold text-[30px] leading-none tracking-[-0.035em]">{ws.retailer}</h2>
          {s ? <Pill tone="grok">Grok: split</Pill> : <Pill tone={STATUS_TONE[ws.status]}>{ws.statusLabel}</Pill>}
        </div>
        <p className="text-[15px] text-ink-68">
          {ws.orderRef} · {product} · {qty(ws.summary.ordered)}
        </p>
        <Owner kind={ws.owner.kind} name={ws.owner.name} doing={ws.owner.doing} />
      </header>

      <StageRail journey={ws.journey} />

      <CaughtList ws={ws} />
      <OrderDecisions ws={ws} />

      {s ? (
        <section className="space-y-3">
          <div className="flex h-[44px] w-full overflow-hidden rounded-[12px] text-[14px]">
            <div className="flex items-center justify-between gap-2 bg-hh-dark px-4 text-hh-honeydew" style={{ width: `${(s.now / (s.now + s.later)) * 100}%` }}>
              <b className="tabular-nums">{qty(s.now)}</b>
              <span className="truncate opacity-75">now</span>
            </div>
            <div className="flex flex-1 items-center justify-between gap-2 bg-hh-flex/60 px-4">
              <b className="tabular-nums">{qty(s.later)}</b>
              <span className="truncate text-ink-78">{short(s.laterDate) ?? "next batch"}</span>
            </div>
          </div>
          {s.message ? (
            <details className="group text-[14px]">
              <summary className="cursor-pointer list-none text-ink-68 hover:text-ink">
                Grok&apos;s message to {ws.retailer} <span className="inline-block transition-transform group-open:rotate-90">›</span>
              </summary>
              <p className="mt-2 text-[14px] text-ink-78 italic leading-relaxed">{s.message}</p>
            </details>
          ) : null}
        </section>
      ) : null}

      <div className="grid grid-cols-3 gap-3">
        <Kpi label="Ordered" value={qty(ws.summary.ordered)} />
        <Kpi label="Shipped" value={ws.summary.shipped ? qty(ws.summary.shipped) : "–"} />
        <Kpi label="Value" value={eur(ws.value, 0)} />
      </div>

      {k ? (
        <a href={k.href} download className="flex items-center justify-between gap-4 rounded-[14px] bg-hh-seasalt px-4 py-3 shadow-[inset_0_0_0_1.5px_rgb(32_49_25/0.09)] transition-colors hover:bg-white">
          <span className="min-w-0">
            <span className="block text-[13px] text-ink-78">Contract</span>
            <b className="block truncate text-[16px] tracking-[-0.01em]">{k.id}</b>
            <span className="block text-[13px] text-ink-68">
              {day(k.start)} to {day(k.end)} · billed monthly · paid at {k.paymentTermsDays} days · {eur(k.annualValueEur, 0)} a year
            </span>
          </span>
          <span className="shrink-0 font-bold text-[13px]">Download ›</span>
        </a>
      ) : ws.details.contractId ? (
        <p className="text-[14px] text-ink-68">
          Contract <b className="text-ink">{ws.details.contractId}</b>
        </p>
      ) : null}

      <section>
        <h3 className="mb-3 text-[13px] text-ink-68">What happened</h3>
        {ws.story?.length ? (
          <StoryList steps={ws.story} />
        ) : (
          <ul>
            {ws.journey
              .filter((j) => j.done)
              .map((j) => (
                <li key={j.key} className="flex items-center gap-3 border-hairline border-t py-2.5 text-[14px] first:border-t-0">
                  {/grok/i.test(j.who ?? "") ? <GrokMark size={22} title={`${j.who} handled this`} /> : <i className="mx-[7px] block size-[8px] shrink-0 rounded-full bg-hh-dark" />}
                  <b className="w-[100px] shrink-0">{RAIL[j.key]?.[0] ?? j.label}</b>
                  <span className="min-w-0 flex-1 truncate text-ink-68">{j.who}</span>
                  <span className="shrink-0 text-[13px] text-ink-50 tabular-nums">{short(j.when)}</span>
                </li>
              ))}
          </ul>
        )}
      </section>

      <details className="group">
        <summary className="cursor-pointer list-none text-[14px] font-bold hover:text-ink-78">
          More details <span className="inline-block transition-transform group-open:rotate-90">›</span>
        </summary>
        <div className="mt-4 space-y-5 text-[14px]">
          <div className="space-y-1.5">
            {ws.details.lines.map((l) => (
              <div key={l.lineNo} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-hairline border-b pb-1.5">
                <b>{l.product ?? l.gtin}</b>
                <span className="text-ink-68 tabular-nums">
                  {qty(l.ordered)} ordered · {qty(l.confirmed)} confirmed · {eur(l.unitPrice)} a pack
                  {l.contractPrice != null ? ` · contract ${eur(l.contractPrice)}` : ""}
                </span>
              </div>
            ))}
          </div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5">
            <dt className="text-ink-68">Ordered on</dt>
            <dd>{short(ws.orderDate) ?? "–"}</dd>
            <dt className="text-ink-68">Delivery</dt>
            <dd>{short(ws.deliveryDate) ?? "not set on the order"}</dd>
            <dt className="text-ink-68">Next</dt>
            <dd>{ws.nextStep}</dd>
            <dt className="text-ink-68">Steps</dt>
            <dd>{ws.counter.text}</dd>
            {ws.shipping?.truck ? (
              <>
                <dt className="text-ink-68">Truck</dt>
                <dd>
                  {ws.shipping.truck.id} {ws.shipping.truck.plate ?? ""}
                  {ws.shipping.pallets ? ` · ${ws.shipping.scans.ok} of ${ws.shipping.pallets} pallets scanned` : ""}
                </dd>
              </>
            ) : null}
            {ws.summary.moneyAtStake ? (
              <>
                <dt className="text-ink-68">At stake</dt>
                <dd>
                  {eur(ws.summary.moneyAtStake)} · {ws.summary.moneyAtStakeNote}
                </dd>
              </>
            ) : null}
          </dl>
          {ws.details.grokChanges.length ? (
            <ul className="space-y-1 text-ink-78">
              {ws.details.grokChanges.map((g, i) => (
                <li key={i}>
                  <b className="text-ink">Grok changed {g.what.toLowerCase()}</b>: {g.before} → {g.after}. {g.why}.
                </li>
              ))}
            </ul>
          ) : null}
          {ws.history.length ? (
            <ul className="space-y-1 text-[13px] text-ink-68">
              {ws.history.map((h, i) => (
                <li key={i} className="flex gap-3">
                  <span className="w-[56px] shrink-0 tabular-nums">{short(h.at)}</span>
                  <span className="min-w-0 flex-1">
                    <b className="text-ink">{h.who}</b> {h.action.charAt(0).toLowerCase() + h.action.slice(1)}
                  </span>
                  {h.document ? <SourceTag>{h.document}</SourceTag> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>

      {ws.documents?.length ? (
        <section>
          <h3 className="mb-2 text-[13px] text-ink-68">Documents</h3>
          <div className="flex flex-wrap gap-2">
            {ws.documents.map((d) => (
              <DocLink key={d.docId} href={d.href} kind={d.kind} label={d.ref ?? d.docId} />
            ))}
          </div>
        </section>
      ) : null}

      <SectionChat
        placeholder={`Ask Grok about ${ws.orderRef}…`}
        context={{ page: "order", order: ws.orderRef }}
        suggestions={[`Where is ${ws.orderRef} now?`, `What happens next on ${ws.orderRef}?`]}
      />
    </article>
  );
}
