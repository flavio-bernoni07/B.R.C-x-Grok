"use client";

/**
 * Home: the desk as widgets, the launch film's way (KPI cards, cards with a title and content,
 * no paragraphs). Colour carries the importance: the one number that asks for a person is the
 * dark card, money saved and quantities to make or buy are Flex Green, a shortage is red. Then a
 * to-do list of what waits for a person (flagged) and what was just decided (checked); the
 * products that run short with the batch to make; the next day's trucks on a small map; the
 * paddy cover with what to buy. Every figure is a field of the APIs it reads; decisions happen
 * only in Sign-off.
 */
import { caseNextStep, caseRole } from "@agent/lib/core/case-view";
import type { Signoff } from "@agent/lib/core/erp";
import type { InventoryProduct } from "@agent/lib/core/inventory";
import type { OverviewSnapshot } from "@agent/lib/core/overview";
import type { ProductionPlan } from "@agent/lib/forecast/plan";
import type { PaddyPlan } from "@agent/lib/purchasing/paddy";
import type { DispatchPlan } from "@agent/lib/shipping/routes";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { Kpi, Meter, day, eur, personFor } from "@/components/kit";
import { GrokMark } from "@/components/kit/icons";
import { RouteMap, TRUCK_COLORS, TruckGlyph } from "@/components/shipping/route-map";
import { cn } from "@/lib/utils";

type Projection = { gtin: string; suggestion: { short_from: string } | null; plan?: ProductionPlan };
type Inventory = { products: InventoryProduct[]; forecast: { projections: Projection[] } };
type Routes = { ship_date: string; plan_case: Signoff | null; preview: DispatchPlan | null };

const n0 = (v: number) => Math.round(v).toLocaleString("en-GB");
const shortName = (n: string) => n.replace(/^Riso Scotti |^Scotti /, "");

/** Monday of an ISO week label like 2026-W45. */
function mondayOf(label: string): Date {
  const [y, w] = label.split("-W").map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (w - 1) * 7);
  return monday;
}

const weeksFromNow = (label: string) => {
  const now = new Date();
  const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
  return Math.round((mondayOf(label).getTime() - thisMonday.getTime()) / (7 * 864e5));
};

/** "short this week", "short next week" or "short from 16 Nov", instead of an ISO week number. */
export function whenShort(label: string): string {
  const w = weeksFromNow(label);
  if (w <= 0) return "short this week";
  if (w === 1) return "short next week";
  return `short from ${day(mondayOf(label).toISOString().slice(0, 10))}`;
}

function useJson<T>(url: string): T | null | undefined {
  const [v, setV] = useState<T | null>();
  useEffect(() => {
    let live = true;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: T) => live && setV(d))
      .catch(() => live && setV(null));
    return () => {
      live = false;
    };
  }, [url]);
  return v;
}

const byUrgency = (cases: Signoff[]) => [...cases].sort((a, b) => Number(b.row === "order") - Number(a.row === "order"));
const grokUnsure = (c: Signoff) => (c.reasons ?? []).some((r) => /unsure|confidence/i.test(r));
const shortTitle = (c: Signoff) => (c.title ?? c.kind).replace(/:.*$/, "");
/**
 * Packs are made by milling and packing paddy from the silos; paddy is bought from farmers. The
 * tonnes of paddy a batch of packs uses: pack weight from the name, ÷ the milling yield.
 */
const MILLING_YIELD = 0.7; // agent/lib/purchasing/paddy.ts MILLING_YIELD (a demo value); that module is server-only

function paddyFor(name: string, packs: number): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*(kg|g)\b/i.exec(name);
  if (!m) return null;
  const kg = Number(m[1].replace(",", ".")) * (m[2].toLowerCase() === "g" ? 0.001 : 1);
  return Math.round((packs * kg) / 1000 / MILLING_YIELD);
}

/** A claim Grok would turn down: a person checks it (same rule as the Sign-off card). */
const humanCheck = (c: Signoff) => c.row === "dispute" && (c.proposal as { verdict?: { decision?: string } } | null)?.verdict?.decision === "reject";
/** Orders and trucks wait on these: the rest can wait a day. */
const blocking = (c: Signoff) => c.row === "order" || c.row === "shipping";

