"use client";

import type { BenchResult } from "@agent/lib/bench/score";
import type { ShippingFile, ShippingListRow } from "@agent/lib/shipping/service";
import { useCallback, useEffect, useState } from "react";
import { PageHeader, Panel, Pill } from "@/components/kit";
import { Page } from "@/components/shell/app-shell";
import { rowPill } from "./format";
import { RoutePlanPanel } from "./route-plan";
import { BenchSummary, BenchTable, ShippingSteps, ShippingTable } from "./shipping-parts";

/**
 * The Shipping page: every shipped or invoiced order with threeway's answer beside ours, and a
 * detail panel with each step (plan, scan, dispatch, invoice, reconcile, case, Grok's proposal,
 * approval). Approval happens on the Sign-off page.
 */
export function ShippingView() {
  const [rows, setRows] = useState<ShippingListRow[]>();
  const [bench, setBench] = useState<BenchResult>();
  const [showBench, setShowBench] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [file, setFile] = useState<ShippingFile | null>(null);
  const [proposing, setProposing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadList = useCallback(() => {
    fetch("/api/shipping")
      .then((r) => r.json())
      .then((d: { orders: ShippingListRow[] }) => setRows(d.orders))
      .catch(() => setRows([]));
  }, []);

  const loadFile = useCallback((ref: string) => {
    fetch(`/api/shipping/${encodeURIComponent(ref)}`)
      .then((r) => r.json())
      .then((d: ShippingFile & { error?: string }) => setFile(d.error ? null : d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadList();
    fetch("/api/bench")
      .then((r) => r.json())
      .then((d: BenchResult) => setBench(d))
      .catch(() => {});
  }, [loadList]);

  const open = useCallback(
    (r: ShippingListRow) => {
      setSelected(r.order_ref);
      setFile(null);
      setMessage(null);
      loadFile(r.order_ref);
    },
    [loadFile],
  );

  const propose = useCallback(
    (caseId: string) => {
      setProposing(caseId);
      setMessage(null);
      fetch(`/api/shipping/cases/${encodeURIComponent(caseId)}/propose`, { method: "POST" })
        .then((r) => r.json())
        .then((d: { proposal?: { status: string } | null; error?: string }) => {
          if (d.error) setMessage(d.error);
          else if (!d.proposal) setMessage("Grok gave no valid proposal; the case waits for a person.");
          else if (d.proposal.status === "rejected") setMessage("Grok's proposal was rejected by the code checks.");
          else setMessage("Proposal checked by code; it waits in Sign-off for the employee in the case's role.");
        })
        .catch(() => setMessage("The request failed."))
        .finally(() => {
          setProposing(null);
          if (selected) loadFile(selected);
          loadList();
        });
    },
    [selected, loadFile, loadList],
  );

  const flagged = rows?.filter((r) => r.reconcile?.ours.attention).length ?? 0;
  const threewayMissed = rows?.filter((r) => r.reconcile?.threeway_wrong).length ?? 0;
  const current = rows?.find((r) => r.order_ref === selected);

  return (
    <Page>
      <PageHeader
        title="Shipping"
        sub={
          rows
            ? `${rows.length} orders in shipping, ${flagged} with a cause to follow up, ${threewayMissed} where threeway gives a different answer. The invoice bills what shipped; code names every cause; an employee approves every exception resolution.`
            : "Loading shipments…"
        }
      />
      <RoutePlanPanel onChanged={loadList} />
      {bench ? (
        <Panel
          title="Against the threeway baseline"
          aside={
            <button type="button" onClick={() => setShowBench((v) => !v)} className="text-ink-68 hover:text-ink">
              {showBench ? `Hide the ${bench.n} cases` : `Show the ${bench.n} cases`}
            </button>
          }
        >
          <BenchSummary res={bench} />
          {showBench ? (
            <div className="mt-4 space-y-2">
              <BenchTable res={bench} />
              <p className="text-[12px] text-ink-68">
                We wrote these cases and their answers ourselves, before running either matcher.
              </p>
            </div>
          ) : null}
        </Panel>
      ) : null}
      <div className={selected ? "grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_460px]" : "grid gap-5"}>
        <Panel title="Invoices">
          {rows ? <ShippingTable rows={rows} selected={selected} onSelect={open} /> : <div className="h-48 animate-pulse rounded-[12px] bg-hh-honeydew" />}
        </Panel>
        {selected ? (
          <Panel
            title={selected}
            aside={
              <span className="flex items-center gap-2">
                {current ? <Pill tone={rowPill(current).tone}>{rowPill(current).label}</Pill> : null}
                <button type="button" onClick={() => setSelected(undefined)} className="text-ink-68 hover:text-ink">
                  Close
                </button>
              </span>
            }
            className="lg:sticky lg:top-0"
          >
            {message ? <p className="mb-3 rounded-[10px] bg-hh-honeydew px-3 py-2 text-[13px] text-ink">{message}</p> : null}
            {file ? <ShippingSteps file={file} onPropose={propose} proposing={proposing} /> : <div className="h-64 animate-pulse rounded-[12px] bg-hh-honeydew" />}
          </Panel>
        ) : null}
      </div>
    </Page>
  );
}
