"use client";

/** Everything behind one claim: email, extraction, verdict with a source per point, facts, threeway, outcome documents. */
import type { ClaimExtraction } from "@agent/lib/dispute/claim_reader";
import type { ThreeWayView } from "@agent/lib/dispute/pull_facts";
import type { ClaimDetail, OutcomeDocument, StoredVerdict } from "@agent/lib/dispute/views";
import { useState } from "react";
import { AuditList } from "@/components/core/audit";
import { SignoffCard } from "@/components/core/signoff";
import { type Column, DataTable, day, eur, Facts, Panel, Pill, qty, Segmented, SourceTag } from "@/components/kit";
import { claimTypeLabel, confidencePct, DOC_LABEL, decisionLabel, outcomePill, sourceKindLabel } from "./format";

const pct = (v: number | null | undefined) => (v == null ? "–" : confidencePct(v));

export function ExtractionFacts({ extraction }: { readonly extraction: ClaimExtraction }) {
  const e = extraction;
  return (
    <Facts
      items={[
        ["Claim type", claimTypeLabel(e.claim_type)],
        ["Order", e.order_ref ?? <span className="text-ink-68">not given</span>],
        ["Invoice", e.invoice_ref ?? <span className="text-ink-68">not given</span>],
        ["Product", e.product ?? "–"],
        ["Quantity", qty(e.quantity)],
        ["Amount claimed", eur(e.amount)],
        ["Reading confidence", pct(e.confidence)],
        ...(e.raw_notes ? ([["Notes", e.raw_notes]] as [string, string][]) : []),
      ]}
    />
  );
}

