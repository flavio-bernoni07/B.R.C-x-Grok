"use client";

import type { InboxFilter, InboxRow } from "@agent/lib/order/inbox";
import type { OrderWorkspace } from "@agent/lib/order/workspace";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { runOrderSimulation } from "@/app/(app)/orders/actions";
import { day, PageHeader, Panel, Pill } from "@/components/kit";
import { GrokbotIcon } from "@/components/kit/icons";
import { cn } from "@/lib/utils";
import { Page } from "@/components/shell/app-shell";
import { OrderWorkspaceBody, STATUS_TONE } from "./workspace";

/** Plain <a> — full page load so ?ref= SSR opens the workspace without relying on next/link hydration. */

function SimulateSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-[34px] rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window disabled:opacity-40"
    >
      {pending ? "Running simulation…" : "Run order simulation"}
    </button>
  );
}

const FILTERS: { value: InboxFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "attention", label: "Needs attention" },
  { value: "progress", label: "In progress" },
  { value: "completed", label: "Completed" },
];

function ordersHref(opts: { ref?: string; filter?: InboxFilter; q?: string }) {
  const q = new URLSearchParams();
  if (opts.filter && opts.filter !== "all") q.set("filter", opts.filter);
  if (opts.q?.trim()) q.set("q", opts.q.trim());
  if (opts.ref) q.set("ref", opts.ref);
  const s = q.toString();
  return s ? `/orders?${s}` : "/orders";
}

function InboxList({
  rows,
  selected,
  filter,
  q,
}: {
  readonly rows: InboxRow[];
  readonly selected?: string;
  readonly filter: InboxFilter;
  readonly q: string;
}) {
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.orderRef} className="border-hairline border-t first:border-t-0">
          <a
            href={ordersHref({ ref: r.orderRef, filter, q })}
            className={`grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 px-1 py-2.5 text-left transition-colors hover:bg-hh-honeydew/60 ${selected === r.orderRef ? "bg-hh-honeydew" : ""}`}
          >
            <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-[14px]">
              {r.grokUsed ? <GrokbotIcon size={14} title="Grokbot worked on this order" /> : null}
              <span className="truncate">
                <b className="tracking-[-0.02em]">{r.retailer}</b> <span className="text-ink-68">{r.orderRef}</span>
              </span>
            </span>
            <span className="flex items-center gap-2 justify-self-end">
              <span className="text-[12px] text-ink-68">{r.deliveryDate ? day(r.deliveryDate) : "no date"}</span>
              <Pill tone={STATUS_TONE[r.status]}>{r.statusLabel}</Pill>
            </span>
            <span className="truncate text-[13px] text-ink-78">{r.description}</span>
            <span className="flex flex-wrap justify-end gap-1">
              {r.agents.map((a) => (
                <span key={a} className="rounded-md bg-hh-honeydew px-1.5 py-0.5 text-[11px] text-ink-78">
                  {a}
                </span>
              ))}
            </span>
            <span className="col-span-2 truncate text-[13px] text-ink-68">{r.statusLine}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Filter chips as plain anchors — full navigation + SSR without next/link. */
function FilterTabs({ filter, q }: { readonly filter: InboxFilter; readonly q: string }) {
  return (
    <div className="inline-flex h-[34px] items-center gap-0.5 rounded-full bg-white/85 p-1 shadow-[inset_0_1.5px_0.5px_rgb(255_255_255/0.95),inset_0_0_0_1px_rgb(32_49_25/0.07),0_10px_26px_-16px_rgb(32_49_25/0.35),0_2px_6px_rgb(32_49_25/0.06)]">
      {FILTERS.map((o) => (
        <a
          key={o.value}
          href={ordersHref({ filter: o.value, q })}
          className={cn(
            "inline-flex h-[26px] items-center rounded-full px-3 text-[13px] transition-colors",
            o.value === filter ? "bg-hh-dark font-bold text-hh-window" : "text-ink-68 hover:text-ink",
          )}
        >
          {o.label}
        </a>
      ))}
    </div>
  );
}

