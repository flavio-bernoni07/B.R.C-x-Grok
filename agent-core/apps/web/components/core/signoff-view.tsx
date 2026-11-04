"use client";

import type { Signoff } from "@agent/lib/core/erp";
import { useCallback, useEffect, useState } from "react";
import { DataTable, PageHeader, Panel, Segmented, day } from "@/components/kit";
import { Page } from "@/components/shell/app-shell";
import { SignoffCard, SignoffStatus } from "./signoff";

type Filter = "pending" | "decided" | "all";

/** The sign-off desk: every row's cases that need a person, and the decisions already taken. */
export function SignoffView() {
  const [cases, setCases] = useState<Signoff[]>([]);
  const [filter, setFilter] = useState<Filter>("pending");
  const [selected, setSelected] = useState<string>();

  const load = useCallback(() => {
    fetch("/api/signoffs?all=1")
      .then((r) => r.json())
      .then((d) => setCases(d.all ?? d.pending ?? []))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  const rows = cases.filter((c) => filter === "all" || (filter === "pending" ? c.status === "pending" : c.status !== "pending"));
  const current = cases.find((c) => c.caseId === selected) ?? rows[0];

  return (
    <Page>
      <PageHeader title="Sign-off" sub="A person decides when a case is unclear, and writes one line on why. Grok and code never decide here.">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "pending", label: "Waiting" },
            { value: "decided", label: "Decided" },
            { value: "all", label: "All" },
          ]}
        />
      </PageHeader>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Panel>
          <DataTable
            rows={rows}
            rowKey={(c) => c.caseId}
            selectedKey={current?.caseId}
            onRowClick={(c) => setSelected(c.caseId)}
            empty={filter === "pending" ? "Nothing is waiting for a person." : "No decisions yet."}
            columns={[
              { key: "id", header: "Case", main: true, cell: (c) => c.caseId },
              {
                key: "about",
                header: "About",
                cell: (c) => (
                  <span className="inline-flex max-w-[230px] flex-col align-middle leading-tight">
                    <span className="truncate">{c.title ?? c.kind}</span>
                    <span className="text-[11px] text-ink-68">
                      {c.row} · {day(c.createdAt)}
                    </span>
                  </span>
                ),
              },
              { key: "status", header: "Status", cell: (c) => <SignoffStatus status={c.status} /> },
            ]}
          />
        </Panel>
        {current ? <SignoffCard key={current.caseId} signoff={current} onDecided={load} /> : null}
      </div>
    </Page>
  );
}
