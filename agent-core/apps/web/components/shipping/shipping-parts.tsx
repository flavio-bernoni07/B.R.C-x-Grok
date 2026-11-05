"use client";

import type { BenchResult } from "@agent/lib/bench/score";
import type { ExceptionCase, Proposal } from "@agent/lib/shipping/cases";
import type { ReportDict } from "@agent/lib/shipping/reconcile";
import type { Answer, ReconcileView, ShippingFile, ShippingListRow } from "@agent/lib/shipping/service";
import type { ReactNode } from "react";
import { type Column, DataTable, day, eur, Facts, Pill, type PillTone, qty, SourceTag, Stat, WrongMark } from "@/components/kit";
import { actionLabel, answerText, caseStatusPill, caseTypeLabel, causeLabel, causeTone, rowPill, whatHappened } from "./format";

// ----- small pieces ------------------------------------------------------------

/** Our answer as pills: one per cause, or "Matched". */
export function OursPills({ answer }: { readonly answer: Answer }) {
  if (!answer.attention) return <Pill tone="ok">Matched</Pill>;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {answer.causes.map((c) => (
        <Pill key={c} tone={causeTone(c)}>
          {causeLabel(c)}
        </Pill>
      ))}
    </span>
  );
}

/** threeway's answer, with the kit's ✗ when it differs from ours. */
export function ThreewayAnswer({ answer, wrong }: { readonly answer: Answer; readonly wrong: boolean }) {
  return (
    <span className={wrong ? "text-ink" : "text-ink-78"}>
      {answerText(answer)}
      {wrong ? <WrongMark /> : null}
    </span>
  );
}

// ----- the Shipping table --------------------------------------------------------

const columns: Column<ShippingListRow>[] = [
  {
    key: "invoice",
    header: "Invoice",
    main: true,
    cell: (r) => (
      <span className="flex flex-col leading-tight">
        <span>{r.invoice_refs.length ? r.invoice_refs.join(", ") : "Not invoiced"}</span>
        <span className="font-normal text-[12px] text-ink-68">{[r.order_ref, r.customer].filter(Boolean).join(" · ")}</span>
      </span>
    ),
  },
  { key: "what", header: "What happened", cell: (r) => <span className="block max-w-[360px] truncate" title={whatHappened(r)}>{whatHappened(r)}</span> },
  {
    key: "threeway",
    header: "threeway (old CRM)",
    cell: (r) => (r.reconcile ? <ThreewayAnswer answer={r.reconcile.threeway} wrong={r.reconcile.threeway_wrong} /> : <span className="text-ink-50">–</span>),
  },
  {
    key: "ours",
    header: "Ours",
    cell: (r) => {
      if (r.reconcile) return <OursPills answer={r.reconcile.ours} />;
      const p = rowPill(r);
      return <Pill tone={p.tone}>{p.label}</Pill>;
    },
  },
];

export function ShippingTable({
  rows,
  selected,
  onSelect,
}: {
  readonly rows: ShippingListRow[];
  readonly selected?: string;
  readonly onSelect?: (r: ShippingListRow) => void;
}) {
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.order_ref} onRowClick={onSelect} selectedKey={selected} empty="No order has reached shipping yet." />;
}

// ----- reconciliation ------------------------------------------------------------