/** The Orders page: an email-style inbox; a row (or /orders?ref=REF) opens the order workspace. */
export function OrdersView({
  initialRows,
  simBanner,
  initialFilter = "all",
  initialQ = "",
  initialWorkspace,
  initialWorkspaceMissing = false,
}: {
  readonly initialRows?: InboxRow[];
  readonly simBanner?: string;
  readonly initialFilter?: InboxFilter;
  readonly initialQ?: string;
  readonly initialWorkspace?: OrderWorkspace | null;
  readonly initialWorkspaceMissing?: boolean;
} = {}) {
  const params = useSearchParams();
  const selected = params.get("ref") ?? undefined;
  const filter = (params.get("filter") as InboxFilter | null) ?? initialFilter;
  const qParam = params.get("q") ?? initialQ;
  const [qDraft, setQDraft] = useState(qParam);
  const [rows, setRows] = useState<InboxRow[] | undefined>(initialRows);
  const [listError, setListError] = useState(false);
  const [ws, setWs] = useState<OrderWorkspace | null>(() => initialWorkspace ?? null);
  const [wsState, setWsState] = useState<"idle" | "loading" | "error" | "missing">(() =>
    initialWorkspace ? "idle" : initialWorkspaceMissing ? "missing" : selected ? "loading" : "idle",
  );
  const [listTick, setListTick] = useState(0);
  const skipFirstFetch = useRef(!!initialRows);
  const simMsg = simBanner;

  useEffect(() => {
    setQDraft(qParam);
  }, [qParam]);

  useEffect(() => {
    if (initialRows) setRows(initialRows);
  }, [initialRows]);

  useEffect(() => {
    if (skipFirstFetch.current && filter === initialFilter && qParam === initialQ && listTick === 0) {
      skipFirstFetch.current = false;
      return;
    }
    skipFirstFetch.current = false;
    let cancelled = false;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      if (cancelled) return;
      setListError(false);
      fetch(`/api/orders/inbox?filter=${filter}&q=${encodeURIComponent(qParam)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
        .then((d: { rows?: InboxRow[] }) => {
          if (cancelled) return;
          setRows(Array.isArray(d.rows) ? d.rows : []);
          setListError(false);
        })
        .catch((e: Error) => {
          if (cancelled || e.name === "AbortError") return;
          setListError(true);
        });
    }, 50);
    return () => {
      cancelled = true;
      clearTimeout(t);
      ctrl.abort();
    };
  }, [filter, qParam, listTick, initialFilter, initialQ]);

  useEffect(() => {
    if (!selected) {
      setWs(null);
      setWsState("idle");
      return;
    }
    if (initialWorkspace && initialWorkspace.orderRef === selected) {
      setWs(initialWorkspace);
      setWsState("idle");
      return;
    }
    if (initialWorkspaceMissing && !initialWorkspace) {
      setWs(null);
      setWsState("missing");
      return;
    }
    setWs(null);
    setWsState("loading");
    fetch(`/api/orders/${encodeURIComponent(selected)}/workspace`)
      .then((r) => (r.status === 404 ? { missing: true } : r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d: { workspace?: OrderWorkspace; missing?: boolean }) => {
        if (d.workspace) {
          setWs(d.workspace);
          setWsState("idle");
        } else setWsState("missing");
      })
      .catch(() => setWsState("error"));
  }, [selected, initialWorkspace, initialWorkspaceMissing]);

  const attention = rows?.filter((r) => r.status === "attention").length ?? 0;

  return (
    <Page>
      <PageHeader
        title="Orders"
        sub={
          listError
            ? "Could not load orders. Use Retry or Run order simulation."
            : rows
              ? `${rows.length} orders shown, ${attention} need attention. Agents do the steps; a person approves what needs a person.`
              : "Loading orders…"
        }
      >
        <form action={runOrderSimulation}>
          <SimulateSubmitButton />
        </form>
        <form action="/orders" method="get" className="contents">
          {filter !== "all" ? <input type="hidden" name="filter" value={filter} /> : null}
          {selected ? <input type="hidden" name="ref" value={selected} /> : null}
          <input
            name="q"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            placeholder="Search order, retailer or product"
            className="h-[34px] w-[240px] rounded-full bg-white/85 px-3.5 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.1)] outline-none"
          />
        </form>
        <FilterTabs filter={filter} q={qParam} />
      </PageHeader>
      {simMsg ? <p className="rounded-[10px] bg-st-ok px-3 py-2 text-[13px] text-st-ok-ink">{simMsg}</p> : null}
      <div className={selected ? "mt-4 grid items-start gap-5 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]" : "mt-4 grid gap-5"}>
        <Panel title="Inbox">
          {listError && !rows?.length ? (
            <div className="space-y-3 py-6 text-center">
              <p className="text-[14px] text-ink-68">The orders could not be loaded.</p>
              <button
                type="button"
                onClick={() => {
                  setListError(false);
                  setRows(undefined);
                  setListTick((n) => n + 1);
                }}
                className="h-8 rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window"
              >
                Retry
              </button>
            </div>
          ) : !rows ? (
            <div className="h-48 animate-pulse rounded-[12px] bg-hh-honeydew" />
          ) : rows.length ? (
            <InboxList rows={rows} selected={selected} filter={filter} q={qParam} />
          ) : (
            <p className="py-6 text-center text-[14px] text-ink-68">
              {qParam || filter !== "all" ? "No orders match." : "No orders yet. Run the order simulation."}
            </p>
          )}
        </Panel>
        {selected ? (
          <Panel
            title={
              <span className="inline-flex items-center gap-2">
                {ws?.details.grokChanges.length ? <GrokbotIcon size={16} title="Grokbot worked on this order" /> : null}
                {selected}
              </span>
            }
            aside={
              <a href={ordersHref({ filter, q: qParam })} className="text-ink-68 hover:text-ink">
                Close
              </a>
            }
            className="lg:sticky lg:top-0"
          >
            {ws ? (
              <OrderWorkspaceBody ws={ws} />
            ) : wsState === "missing" ? (
              <p className="text-[13px] text-ink-68">
                There is no saved order {selected}. It may still be a case waiting for a person in Actions.
              </p>
            ) : wsState === "error" ? (
              <p className="text-[13px] text-ink-68">This order could not be loaded. Try again in a moment.</p>
            ) : (
              <div className="h-64 animate-pulse rounded-[12px] bg-hh-honeydew" />
            )}
          </Panel>
        ) : null}
      </div>
    </Page>
  );
}