/** The chips above the input: questions about what Home shows. */
export function useHomeSuggestions(): string[] {
  const signoffs = useJson<{ pending: Signoff[] }>("/api/signoffs");
  const inbox = useJson<{ rows: { orderRef: string; split?: unknown }[] }>("/api/orders/inbox?filter=all");
  const paddy = useJson<PaddyPlan>("/api/purchasing");
  const out: string[] = [];
  const c = signoffs?.pending?.length ? byUrgency(signoffs.pending)[0] : undefined;
  if (c) out.push(grokUnsure(c) && c.subjectRef ? `Why is Grok unsure on ${c.subjectRef}?` : `What to check on ${c.subjectRef ?? c.caseId}?`);
  const split = inbox?.rows.find((r) => r.split);
  if (split) out.push(`Why did Grok split ${split.orderRef}?`);
  const buy = [...(paddy?.rows ?? [])].filter((r) => r.suggested_t > 0).sort((a, b) => (a.cover_weeks ?? 99) - (b.cover_weeks ?? 99))[0];
  if (buy) out.push(`Why buy ${buy.suggested_t} t more ${buy.variety} paddy now?`);
  return out;
}

/** A widget: the film's card, a title (and its link) on top, content below. `scroll` keeps a long list inside the card. */
function Widget({ title, href, aside, className, scroll, children }: { readonly title: string; readonly href?: string; readonly aside?: ReactNode; readonly className?: string; readonly scroll?: boolean; readonly children: ReactNode }) {
  return (
    <section className={cn("flex min-w-0 flex-col rounded-[16px] bg-hh-seasalt p-5 shadow-[inset_0_0_0_1.5px_rgb(32_49_25/0.09)]", className)}>
      <header className="mb-4 flex shrink-0 items-center justify-between gap-3">
        {href ? (
          <Link href={href} className="font-bold text-[17px] tracking-[-0.02em] hover:underline hover:underline-offset-4">
            {title}
          </Link>
        ) : (
          <h2 className="font-bold text-[17px] tracking-[-0.02em]">{title}</h2>
        )}
        {aside ? <div className="flex items-center gap-2 text-[13px] text-ink-78">{aside}</div> : null}
      </header>
      {scroll ? <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain">{children}</div> : children}
    </section>
  );
}

/** Flex Green capsule for a quantity to make or buy: the answer to a shortage. */
const Answer = ({ children }: { readonly children: ReactNode }) => (
  <span className="inline-flex h-[26px] shrink-0 items-center whitespace-nowrap rounded-full bg-hh-flex px-2.5 font-bold text-[13px] text-hh-dark tabular-nums shadow-[inset_0_0_0_1px_rgb(32_49_25/0.1)]">{children}</span>
);

function TodoItem({ c, done }: { readonly c: Signoff; readonly done?: boolean }) {
  const who = personFor(done ? (c.decidedBy ?? caseRole(c)) : caseRole(c));
  const check = !done && humanCheck(c);
  const urgent = !done && blocking(c);
  return (
    <li>
      <Link href={`/signoff?case=${encodeURIComponent(c.caseId)}`} className="-mx-2 flex items-center gap-3 rounded-[12px] px-2 py-2.5 transition-colors hover:bg-white">
        <span
          className={cn(
            "flex size-[20px] shrink-0 items-center justify-center self-start rounded-full mt-0.5",
            done ? "bg-hh-dark text-hh-flex" : urgent ? "shadow-[inset_0_0_0_2px_#d2473b]" : "shadow-[inset_0_0_0_1.8px_rgb(32_49_25/0.35)]",
          )}
        >
          {done ? (
            <svg viewBox="0 0 20 20" className="size-[12px]" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 10.5l3.2 3.2L15 7" />
            </svg>
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <b className={cn("line-clamp-2 block text-[15px] leading-snug tracking-[-0.01em]", done && "font-medium text-ink-50 line-through decoration-ink-50/50")}>{shortTitle(c)}</b>
          <span className="mt-1 flex items-center gap-1.5 text-[13px] text-ink-68">
            {done ? (
              <>Done by {who?.name ?? c.decidedBy?.replace(/,.*$/, "") ?? "a person"}</>
            ) : check ? (
              <span className="rounded-full bg-st-wrong/[0.09] px-2 py-px font-bold text-[12px] text-st-wrong">Human check</span>
            ) : (
              <>
                {grokUnsure(c) ? <GrokMark size={14} title="Grok proposed, unsure" /> : null}
                <span className="truncate">{caseNextStep(c)}</span>
              </>
            )}
          </span>
        </span>
        {who ? (
          // biome-ignore lint/performance/noImgElement: tiny local portrait
          <img src={who.photo} alt={who.name} title={`${who.name}, ${who.role}`} className={cn("size-[30px] shrink-0 rounded-full object-cover ring-1 ring-hairline", done && "opacity-50 grayscale")} />
        ) : (
          <span className="shrink-0 text-[12px] text-ink-68">{caseRole(c)}</span>
        )}
      </Link>
    </li>
  );
}

export function HomeIntro() {
  const signoffs = useJson<{ pending: Signoff[]; all?: Signoff[] }>("/api/signoffs?all=1");
  const overview = useJson<OverviewSnapshot>("/api/overview");
  const inv = useJson<Inventory>("/api/inventory");
  const paddy = useJson<PaddyPlan>("/api/purchasing");
  const routes = useJson<Routes>("/api/shipping/routes");

  const pending = signoffs?.pending ? byUrgency(signoffs.pending) : undefined;
  const decided = (signoffs?.all ?? []).filter((s) => s.status !== "pending" && s.decidedBy).slice(0, 3);
  const c = overview?.counts;

  // Only what runs short, each with the batch code suggests making.
  const short = (inv?.products ?? [])
    .map((p) => {
      const pr = inv?.forecast.projections.find((x) => x.gtin === p.gtin);
      return { p, s: pr?.suggestion?.short_from ?? null, batch: pr?.plan?.batches[0] };
    })
    .filter((x) => x.s || x.p.atp === 0)
    .slice(0, 4);
  const paddyRows = [...(paddy?.rows ?? [])].sort((a, b) => (a.cover_weeks ?? 99) - (b.cover_weeks ?? 99));

  const so = routes?.plan_case;
  const plan = so && so.status !== "rejected" ? (so.proposal as { plan?: DispatchPlan }).plan : routes?.preview;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Kpi size="sm" tone="strong" label="Waiting for you" value={c ? n0(c.signoffsWaiting) : "–"} href="/signoff" />
        <Kpi size="sm" label="Orders" value={c ? n0(c.orders) : "–"} href="/orders" />
        <Kpi size="sm" label="Invoiced, net" value={c ? eur(c.invoicedNet, 0) : "–"} href="/shipping?view=invoices" />
        <Kpi size="sm" label="Claims" value={c ? n0(c.claims) : "–"} href="/disputes" />
      </div>

      {/* The trucks card sets the row. The other two fill it, so nothing stretches the map. */}
      <div className="grid items-stretch gap-4 lg:grid-cols-3">
        <div className="relative">
        <Widget
          title="To do"
          href="/signoff"
          scroll
          className="overflow-hidden lg:absolute lg:inset-0"
          aside={
            pending?.length ? (
              <span className="tabular-nums">
                <b className="text-[15px] text-st-wrong">{pending.length}</b> waiting
              </span>
            ) : undefined
          }
        >
          {pending == null ? (
            <div className="h-24 animate-pulse rounded-[12px] bg-hh-honeydew" />
          ) : (
            <ul>
              {pending.map((p) => (
                <TodoItem key={p.caseId} c={p} />
              ))}
              {decided.map((p) => (
                <TodoItem key={p.caseId} c={p} done />
              ))}
              {!pending.length && !decided.length ? <li className="py-2 text-[15px] text-ink-68">Nothing to do.</li> : null}
            </ul>
          )}
        </Widget>
        </div>

        <div className="relative">
        <Widget
          title="Packs"
          href="/stock"
          scroll
          className="overflow-hidden lg:absolute lg:inset-0"
          aside={
            short.length ? (
              <span className="font-bold text-st-wrong tabular-nums">
                {short.length}
                {short.some(({ s }) => s && weeksFromNow(s) > 0) ? " to pack" : " this week"}
              </span>
            ) : undefined
          }
        >
          {!inv ? (
            <div className="h-24 animate-pulse rounded-[12px] bg-hh-honeydew" />
          ) : short.length ? (
            <ul>
              {short.map(({ p, s, batch }) => {
                const paddyT = batch ? paddyFor(p.name, batch.qty) : null;
                const w = s ? weeksFromNow(s) : 0;
                const timing = p.atp === 0 ? "Not available" : w > 1 ? `from ${day(mondayOf(s!).toISOString().slice(0, 10))}` : w === 1 ? "next week" : null;
                return (
                  <li key={p.gtin} className="flex items-center justify-between gap-2 border-hairline border-t py-1.5 first:border-t-0 first:pt-0">
                    <span className="flex min-w-0 items-baseline gap-1 text-[15px] tracking-[-0.01em]">
                      <b className="truncate">{shortName(p.name)}</b>
                      {timing ? <b className="shrink-0 text-st-wrong">{timing}</b> : null}
                      {paddyT ? (
                        <span className="shrink-0 text-[11px] text-ink-68 tabular-nums" title={`uses ${paddyT} t paddy`}>
                          {paddyT} t paddy
                        </span>
                      ) : null}
                    </span>
                    {batch ? <Answer>Pack {n0(batch.qty)}</Answer> : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[15px] text-ink-68">Nothing runs short in the next 8 weeks.</p>
          )}
          <div className="mt-2 border-hairline border-t pt-2">
            <header className="mb-1.5 flex items-center justify-between gap-3">
              <Link href="/stock?view=buying" className="font-bold text-[17px] tracking-[-0.02em] hover:underline hover:underline-offset-4">
                Paddy in the silos
              </Link>
            </header>
            {!paddy ? (
              <div className="h-24 animate-pulse rounded-[12px] bg-hh-honeydew" />
            ) : (
              <ul className="space-y-1.5">
                {paddyRows.map((r) => {
                  const low = (r.cover_weeks ?? 0) < r.target_weeks * 0.6;
                  return (
                    <li key={r.variety}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-[15px] tracking-[-0.01em]">
                          <b>{r.variety}</b>
                          <span className={cn("text-[13px] tabular-nums", low ? "font-bold text-st-wrong" : "text-ink-68")}>
                            {" "}
                            {Math.round(r.cover_weeks ?? 0)} of {r.target_weeks} weeks
                          </span>
                        </span>
                        {r.suggested_t > 0 ? <Answer>Buy {r.suggested_t} t</Answer> : null}
                      </div>
                      <Meter className="mt-1" value={r.cover_weeks ?? 0} max={r.target_weeks} tone={low ? "wrong" : "ok"} />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Widget>
        </div>

        <Widget title={routes ? `Trucks, ${day(routes.ship_date)}` : "Trucks"} href="/shipping">
          {!routes ? (
            <div className="h-48 animate-pulse rounded-[12px] bg-hh-honeydew" />
          ) : plan ? (
            <Link href="/shipping" className="block">
              <div className="overflow-hidden rounded-[12px]">
                <RouteMap plan={plan} mode="plan" hideBaseline compact className="max-h-[118px]" />
              </div>
              <ul className="mt-2 space-y-1.5">
                {plan.routes.map((r, i) => (
                  <li key={r.truck_id ?? i} className="flex items-center gap-2.5 text-[13px]">
                    <TruckGlyph color={TRUCK_COLORS[i % TRUCK_COLORS.length]} size={20} />
                    <span className="min-w-0 flex-1 truncate">{[...new Set(r.stops.map((s) => s.retailer ?? s.point))].join(", ")}</span>
                    <span className="shrink-0 text-ink-68 tabular-nums">{n0(r.km)} km</span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex items-center justify-between gap-2 border-hairline border-t pt-2">
                <span className="text-[13px] text-ink-78 tabular-nums">
                  {plan.plan.trucks} trucks instead of {plan.baseline.trucks}
                </span>
                <Answer>{eur(plan.saving.fuel_eur, 0)} saved</Answer>
              </div>
            </Link>
          ) : (
            <p className="text-[15px] text-ink-68">No orders are waiting for a truck.</p>
          )}
        </Widget>
      </div>
    </div>
  );
}
