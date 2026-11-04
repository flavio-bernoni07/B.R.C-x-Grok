"use client";

import type { FinanceView } from "@agent/lib/finance/documents";
import { useEffect, useState } from "react";
import { DataTable, day, eur, Panel, Pill, SourceTag } from "@/components/kit";

type Doc = { docId: string; kind: string; ref: string | null; createdAt: string; body: string };

export function FinanceTab() {
  const [data, setData] = useState<FinanceView | null>(null);
  const [failed, setFailed] = useState(false);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [kind, setKind] = useState<string>("all");
  useEffect(() => {
    fetch("/api/finance")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setFailed(true));
  }, []);
  const openDoc = (docId: string) => {
    fetch(`/api/finance?doc=${encodeURIComponent(docId)}`)
      .then((r) => r.json())
      .then((d: Doc & { error?: string }) => setDoc(d.error ? null : d))
      .catch(() => setDoc(null));
  };
  if (failed) return <p className="text-[13px] text-ink-68">Finance data could not be loaded. Please reload the page.</p>;
  if (!data) return <div className="h-64 animate-pulse rounded-[14px] bg-hh-honeydew" />;
  const kinds = [...new Set(data.documents.map((d) => d.kind))];
  const docs = data.documents.filter((d) => kind === "all" || d.kind === kind);
  return (
    <div className="space-y-5">
      <div className="space-y-1 rounded-[12px] bg-hh-honeydew px-4 py-3 text-[13px]">
        {data.notes.map((n) => (
          <p key={n}>{n}</p>
        ))}
      </div>
      <Panel title="Invoices" aside="linked to the order and the shipment they bill">
        <DataTable
          rows={data.invoices}
          rowKey={(i) => i.invoiceRef}
          empty="No invoices yet."
          columns={[
            { key: "i", header: "Invoice", main: true, cell: (i) => i.invoiceRef },
            { key: "o", header: "Order", cell: (i) => <SourceTag>{i.orderRef}</SourceTag> },
            { key: "s", header: "Shipment", cell: (i) => (i.desadvRef ? <SourceTag>{i.desadvRef}</SourceTag> : "–") },
            { key: "ddt", header: "DDT", cell: (i) => i.ddtRef ?? "–" },
            { key: "d", header: "Date", cell: (i) => day(i.invoiceDate) },
            { key: "n", header: "Net", align: "right", cell: (i) => eur(i.totalNet) },
            { key: "v", header: "VAT", align: "right", cell: (i) => eur(i.totalVat) },
            { key: "t", header: "Total", align: "right", cell: (i) => <b>{eur(i.total)}</b> },
            { key: "st", header: "Status", cell: (i) => <Pill tone={i.status === "sent" ? "ok" : "attention"}>{i.status === "sent" ? "Sent (EDI, simulated)" : i.status}</Pill> },
            {
              key: "docs",
              header: "Documents",
              cell: (i) => (
                <span className="flex gap-1">
                  {i.documents.map((d) => (
                    <button key={d.docId} type="button" onClick={() => openDoc(d.docId)} className="underline-offset-2 hover:underline">
                      {d.kind}
                    </button>
                  ))}
                </span>
              ),
            },
          ]}
        />
        {data.creditNotes.length ? (
          <p className="mt-2 text-[12px] text-ink-68">
            Credit notes: {data.creditNotes.map((c) => `${c.kind} for ${c.ref}`).join(", ")}.
          </p>
        ) : null}
      </Panel>
      <div className={doc ? "grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_520px]" : "grid gap-5"}>
        <Panel
          title="Documents"
          aside={
            <select aria-label="Document kind" className="rounded-md border bg-background px-2 py-0.5 text-[12px]" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="all">All kinds</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          }
        >
          <DataTable
            rows={docs}
            rowKey={(d) => d.docId}
            selectedKey={doc?.docId}
            onRowClick={(d) => openDoc(d.docId)}
            empty="No documents yet."
            columns={[
              { key: "id", header: "Document", main: true, cell: (d) => d.docId },
              { key: "k", header: "Kind", cell: (d) => d.kind },
              { key: "r", header: "Reference", cell: (d) => d.ref ?? "–" },
              { key: "c", header: "Written", cell: (d) => day(d.createdAt) },
            ]}
          />
        </Panel>
        {doc ? (
          <Panel
            title={`${doc.kind} · ${doc.ref ?? doc.docId}`}
            aside={
              <button type="button" onClick={() => setDoc(null)} className="text-ink-68 hover:text-ink">
                Close
              </button>
            }
            className="lg:sticky lg:top-0"
          >
            <p className="mb-2 text-[12px] text-ink-68">
              {doc.kind.startsWith("FatturaPA") ? "FatturaPA XML as written by code. Not submitted to SdI. No PDF rendering." : "Shown as stored. EDI messages are simulated."}
            </p>
            <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-all rounded-[10px] bg-white/70 p-3 font-mono text-[12px] leading-snug">
              {doc.kind.startsWith("INVOIC") || doc.kind === "DESADV" || doc.kind.startsWith("ORD") ? doc.body.replace(/'/g, "'\n") : doc.body}
            </pre>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}
