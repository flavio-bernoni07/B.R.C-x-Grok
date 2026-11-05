"use client";

/**
 * Stock, three views behind the toolbar switch:
 * - Products: what we can promise today and the batch code suggests next (Mini ERP + forecast).
 * - Forecast: the next 8 weeks per product: projected stock with the suggested batches marked.
 * - Buying: paddy (the raw rice bought from farmers for the mill): price history and outlook, the silo
 *   stock with the suggested purchases as spikes, and "Propose", which opens a purchase case that a
 *   person approves in Sign-off. The price model is shown against "price stays the same", even when that wins.
 * The demand forecast runs on demo history: an estimate, labelled as one.
 */
import type { InventoryProduct } from "@agent/lib/core/inventory";
import type { ProjectionRow } from "@agent/lib/forecast/demand";
import { type PaddyWeek, type ProductionPlan, paddyPlan } from "@agent/lib/forecast/plan";
import type { PaddyPlan, PaddyRow } from "@agent/lib/purchasing/paddy";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Btn, Card, DataTable, Drawer, Kpi, Legend, PageHeader, Pill, type PillTone, Segmented, day, eur } from "@/components/kit";
import { LineChart } from "@/components/kit/chart";
import { whenShort } from "@/components/home/home-intro";
import { announceChange, Page } from "@/components/shell/app-shell";
import { SectionChat } from "@/components/shell/section-chat";

type View = "products" | "forecast" | "buying";
type Backorder = { order: string; qty: number; date: string | null };
type Projection = { gtin: string; itemCode: string; rows: ProjectionRow[]; suggestion: { short_from: string } | null; plan: ProductionPlan };
type InventoryData = { products: InventoryProduct[]; backorders?: Record<string, Backorder[]>; forecast: { label: string; projections: Projection[] } };
type PriceForecast = {
  variety: string;
  model: string;
  caveat: string;
  last_price: number;
  as_of: string;
  history: { date: string; price: number }[];
  forecast: { date: string; mean: number; lower: number; upper: number }[];
  forecast_end: { date: string; mean: number; change_pct: number };
  backtest: { mape_prophet_pct: number; mape_naive_pct: number; prophet_beats_naive: boolean };
  sources: { name: string }[];
};

const INK = "#203119";
const LINE = "#559646";
const ACCENT = "#bfff80";
const n0 = (v: number) => Math.round(v).toLocaleString("en-GB");
const k = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)));
const shortName = (n: string) => n.replace(/^Riso Scotti |^Scotti /, "");

function mondayOf(label: string): string {
  const [y, w] = label.split("-W").map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  jan4.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (w - 1) * 7);
  return jan4.toISOString().slice(0, 10);
}
/** "this week", "next week", or "w/c 30 Nov". */
const whenWeek = (label: string) => {
  const s = whenShort(label).replace(/^short /, "");
  return s.startsWith("from ") ? `w/c ${day(mondayOf(label))}` : s;
};

/** "How this is computed": folded under the chart, plain words, every figure from the record it names. */
function HowComputed({ children }: { readonly children: React.ReactNode }) {
  return (
    <details className="group mt-3 border-hairline border-t pt-3">
      <summary className="cursor-pointer list-none text-[13px] font-bold text-ink-78 hover:text-ink">
        How this is computed <span className="inline-block transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="mt-3 space-y-2.5 text-[14px] text-ink-78 leading-relaxed">{children}</div>
    </details>
  );
}

