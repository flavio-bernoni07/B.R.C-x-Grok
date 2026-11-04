"use client";

import type { InboxFilter, InboxRow } from "@agent/lib/order/inbox";
import type { OrderWorkspace } from "@agent/lib/order/workspace";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { runOrderSimulation } from "@/app/(app)/orders/actions";
import { day, PageHeader, Panel, Pill, Segmented } from "@/components/kit";
import { GrokbotIcon } from "@/components/kit/icons";
import { Page } from "@/components/shell/app-shell";
import { OrderWorkspaceBody, STATUS_TONE } from "./workspace";

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

function InboxList({ rows, selected, onOpen }: { readonly rows: InboxRow[]; readonly selected?: string; readonly onOpen: (r: InboxRow) => void }) {
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.orderRef} className="border-hairline border-t first:border-t-0">
          <button
            type="button"
            onClick={() => onOpen(r)}
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
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The Orders page: an email-style inbox; a row (or /orders?ref=REF) opens the order workspace. */
export function OrdersView({ initialRows }: { readonly initialRows?: InboxRow[] } = {}) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selected = params.get("ref") ?? undefined;
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [q, setQ] = useState("");
  /** SSR seeds the inbox so the page is never stuck on Loading when client JS/HMR is flaky. */
  const [rows, setRows] = useState<InboxRow[] | undefined>(initialRows);
  const [listError, setListError] = useState(false);
  const [ws, setWs] = useState<OrderWorkspace | null>(null);
  const [wsState, setWsState] = useState<"idle" | "loading" | "error" | "missing">("idle");
  const [simMsg, setSimMsg] = useState<string>();
  const [listTick, setListTick] = useState(0);
  const skipFirstFetch = useRef(!!initialRows?.length || initialRows?.length === 0);

  useEffect(() => {
    const total = params.get("total");
    const waiting = params.get("waiting");
    if (params.get("sim") === "1" && total) {
      setSimMsg(`Desk cleared. Loaded ${total} orders · ${waiting ?? "?"} waiting in Actions.`);
      if (initialRows) setRows(initialRows);
    }
  }, [params, initialRows]);

  useEffect(() => {
    // First paint already has SSR rows for all/empty-q — don't blank the list waiting on client JS.
    if (skipFirstFetch.current && filter === "all" && !q.trim() && listTick === 0) {
      skipFirstFetch.current = false;
      return;
    }
    skipFirstFetch.current = false;
    let cancelled = false;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      if (cancelled) return;
      setListError(false);
      fetch(`/api/orders/inbox?filter=${filter}&q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
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
  }, [filter, q, listTick]);

  useEffect(() => {
    if (!selected) {
      setWs(null);
      setWsState("idle");
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
  }, [selected]);

  const go = useCallback((ref?: string) => router.replace(ref ? `${pathname}?ref=${encodeURIComponent(ref)}` : pathname, { scroll: false }), [router, pathname]);

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
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search order, retailer or product"
          className="h-[34px] w-[240px] rounded-full bg-white/85 px-3.5 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.1)] outline-none"
        />
        <Segmented options={FILTERS} value={filter} onChange={setFilter} />
      </PageHeader>
      {simMsg ? <p className="text-[13px] text-ink-78">{simMsg}</p> : null}
      <div className={selected ? "mt-4 grid items-start gap-5 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]" : "mt-4 grid gap-5"}>
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
            <InboxList rows={rows} selected={selected} onOpen={(r) => go(r.orderRef)} />
          ) : (
            <p className="py-6 text-center text-[14px] text-ink-68">{q || filter !== "all" ? "No orders match." : "No orders yet. Run the order simulation."}</p>
          )}
        </Panel>
        {selected ? (
          <Panel
            title={selected}
            aside={
              <button type="button" onClick={() => go()} className="text-ink-68 hover:text-ink">
                Close
              </button>
            }
            className="xl:sticky xl:top-0"
          >
            {ws ? (
              <OrderWorkspaceBody ws={ws} />
            ) : wsState === "missing" ? (
              <p className="text-[13px] text-ink-68">There is no saved order {selected}. It may still be a case waiting for a person in Actions.</p>
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