export function VerdictPoints({ verdict }: { readonly verdict: StoredVerdict }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Pill tone={verdict.needs_sign_off ? "attention" : "grok"}>
          Grok: {decisionLabel(verdict.decision)}
          {verdict.amount != null ? ` ${eur(verdict.amount)}` : ""}
        </Pill>
        <span className="text-ink-68">{pct(verdict.confidence)}</span>
      </div>
      {verdict.summary ? <p className="text-[13px] text-ink-78">{verdict.summary}</p> : null}
      <ol className="divide-y divide-[var(--color-hairline)]">
        {verdict.points.map((p, i) => (
          <li key={i} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2 text-[13px]">
            <span className="min-w-0 flex-1">{p.text}</span>
            {p.amount != null ? <b className="tabular-nums">{eur(p.amount)}</b> : null}
            <SourceTag title={p.source.detail || undefined}>
              {sourceKindLabel(p.source.kind)} · {p.source.ref === "unspecified" ? "no source" : p.source.ref}
            </SourceTag>
          </li>
        ))}
      </ol>
      {verdict.sign_off_reasons?.length ? (
        <div className="rounded-[10px] bg-st-attention px-3 py-2 text-[13px] text-st-attention-ink">
          <b>A person decides because</b>
          <ul className="mt-1 list-disc pl-5">
            {verdict.sign_off_reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {verdict.amount_notes?.length ? (
        <ul className="list-disc pl-5 text-[12px] text-ink-68">
          {verdict.amount_notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type TwLine = ThreeWayView["lines"][number];
const twColumns: Column<TwLine>[] = [
  { key: "item", header: "Item", main: true, cell: (l) => l.item_code },
  { key: "ordered", header: "Ordered", align: "right", cell: (l) => qty(l.ordered) },
  { key: "received", header: "Shipped (DESADV)", align: "right", cell: (l) => qty(l.received) },
  { key: "invoiced", header: "Invoiced", align: "right", cell: (l) => qty(l.invoiced) },
  { key: "prices", header: "PO / invoice price", align: "right", cell: (l) => `${eur(l.po_price)} / ${eur(l.invoice_price)}` },
  { key: "variance", header: "Value gap", align: "right", cell: (l) => eur(l.value_variance) },
  {
    key: "status",
    header: "Result",
    align: "right",
    cell: (l) => <Pill tone={l.status === "matched" ? "ok" : "attention"}>{l.reason || l.status}</Pill>,
  },
];

export function ThreewayTable({ threeway }: { readonly threeway: ThreeWayView | null }) {
  if (!threeway) return <p className="text-[13px] text-ink-68">No threeway match: the order was not found.</p>;
  return (
    <div className="space-y-2">
      <DataTable columns={twColumns} rows={threeway.lines} rowKey={(l) => `${l.po_number}|${l.item_code}`} />
      {threeway.warnings.length ? <p className="text-[12px] text-ink-68">{threeway.warnings.join(" · ")}</p> : null}
    </div>
  );
}

export function FactsFound({ detail }: { readonly detail: ClaimDetail }) {
  const f = detail.facts;
  if (!f) return <p className="text-[13px] text-ink-68">No facts pulled yet.</p>;
  const doc = (label: string, ref: unknown) =>
    ref ? <SourceTag>{String(ref)}</SourceTag> : <span className="text-st-attention-ink">{label} not found</span>;
  return (
    <div className="space-y-3">
      <Facts
        items={[
          ["Order", doc("order", f.order?.order_ref)],
          ["Customer", f.order?.customer ?? "–"],
          ["DESADV", doc("DESADV", f.desadv?.desadv_ref)],
          ["Invoice", f.invoice ? <span className="inline-flex gap-2">{doc("invoice", f.invoice.invoice_ref)} {day(f.invoice.invoice_date)}</span> : doc("invoice", null)],
        ]}
      />
      {f.proofs.length ? (
        <ul className="space-y-1 text-[13px]">
          {f.proofs.map((p, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <SourceTag>
                {sourceKindLabel(String(p.kind ?? "other"))} · {String(p.ref ?? p.doc_id ?? "")}
              </SourceTag>
              <span className="text-ink-78">{String(p.summary ?? "")}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {f.misses.length ? (
        <ul className="list-disc pl-5 text-[13px] text-st-attention-ink">
          {f.misses.map((m, i) => (
            <li key={i}>
              {m.kind}: {m.detail}
              {m.queried ? ` (${m.queried})` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {detail.facts_from ? <p className="text-[12px] text-ink-68">Facts from the {detail.facts_from}.</p> : null}
    </div>
  );
}

export function OutcomeDocuments({ documents }: { readonly documents: OutcomeDocument[] }) {
  const shown = documents.filter((d) => d.key !== "outcome_json");
  const [key, setKey] = useState(shown[0]?.key ?? "");
  if (!shown.length) return <p className="text-[13px] text-ink-68">Nothing sent to the retailer.</p>;
  const current = shown.find((d) => d.key === key) ?? shown[0];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented options={shown.map((d) => ({ value: d.key, label: DOC_LABEL[d.key] ?? d.kind }))} value={current.key} onChange={setKey} />
        <SourceTag title={current.path ?? undefined}>{current.doc_id}</SourceTag>
      </div>
      <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-all rounded-[10px] bg-hh-honeydew p-3 font-mono text-[12px] text-ink-78">
        {current.body ?? "(empty)"}
      </pre>
    </div>
  );
}

/** The claim's full story. `compact` (chat) leaves out the email and the audit trail. */
export function ClaimDetailBody({
  detail,
  compact = false,
  onDecided,
}: {
  readonly detail: ClaimDetail;
  readonly compact?: boolean;
  readonly onDecided?: (result: unknown) => void;
}) {
  const pill = outcomePill(detail);
  const so = detail.signoff_case;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-78">
        <Pill tone={pill.tone}>{pill.label}</Pill>
        {detail.customer ? <b className="text-ink">{detail.customer}</b> : null}
        {detail.order_ref ? <SourceTag>order {detail.order_ref}</SourceTag> : null}
        {detail.invoice_ref ? <SourceTag>invoice {detail.invoice_ref}</SourceTag> : null}
        <span className="text-ink-68">received {day(detail.received_at)}</span>
        {detail.outcome?.credit_note_number ? <SourceTag>{detail.outcome.credit_note_number}</SourceTag> : null}
        {detail.outcome?.approved_by ? <span className="text-ink-68">signed off by {detail.outcome.approved_by}</span> : null}
      </div>

      {so && so.status === "pending" ? <SignoffCard signoff={so} onDecided={onDecided} /> : null}
      {so && so.status !== "pending" ? (
        <p className="text-[13px] text-ink-78">
          Sign-off {so.caseId}: {so.status} by {so.decidedBy ?? "–"}
          {so.decisionReason ? `, "${so.decisionReason}"` : ""}
        </p>
      ) : null}

      {!compact && detail.email ? (
        <Panel title="Claim email" aside={detail.email.source ?? detail.email.doc_id}>
          <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap rounded-[10px] bg-hh-honeydew p-3 font-mono text-[12px] text-ink-78">
            {detail.email.body}
          </pre>
        </Panel>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {detail.extraction ? (
          <Panel title="Grok read the claim">
            <ExtractionFacts extraction={detail.extraction} />
          </Panel>
        ) : null}
        <Panel title="Facts pulled" aside="Mini ERP + Dispute catalog">
          <FactsFound detail={detail} />
        </Panel>
      </div>

      {detail.verdict ? (
        <Panel title="Verdict and sources" aside="Grok proposes, code checks every euro">
          <VerdictPoints verdict={detail.verdict} />
        </Panel>
      ) : null}

      <Panel title="Threeway match" aside="order · DESADV · invoice">
        <ThreewayTable threeway={detail.facts?.threeway ?? null} />
      </Panel>

      <Panel title="Outcome" aside="written by code">
        <OutcomeDocuments key={detail.claim_id} documents={detail.documents} />
      </Panel>

      {!compact ? (
        <Panel title="Audit trail">
          <AuditList entries={detail.audit} />
        </Panel>
      ) : null}
    </div>
  );
}