/** One product in the side panel: what is free, what is promised, the batches, who waits, what to make next. */
function ProductDetail({ inv, gtin }: { readonly inv: InventoryData; readonly gtin: string }) {
  const p = inv.products.find((x) => x.gtin === gtin);
  if (!p) return null;
  const pr = inv.forecast.projections.find((x) => x.gtin === gtin);
  const next = pr?.plan.batches[0];
  const waiting = inv.backorders?.[gtin] ?? [];
  const free = Math.max(p.released - p.reserved, 0);
  const batches = [...p.batches].sort((a, b) => ((a.availableFrom ?? "") < (b.availableFrom ?? "") ? -1 : 1));
  return (
    <div className="space-y-6 p-8">
      <div>
        <h2 className="pr-12 font-bold text-[24px] leading-tight tracking-[-0.03em]">{shortName(p.name)}</h2>
        <p className="mt-1 text-[13px] text-ink-68">
          {p.itemCode} · GTIN {p.gtin}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Kpi tone={free === 0 ? "strong" : "plain"} label="Available" value={n0(free)} />
        <Kpi label="Promised" value={n0(Math.min(p.reserved, p.released))} />
        <Kpi label="On hold" value={p.held ? n0(p.held) : "–"} />
      </div>
      {next ? (
        <Card title="Next batch to pack">
          <p className="text-[15px]">
            <b className="text-hh-lime">+{n0(next.qty)}</b> {whenWeek(next.week)}
          </p>
          <Link href={`/stock?view=forecast&gtin=${encodeURIComponent(gtin)}`} className="mt-2 inline-block font-bold text-[14px] text-ink-78 hover:text-ink">
            8-week forecast ›
          </Link>
        </Card>
      ) : null}
      {waiting.length ? (
        <Card title="Orders waiting for it">
          <ul className="space-y-1.5 text-[14px]">
            {waiting.map((b) => (
              <li key={b.order} className="flex justify-between gap-3">
                <Link href={`/orders?ref=${encodeURIComponent(b.order)}`} className="font-bold hover:underline">
                  {b.order}
                </Link>
                <span className="text-ink-68 tabular-nums">
                  {n0(b.qty)}
                  {b.date ? ` · ${day(b.date)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card title="Batches">
        {batches.length ? (
          <ul className="space-y-1.5 text-[14px]">
            {batches.map((b) => (
              <li key={b.batch} className="flex justify-between gap-3">
                <span>
                  <b>{b.batch}</b> <span className="text-ink-68">· {b.status}</span>
                </span>
                <span className="text-ink-68 tabular-nums">
                  {n0(b.qty)}
                  {b.availableFrom ? ` · ${day(b.availableFrom)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[14px] text-ink-68">No batch on record.</p>
        )}
      </Card>
    </div>
  );
}

function ProductsView({ inv, onOpen }: { readonly inv: InventoryData; readonly onOpen: (gtin: string) => void }) {
  const planOf = (g: string) => inv.forecast.projections.find((p) => p.gtin === g)?.plan;
  return (
    <DataTable
      onRowClick={(p) => onOpen(p.gtin)}
      rows={inv.products}
      rowKey={(p) => p.gtin}
      columns={[
        { key: "n", header: "Product", main: true, cell: (p) => shortName(p.name) },
        { key: "f", header: "Available", align: "right", cell: (p) => <b className="font-bold text-[16px] text-ink">{n0(Math.max(p.released - p.reserved, 0))}</b> },
        { key: "r", header: "Promised", align: "right", cell: (p) => n0(Math.min(p.reserved, p.released)) },
        { key: "h", header: "On hold", align: "right", cell: (p) => (p.held ? n0(p.held) : "–") },
        {
          key: "b",
          header: "Next batch",
          cell: (p) => {
            const next = p.batches.filter((b) => b.status === "planned" && b.availableFrom).sort((a, b) => (a.availableFrom! < b.availableFrom! ? -1 : 1))[0];
            const later = inv.backorders?.[p.gtin] ?? [];
            if (!next) return "–";
            return (
              <span>
                +{n0(next.qty)} · {day(next.availableFrom)}
                {later.length ? <span className="text-ink-50"> · for {later.map((b) => b.order).join(", ")}</span> : null}
              </span>
            );
          },
        },
        {
          key: "g",
          header: "Suggested batch",
          cell: (p) => {
            const b = planOf(p.gtin)?.batches[0];
            return b ? (
              <b className="font-bold text-ink">
                +{n0(b.qty)} <span className="font-medium text-ink-68">· {whenWeek(b.week)}</span>
              </b>
            ) : (
              "–"
            );
          },
        },
        {
          key: "s",
          header: "Status",
          cell: (p) => {
            const free = Math.max(p.released - p.reserved, 0);
            const [tone, text]: [PillTone, string] = free === 0 ? ["attention", "Not available"] : free < p.reserved * 0.2 ? ["quiet", "Running low"] : ["live", "Available"];
            return <Pill tone={tone}>{text}</Pill>;
          },
        },
      ]}
    />
  );
}

function ForecastView({ inv, initial }: { readonly inv: InventoryData; readonly initial?: string | null }) {
  const list = useMemo(() => [...inv.forecast.projections].sort((a, b) => (b.plan.batches[0]?.qty ?? 0) - (a.plan.batches[0]?.qty ?? 0)), [inv]);
  const [sel, setSel] = useState(initial && list.some((p) => p.gtin === initial) ? initial : (list[0]?.gtin ?? ""));
  const pr = list.find((p) => p.gtin === sel) ?? list[0];
  if (!pr) return null;
  const name = (g: string) => shortName(inv.products.find((p) => p.gtin === g)?.name ?? g);
  const [b1, b2] = pr.plan.batches;
  const demand = pr.plan.weeks.reduce((a, x) => a + x.demand, 0);
  return (
    <div className="space-y-6">
      <Card
        title={`${name(pr.gtin)}, next 8 weeks`}
        aside={
          <>
            <Legend color={LINE}>projected stock</Legend>
            <Legend color={INK}>suggested batch</Legend>
            <Segmented options={list.map((p) => ({ value: p.gtin, label: name(p.gtin).replace(/ \d.*$/, "") }))} value={pr.gtin} onChange={setSel} />
          </>
        }
      >
        <LineChart
          ariaLabel={`${name(pr.gtin)}: projected stock for 8 weeks with the suggested batches`}
          data={pr.plan.weeks.map((w) => ({ x: mondayOf(w.week), y: Math.max(w.with, 0) }))}
          markers={pr.plan.weeks.flatMap((w, i) => (w.suggested ? [{ index: i, label: `+${k(w.suggested)}` }] : []))}
          jumps={pr.plan.weeks.map((w) => (w.suggested ?? 0) + (w.production ?? 0))}
          xLabel={(d) => day(d)}
          tick={k}
          readout={(i) => {
            const w = pr.plan.weeks[i];
            return (
              <>
                <div>expected orders {n0(w.demand)}</div>
                {w.production ? <div>planned batch +{n0(w.production)}</div> : null}
                {w.suggested ? <div className="font-bold text-hh-flex">suggested batch +{n0(w.suggested)}</div> : null}
              </>
            );
          }}
        />
      </Card>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi tone={b1 ? "good" : "plain"} label={b1 ? `Pack ${whenWeek(b1.week)}` : "Next batch"} value={b1 ? `+${n0(b1.qty)}` : "None needed"} />
        <Kpi label={b2 ? `Then, ${whenWeek(b2.week)}` : "Then"} value={b2 ? `+${n0(b2.qty)}` : "–"} />
        <Kpi label="Expected orders, 8 weeks" value={n0(demand)} />
      </div>
      <HowComputed>
        <p>
          Each week, code takes the stock on hand and the batches already planned in the Mini ERP, and subtracts the confirmed orders not shipped and the expected
          orders (the demand forecast). When stock would fall under {pr.plan.safetyWeeks} week of expected orders, it suggests a batch that week, big enough for{" "}
          {pr.plan.coverWeeks} weeks of expected orders plus the safety week, in lots of {n0(pr.plan.lot)}. The line rises where a suggested batch lands.
        </p>
        <p>{inv.forecast.label} A suggestion for the production planner, never an order.</p>
      </HowComputed>
    </div>
  );
}

const CALL_TONE: Record<string, PillTone> = { "BUY NOW": "attention", WAIT: "quiet", "BUY AS USUAL": "live", "NOTHING TO BUY": "ok" };

function ProposeButton({ r }: { readonly r: PaddyRow }) {
  const [state, setState] = useState<{ busy?: boolean; caseId?: string }>({});
  if (state.caseId)
    return (
      <Link href={`/signoff?case=${encodeURIComponent(state.caseId)}`}>
        <Pill tone="attention">In Sign-off ›</Pill>
      </Link>
    );
  return (
    <Btn
      disabled={state.busy || r.suggested_t <= 0}
      onClick={() => {
        setState({ busy: true });
        fetch("/api/purchasing/propose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ variety: r.variety }) })
          .then((x) => x.json())
          .then((d: { case_id?: string }) => {
            setState(d.case_id ? { caseId: d.case_id } : {});
            announceChange();
          })
          .catch(() => setState({}));
      }}
    >
      Propose {r.suggested_t} t
    </Btn>
  );
}

function BuyingView({ paddy, initial }: { readonly paddy: PaddyPlan; readonly initial?: string | null }) {
  const known = initial && paddy.rows.some((row) => row.variety === initial) ? initial : paddy.rows[0]?.variety ?? "";
  const [sel, setSel] = useState(known);
  useEffect(() => {
    if (initial && paddy.rows.some((row) => row.variety === initial)) setSel(initial);
  }, [initial, paddy.rows]);
  const r = paddy.rows.find((x) => x.variety === sel) ?? paddy.rows[0];
  const [price, setPrice] = useState<PriceForecast | null>();
  useEffect(() => {
    if (!r) return;
    setPrice(undefined);
    fetch(`/api/rice/forecast?variety=${encodeURIComponent(r.variety)}&horizon=8`)
      .then((x) => (x.ok ? x.json() : Promise.reject()))
      .then(setPrice)
      .catch(() => setPrice(null));
  }, [r]);
  const weeks = useMemo(() => (r ? paddyPlan(r, { start: paddy.as_of, weeks: 12 }) : []), [r, paddy.as_of]);
  if (!r) return null;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[15px] text-ink-78">Paddy is the raw rice bought from farmers for the mill. How much to buy, and when.</p>
        <Segmented options={paddy.rows.map((x) => ({ value: x.variety, label: x.variety }))} value={r.variety} onChange={setSel} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Kpi label="Buy now" value={`${r.suggested_t} t`} />
        <Kpi label="Cost, about" value={r.spend_eur != null ? eur(r.spend_eur, 0) : "–"} />
        <Kpi label="Silos cover" value={`${r.cover_weeks ?? "–"} of ${r.target_weeks} wk`} />
        <Kpi label={r.price ? `Price by ${day(r.price.forecast_date)}` : "Price outlook"} value={r.price ? `${r.price.change_pct > 0 ? "+" : ""}${r.price.change_pct.toFixed(1)}%` : "–"} />
      </div>
      <Card
        title={`${r.variety} paddy price, €/t`}
        aside={
          <>
            <Legend color={LINE}>price</Legend>
            <Legend color={ACCENT}>forecast, 80% band</Legend>
          </>
        }
      >
        {price ? (
          <LineChart
            ariaLabel={`${r.variety} paddy price, last 26 weeks and the 8-week forecast`}
            data={price.history.slice(-26).map((h) => ({ x: h.date, y: h.price }))}
            forecast={price.forecast.map((f) => ({ x: f.date, y: f.mean }))}
            band={price.forecast.map((f) => ({ lo: f.lower, hi: f.upper }))}
            min={Math.floor((Math.min(...price.history.slice(-26).map((h) => h.price), ...price.forecast.map((f) => f.lower)) * 0.92) / 50) * 50}
            format={(v) => `€${Math.round(v)}/t`}
            tick={(v) => `€${Math.round(v)}`}
            xLabel={(d) => day(d)}
            readout={(i) => {
              const f = price.forecast[i - Math.min(price.history.length, 26)];
              return f ? <div>80% between €{Math.round(f.lower)} and €{Math.round(f.upper)}</div> : null;
            }}
          />
        ) : price === null ? (
          <p className="text-[14px] text-ink-68">No price forecast for {r.variety}.</p>
        ) : (
          <div className="h-[200px] animate-pulse rounded-[12px] bg-hh-honeydew" />
        )}
        {price ? (
          <HowComputed>
            <p>
              Price: the weekly price of Italian {r.variety} paddy in €/t, from the {price.sources.map((x) => x.name).join(", ")}. Last price €{Math.round(price.last_price)} on{" "}
              {day(price.as_of)}.
            </p>
            <p>
              Forecast: {price.model}. Backtested over past weeks: average error {price.backtest.mape_prophet_pct}%, against {price.backtest.mape_naive_pct}% for &quot;the price stays
              the same&quot;{price.backtest.prophet_beats_naive ? ", so the model is better." : ", so the simple baseline is better and the call stays as usual."}
            </p>
            <p>{price.caveat}</p>
          </HowComputed>
        ) : null}
      </Card>
      <Card
        title={`${r.variety} paddy in the silos, t`}
        aside={
          <>
            <Legend color={LINE}>paddy on hand</Legend>
            <Legend color={INK}>suggested purchase</Legend>
          </>
        }
      >
        <LineChart
          ariaLabel={`${r.variety} paddy in the silos over 12 weeks, with the suggested purchases`}
          data={weeks.map((w) => ({ x: w.date, y: Math.max(w.stock, 0) }))}
          markers={weeks.flatMap((w, i) => (w.buy ? [{ index: i, label: `+${Math.round(w.buy)} t` }] : []))}
          jumps={weeks.map((w) => w.buy)}
          format={(v) => `${Math.round(v)} t`}
          xLabel={(d) => day(d)}
          readout={(i) => (
            <>
              <div>used this week {weeks[i].use} t</div>
              {weeks[i].buy ? <div className="font-bold text-hh-flex">suggested purchase +{weeks[i].buy} t</div> : null}
            </>
          )}
        />
        <HowComputed>
          <ul className="space-y-1">
            {r.steps.map((st) => (
              <li key={st.step} className="flex justify-between gap-4 border-hairline border-b pb-1">
                <span title={st.source}>{st.step}</span>
                <b className="shrink-0 text-ink tabular-nums">{st.value}</b>
              </li>
            ))}
          </ul>
          <p>
            The line starts from paddy on hand ({r.on_hand_t} t, silos plus contracted not delivered) and falls by {r.weekly_use_t} t a week. The first purchase is the
            quantity above; later ones appear when cover would drop under 4 weeks, back up to the {r.target_weeks}-week target.
          </p>
        </HowComputed>
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <Pill tone={CALL_TONE[r.call] ?? "quiet"}>{r.call.charAt(0) + r.call.slice(1).toLowerCase()}</Pill>
          {r.price && !r.price.beats_naive ? (
            <span className="text-[13px] text-ink-68">
              Price model error {r.price.mape_prophet_pct}% against {r.price.mape_naive_pct}% for &quot;price stays the same&quot;: the baseline wins, so the call stays as usual.
            </span>
          ) : null}
        </span>
        <ProposeButton r={r} />
      </div>
    </div>
  );
}

export function StockPage() {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get("view") === "paddy" ? "buying" : params.get("view");
  const view = (["products", "forecast", "buying"].includes(raw ?? "") ? raw : "products") as View;
  const [inv, setInv] = useState<InventoryData>();
  const [paddy, setPaddy] = useState<PaddyPlan>();
  useEffect(() => {
    fetch("/api/inventory")
      .then((r) => r.json())
      .then(setInv)
      .catch(() => {});
    fetch("/api/purchasing")
      .then((r) => r.json())
      .then(setPaddy)
      .catch(() => {});
  }, []);

  const loading = <div className="h-72 animate-pulse rounded-[16px] bg-hh-honeydew" />;
  const product = params.get("product");
  return (
    <>
    <Page>
      <PageHeader title="Stock">
        <Segmented
          options={[
            { value: "products", label: "Products" },
            { value: "forecast", label: "Forecast" },
            { value: "buying", label: "Buying" },
          ]}
          value={view}
          onChange={(v) => router.replace(v === "products" ? "/stock" : `/stock?view=${v}`, { scroll: false })}
        />
      </PageHeader>
      {view === "products" ? inv ? <ProductsView inv={inv} onOpen={(g) => router.replace(`/stock?product=${encodeURIComponent(g)}`, { scroll: false })} /> : loading : null}
      {view === "forecast" ? inv ? <ForecastView inv={inv} initial={params.get("gtin")} /> : loading : null}
      {view === "buying" ? paddy ? <BuyingView paddy={paddy} initial={params.get("variety")} /> : loading : null}
      <SectionChat
        placeholder="Ask Grok about stock, batches or paddy…"
        context={{ page: "stock", view }}
        suggestions={["Which products run short next?", "When should we buy Carnaroli paddy?"]}
      />
    </Page>
    <Drawer open={!!product && view === "products"} onClose={() => router.replace("/stock", { scroll: false })}>
      {inv && product ? <ProductDetail inv={inv} gtin={product} /> : null}
    </Drawer>
    </>
  );
}