/** Causes per line with their euro amount and share of the total gap. */
export function CausesList({ report }: { readonly report: ReportDict }) {
  const causes = report.lines.flatMap((l) => l.causes.map((c) => ({ ...c, line: `${l.order_ref} ${l.item_code}` })));
  if (!causes.length) return <p className="text-[13px] text-ink-78">Order, despatch advice and invoice agree on every line.</p>;
  const totalEur = causes.reduce((a, c) => a + Math.abs(c.eur), 0);
  return (
    <ul className="space-y-2">
      {causes.map((c, i) => {
        const share = totalEur ? Math.round((Math.abs(c.eur) / totalEur) * 100) : 0;
        return (
          <li key={i} className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-[13px]">
              <span className="flex min-w-0 items-center gap-2">
                <Pill tone={causeTone(c.code)}>{causeLabel(c.code)}</Pill>
                <span className="truncate text-ink-78">{c.text}</span>
              </span>
              <span className="whitespace-nowrap font-bold tabular-nums">
                {eur(c.eur)} <span className="font-normal text-ink-68">· {share}%</span>
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-hh-honeydew">
              <div className="h-1.5 rounded-full bg-hh-dark" style={{ width: `${share}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ReconcileBody({ view }: { readonly view: ReconcileView }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-[12px] bg-white/60 px-3 py-2">
          <div className="text-[12px] text-ink-68">threeway (old CRM)</div>
          <div className="mt-1 text-[14px]">
            <ThreewayAnswer answer={view.threeway} wrong={view.threeway_wrong} />
          </div>
        </div>
        <div className="rounded-[12px] bg-white/60 px-3 py-2">
          <div className="text-[12px] text-ink-68">Ours</div>
          <div className="mt-1">
            <OursPills answer={view.ours} />
          </div>
        </div>
      </div>
      <CausesList report={view.report} />
      {view.report.notes.length ? (
        <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-ink-68">
          {view.report.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      <p className="text-[12px] text-ink-68">
        Written by code from the order, the DESADV and the invoice. <SourceTag>shipping/reconcile</SourceTag> <SourceTag>threeway</SourceTag>
      </p>
    </div>
  );
}

// ----- exception cases -------------------------------------------------------------

export function CaseBody({ c, proposals }: { readonly c: ExceptionCase; readonly proposals?: Proposal[] }) {
  const pill = caseStatusPill(c.status, c.resolution);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-bold text-[14px]">
          {caseTypeLabel(c.type)} <span className="font-normal text-ink-68">· {c.case_id}</span>
        </span>
        <Pill tone={pill.tone}>{pill.label}</Pill>
      </div>
      <p className="text-[13px] text-ink-78">{c.explanation}</p>
      <Facts
        items={[
          ["Approves", c.role.replace(/_/g, " ")],
          ["May propose", c.possible_actions.map((a) => (a.selected ? `${actionLabel(a.action)} (proposed)` : actionLabel(a.action))).join(", ")],
          ...(c.pallet_id ? ([["Pallet", c.pallet_id]] as [ReactNode, ReactNode][]) : []),
          ...(c.truck_id ? ([["Truck", c.truck_id]] as [ReactNode, ReactNode][]) : []),
        ]}
      />
      {proposals?.map((p) => <ProposalLine key={p.proposal_id} p={p} />)}
    </div>
  );
}

export function ProposalLine({ p }: { readonly p: Proposal }) {
  const tone: PillTone = p.status === "validated" ? (p.by === "grok" ? "grok" : "ok") : "attention";
  return (
    <div className="rounded-[10px] bg-white/60 px-3 py-2 text-[13px]">
      <div className="flex items-center justify-between gap-2">
        <span>
          {p.by === "grok" ? "Grok" : p.by} proposes {p.actions.map((a) => actionLabel(a.action)).join(", ") || "nothing"}
          {p.actions.some((a) => a.params && Object.keys(a.params).length)
            ? ` (${p.actions.flatMap((a) => Object.values(a.params ?? {}).map(String)).join(", ")})`
            : ""}
        </span>
        <Pill tone={tone}>{p.status === "validated" ? "Checked by code" : "Rejected by code"}</Pill>
      </div>
      {p.rationale ? <p className="mt-1 text-ink-68">{String(p.rationale)}</p> : null}
      {p.problems.length ? <p className="mt-1 text-st-attention-ink">{p.problems.join("; ")}</p> : null}
    </div>
  );
}

// ----- the shipping file: one step per stage ------------------------------------------

type Step = { label: string; tone: PillTone | null; state: string; body?: ReactNode };

function StepRow({ step, last }: { readonly step: Step; readonly last: boolean }) {
  return (
    <li className="relative pl-6">
      <span className={`absolute top-1.5 left-0 h-2.5 w-2.5 rounded-full ${step.tone ? "bg-hh-dark" : "bg-hh-honeydew shadow-[inset_0_0_0_1.5px_rgb(32_49_25/0.2)]"}`} />
      {last ? null : <span className="absolute top-4 bottom-[-12px] left-[4.5px] w-px bg-hairline" />}
      <div className="flex items-center justify-between gap-2">
        <span className="font-bold text-[14px]">{step.label}</span>
        {step.tone ? <Pill tone={step.tone}>{step.state}</Pill> : <span className="text-[12px] text-ink-50">{step.state}</span>}
      </div>
      {step.body ? <div className="mt-1.5 text-[13px] text-ink-78">{step.body}</div> : null}
    </li>
  );
}

export function ShippingSteps({ file, onPropose, proposing }: { readonly file: ShippingFile; readonly onPropose?: (caseId: string) => void; readonly proposing?: string | null }) {
  const { plan, pallets, scans, shipments, invoices, reconcile, exception_cases: cases, proofs } = file;
  const scanFails = scans.filter((s) => s.result !== "OK");
  const allProposals = cases.flatMap((c) => c.proposal_records);
  const steps: Step[] = [
    {
      label: "Plan",
      tone: plan.manifest ? "ok" : cases.some((c) => c.type.startsWith("TRUCK") || c.type === "NO_TRUCK") ? "attention" : null,
      state: plan.manifest ? `On ${plan.manifest.truck_id}` : "No truck plan",
      body: plan.manifest ? (
        <span>
          {plan.manifest.pallets} pallets, {qty(plan.manifest.weight_kg)} kg <SourceTag>{plan.manifest.manifest_id}</SourceTag>
        </span>
      ) : plan.load ? (
        <span>
          {plan.load.pallets} pallets, {qty(plan.load.weight_kg)} kg to {plan.load.destination ?? "–"}
        </span>
      ) : undefined,
    },
    {
      label: "Scan",
      tone: scans.length ? (scanFails.length ? "attention" : "ok") : null,
      state: scans.length ? `${scans.length - scanFails.length} of ${scans.length} scans ok` : pallets.length ? `${pallets.length} pallets picked` : "No scans",
      body: scanFails.length ? scanFails.map((s) => `${s.pallet_id}: ${s.result.replace(/_/g, " ").toLowerCase()}`).join("; ") : undefined,
    },
    {
      label: "Dispatch",
      tone: shipments.length ? (shipments.some((s) => s.notes) ? "attention" : "ok") : null,
      state: shipments.length ? (shipments.some((s) => s.notes) ? "Shipped short" : "Shipped") : "Not shipped",
      body: shipments.length ? (
        <div className="space-y-1">
          {shipments.map((s) => (
            <div key={s.desadvRef}>
              {qty(s.lines.reduce((a, l) => a + l.qty, 0))} units on {day(s.shipDate)}{" "}
              {s.documents.map((d) => (
                <SourceTag key={d.doc_id} title={d.doc_id}>
                  {d.kind} {d.ref}
                </SourceTag>
              ))}
              {s.notes ? <div className="text-ink-68">{s.notes}</div> : null}
            </div>
          ))}
          {proofs
            .filter((p) => p.kind === "pod")
            .map((p) => (
              <div key={String(p.doc_id)} className="text-ink-68">
                {String(p.summary)}
              </div>
            ))}
        </div>
      ) : undefined,
    },
    {
      label: "Invoice",
      tone: invoices.length ? (invoices.every((i) => i.status === "sent") ? "ok" : "wait") : null,
      state: invoices.length ? invoices.map((i) => i.status).join(", ") : "Not invoiced",
      body: invoices.length ? (
        <div className="space-y-1">
          {invoices.map((i) => (
            <div key={i.invoiceRef}>
              {i.invoiceRef}: {eur(i.totalNet)} net + {eur(i.totalVat)} VAT{" "}
              {i.documents.map((d) => (
                <SourceTag key={d.doc_id} title={d.doc_id}>
                  {d.kind}
                </SourceTag>
              ))}
            </div>
          ))}
        </div>
      ) : undefined,
    },
    {
      label: "Reconcile",
      tone: reconcile ? (reconcile.ours.attention ? "attention" : "ok") : null,
      state: reconcile ? (reconcile.ours.attention ? "Causes found" : "Matched") : "Not yet",
      body: reconcile ? <ReconcileBody view={reconcile} /> : undefined,
    },
    {
      label: "Case",
      tone: cases.length ? (cases.every((c) => c.resolution === "resolved") ? "ok" : "attention") : null,
      state: cases.length ? `${cases.length} case${cases.length > 1 ? "s" : ""}` : "No case",
      body: cases.length ? (
        <div className="space-y-3">
          {cases.map((c) => (
            <div key={c.case_id} className="space-y-2">
              <CaseBody c={c} />
              {onPropose && (c.status === "open" || c.status === "clarification_requested") ? (
                <button
                  type="button"
                  disabled={proposing === c.case_id}
                  onClick={() => onPropose(c.case_id)}
                  className="h-[30px] rounded-full bg-hh-dark px-3 font-bold text-[13px] text-hh-window disabled:opacity-60"
                >
                  {proposing === c.case_id ? "Asking Grok…" : "Ask Grok for a proposal"}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : undefined,
    },
    {
      label: "Grok's proposal",
      tone: allProposals.length ? (allProposals.some((p) => p.status === "validated") ? "grok" : "attention") : null,
      state: allProposals.length ? (allProposals.some((p) => p.status === "validated") ? "Checked by code" : "Rejected by code") : "None",
      body: allProposals.length ? (
        <div className="space-y-1.5">
          {allProposals.map((p) => (
            <ProposalLine key={p.proposal_id} p={p} />
          ))}
        </div>
      ) : undefined,
    },
    {
      label: "Approval",
      ...approvalStep(file),
    },
  ];
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => (
        <StepRow key={s.label} step={s} last={i === steps.length - 1} />
      ))}
    </ol>
  );
}

function approvalStep(file: ShippingFile): Omit<Step, "label"> {
  const signoffs = file.signoffs as unknown as { case_id?: string; caseId?: string; status: string; title?: string | null; decidedBy?: string | null; decisionReason?: string | null }[];
  if (!signoffs.length) return { tone: null, state: "Nothing to approve" };
  const pending = signoffs.filter((s) => s.status === "pending");
  return {
    tone: pending.length ? "attention" : "ok",
    state: pending.length ? "Waiting in Sign-off" : "Decided",
    body: (
      <div className="space-y-1">
        {signoffs.map((s) => (
          <div key={s.caseId ?? s.case_id}>
            {s.title} <SourceTag>{s.caseId ?? s.case_id}</SourceTag>
            {s.status !== "pending" ? (
              <div className="text-ink-68">
                {s.status} by {s.decidedBy}: {s.decisionReason}
              </div>
            ) : (
              <div className="text-ink-68">An employee approves on the Sign-off page; no agent tool approves.</div>
            )}
          </div>
        ))}
      </div>
    ),
  };
}

// ----- benchmark -------------------------------------------------------------------

export function BenchSummary({ res }: { readonly res: BenchResult }) {
  const { n, totals: t } = res;
  return (
    <div className="grid grid-cols-2 gap-3">
      <Stat label="Right call on whether to act" value={`${t.ours_attention_ok}/${n}`} hint={`threeway ${t.threeway_attention_ok}/${n}`} />
      <Stat label="Every cause named, nothing extra" value={`${t.ours_causes_ok}/${n}`} hint={`threeway ${t.threeway_causes_ok}/${n}`} />
    </div>
  );
}

export function BenchTable({ res }: { readonly res: BenchResult }) {
  type Row = BenchResult["rows"][number];
  const cols: Column<Row>[] = [
    { key: "id", header: "Case", main: true, cell: (r) => r.id },
    { key: "what", header: "What happened", cell: (r) => <span className="block max-w-[320px] truncate" title={r.description}>{r.description}</span> },
    { key: "right", header: "Right answer", cell: (r) => answerText(r.expected) },
    {
      key: "threeway",
      header: "threeway (old CRM)",
      cell: (r) => <ThreewayAnswer answer={r.threeway} wrong={!(r.threeway_attention_ok && r.threeway_causes_ok)} />,
    },
    {
      key: "ours",
      header: "Ours",
      cell: (r) => (
        <span>
          <OursPills answer={r.ours} />
          {r.ours_attention_ok && r.ours_causes_ok ? null : <WrongMark />}
        </span>
      ),
    },
  ];
  return <DataTable columns={cols} rows={res.rows} rowKey={(r) => r.id} />;
}
