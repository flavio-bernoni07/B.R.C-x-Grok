"use client";

/**
 * The one sign-off desk for every row (core/signoff). A person approves or rejects and must write
 * one line on why; the row's own decision path then runs (order confirms, shipping executes the
 * resolution, dispute writes the outcome). The agent shows these cards; it never decides.
 *
 * What the person gets: why code stopped, Grok's (or the rule's) proposal in plain words, and the
 * documents/sources behind each point. Approve runs that proposal; Reject blocks it.
 */
import type { Signoff } from "@agent/lib/core/erp";
import Link from "next/link";
import { useEffect, useState } from "react";
import { claimTypeLabel, decisionLabel, sourceKindLabel } from "@/components/dispute/format";
import { actionLabel } from "@/components/shipping/format";
import { Facts, Panel, Pill, type PillTone, SourceTag, day, eur, qty } from "@/components/kit";
import { cn } from "@/lib/utils";

const ROW_LABEL: Record<string, string> = { order: "Order", shipping: "Shipping", dispute: "Dispute" };

export function signoffTone(status: string): PillTone {
  return status === "pending" ? "attention" : status === "approved" ? "ok" : "wait";
}

export function SignoffStatus({ status }: { readonly status: string }) {
  const label = status === "pending" ? "Needs a person" : status === "approved" ? "Approved" : "Rejected";
  return <Pill tone={signoffTone(status)}>{label}</Pill>;
}

/** What Approve / Reject actually do for this row. */
function DecisionConsequences({ row, proposal }: { readonly row: string; readonly proposal: Record<string, unknown> | null }) {
  if (row === "dispute") {
    const v = (proposal?.verdict ?? {}) as Record<string, unknown>;
    const decision = String(v.decision ?? "decide");
    const amount = typeof v.amount === "number" ? ` ${eur(v.amount)}` : "";
    const outcome =
      decision === "accept"
        ? `code writes the credit note${amount} and sends it`
        : decision === "reject"
          ? "code sends the evidence reply to the retailer (no credit)"
          : "code runs Grok's proposed outcome";
    return (
      <div className="rounded-[10px] bg-hh-honeydew px-3 py-2 text-[12px] text-ink-78">
        <b className="text-ink">Your call</b>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li>
            <b>Approve</b> — you agree with Grok: {outcome}. Your “why” is what the Playbook learns from.
          </li>
          <li>
            <b>Reject</b> — nothing is sent; the claim reopens for another look. Your “why” is logged as an overturn.
          </li>
        </ul>
      </div>
    );
  }
  if (row === "shipping") {
    const actions = (proposal?.actions as { action: string }[] | undefined) ?? [];
    const labels = actions.map((a) => actionLabel(a.action)).join(", ") || "the proposed fix";
    return (
      <div className="rounded-[10px] bg-hh-honeydew px-3 py-2 text-[12px] text-ink-78">
        <b className="text-ink">Your call</b>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li>
            <b>Approve</b> — warehouse runs: {labels}.
          </li>
          <li>
            <b>Reject</b> — the exception stays open; nothing is executed.
          </li>
        </ul>
      </div>
    );
  }
  // order
  return (
    <div className="rounded-[10px] bg-hh-honeydew px-3 py-2 text-[12px] text-ink-78">
      <b className="text-ink">Your call</b>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        <li>
          <b>Approve</b> — send the ORDRSP to the retailer and hand the order to Shipping.
        </li>
        <li>
          <b>Reject</b> — no ORDRSP; the order stays blocked.
        </li>
      </ul>
    </div>
  );
}

function DisputeProposal({ proposal }: { readonly proposal: Record<string, unknown> }) {
  const v = (proposal.verdict ?? {}) as {
    decision?: string;
    amount?: number | null;
    confidence?: number;
    summary?: string;
    points?: { text: string; amount?: number | null; source: { kind: string; ref: string; detail?: string } }[];
    claim?: {
      claim_type?: string | null;
      order_ref?: string | null;
      amount?: number | null;
      quantity?: number | null;
      product?: string | null;
      confidence?: number | null;
      raw_notes?: string | null;
    };
  };
  const facts = (proposal.facts ?? {}) as {
    order?: { order_ref?: string; customer?: string } | null;
    desadv?: { desadv_ref?: string } | null;
    invoice?: { invoice_ref?: string } | null;
    proofs?: { kind?: string; ref?: string; summary?: string }[];
    misses?: { kind: string; detail: string; queried?: string }[];
  };
  const claim = v.claim ?? {};
  const points = v.points ?? [];

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 text-[12px] text-ink-68">Grok proposes (you judge this)</div>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <Pill tone="attention">
            {decisionLabel(v.decision)}
            {v.amount != null ? ` ${eur(v.amount)}` : ""}
          </Pill>
          {v.confidence != null ? <span className="text-ink-68">confidence {v.confidence.toFixed(2)}</span> : null}
        </div>
        {v.summary ? <p className="mt-1.5 text-[13px] text-ink-78">{v.summary}</p> : null}
      </div>

      <div>
        <div className="mb-1 text-[12px] text-ink-68">What the retailer claimed</div>
        <Facts
          items={[
            ["Type", claimTypeLabel(claim.claim_type)],
            ["Order", claim.order_ref ?? "–"],
            ["Amount", claim.amount != null ? eur(claim.amount) : "–"],
            ["Quantity", claim.quantity != null ? qty(claim.quantity) : "–"],
            ["Product", claim.product ?? "–"],
            ...(claim.raw_notes ? ([["Notes", claim.raw_notes]] as [string, string][]) : []),
          ]}
        />
      </div>

      {points.length ? (
        <div>
          <div className="mb-1 text-[12px] text-ink-68">Evidence you can check (each point needs a source)</div>
          <ol className="divide-y divide-[var(--color-hairline)]">
            {points.map((p, i) => (
              <li key={i} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2 text-[13px]">
                <span className="min-w-0 flex-1">{p.text}</span>
                {p.amount != null ? <b className="tabular-nums">{eur(p.amount)}</b> : null}
                <SourceTag title={p.source.detail || undefined}>
                  {sourceKindLabel(p.source.kind)} · {p.source.ref === "unspecified" ? "no source" : p.source.ref}
                </SourceTag>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <div>
        <div className="mb-1 text-[12px] text-ink-68">Documents on file</div>
        <div className="flex flex-wrap gap-2 text-[13px]">
          {facts.order?.order_ref ? <SourceTag>Order {facts.order.order_ref}</SourceTag> : <span className="text-st-attention-ink">Order not found</span>}
          {facts.order?.customer ? <span className="text-ink-68">{facts.order.customer}</span> : null}
          {facts.desadv?.desadv_ref ? <SourceTag>DESADV {facts.desadv.desadv_ref}</SourceTag> : <span className="text-st-attention-ink">DESADV not found</span>}
          {facts.invoice?.invoice_ref ? <SourceTag>Invoice {facts.invoice.invoice_ref}</SourceTag> : <span className="text-st-attention-ink">Invoice not found</span>}
        </div>
        {facts.proofs?.length ? (
          <ul className="mt-2 space-y-1 text-[13px]">
            {facts.proofs.map((p, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <SourceTag>
                  {sourceKindLabel(String(p.kind ?? "other"))} · {String(p.ref ?? "")}
                </SourceTag>
                <span className="text-ink-78">{String(p.summary ?? "")}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {facts.misses?.length ? (
          <ul className="mt-2 list-disc pl-5 text-[13px] text-st-attention-ink">
            {facts.misses.map((m, i) => (
              <li key={i}>
                {m.kind}: {m.detail}
                {m.queried ? ` (${m.queried})` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function OrderProposal({ proposal }: { readonly proposal: Record<string, unknown> }) {
  const lines = (proposal.lines as { line_no?: number; gtin?: string; quantity?: number; qty_confirmed?: number; unit_price?: number }[]) ?? [];
  const availability = (proposal.availability as { gtin?: string; ordered_qty?: number; available_qty?: number; ok?: boolean; source?: string }[]) ?? [];
  const price = proposal.price_check as { ok?: boolean; contract_id?: string } | undefined;
  return (
    <div className="space-y-3">
      <div className="mb-1 text-[12px] text-ink-68">What you would confirm (ORDRSP)</div>
      <Facts
        items={[
          ["Stock check", availability.every((a) => a.ok) ? "OK" : "Short"],
          ["Price check", price?.ok ? `OK · ${price.contract_id ?? "contract"}` : "Mismatch"],
          ["Lines", String(lines.length)],
        ]}
      />
      {lines.length ? (
        <ul className="divide-y divide-[var(--color-hairline)] text-[13px]">
          {lines.map((l, i) => (
            <li key={i} className="flex flex-wrap justify-between gap-2 py-1.5">
              <span>
                Line {l.line_no ?? i + 1} · {l.gtin}
              </span>
              <span className="tabular-nums text-ink-78">
                {qty(l.qty_confirmed ?? l.quantity)} × {eur(l.unit_price ?? null)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {availability.length ? (
        <ul className="space-y-1 text-[12px] text-ink-68">
          {availability.map((a, i) => (
            <li key={i}>
              {a.gtin}: ordered {qty(a.ordered_qty)} · available {qty(a.available_qty)}
              {a.source ? ` · ${a.source}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ShippingProposal({ proposal }: { readonly proposal: Record<string, unknown> }) {
  const actions = (proposal.actions as { action: string; params?: Record<string, unknown> }[]) ?? [];
  return (
    <div className="space-y-2">
      <div className="mb-1 text-[12px] text-ink-68">Proposed warehouse fix</div>
      <Facts
        items={[
          ["Case", String(proposal.exception_case ?? "–")],
          ["Proposal", String(proposal.proposal_id ?? "–")],
          ["Actions", actions.map((a) => actionLabel(a.action)).join(", ") || "–"],
        ]}
      />
      {proposal.rationale ? <p className="text-[13px] text-ink-78">{String(proposal.rationale)}</p> : null}
    </div>
  );
}

/** Readable proposal; raw JSON only as a last resort for unknown shapes. */
function Proposal({ row, proposal }: { readonly row: string; readonly proposal: Record<string, unknown> | null }) {
  if (!proposal || !Object.keys(proposal).length) return null;
  if (row === "dispute" && proposal.verdict) return <DisputeProposal proposal={proposal} />;
  if (row === "order" && (proposal.lines || proposal.draft_ordrsp)) return <OrderProposal proposal={proposal} />;
  if (row === "shipping" && (proposal.actions || proposal.exception_case)) return <ShippingProposal proposal={proposal} />;

  const shown = Object.entries(proposal).filter(([k]) => !/(_dir|_path)$/.test(k));
  const simple = shown.filter(([, v]) => v == null || typeof v !== "object");
  const nested = shown.filter(([, v]) => v != null && typeof v === "object");
  return (
    <div className="space-y-2">
      {simple.length ? <Facts items={simple.map(([k, v]) => [k.replace(/_/g, " "), String(v ?? "–")])} /> : null}
      {nested.length ? (
        <details className="text-[12px]">
          <summary className="cursor-pointer select-none text-ink-68">Proposal details</summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-hh-honeydew p-3 font-mono text-[11px] leading-relaxed text-ink-78">
            {JSON.stringify(Object.fromEntries(nested), null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

export function SignoffCard({ signoff, onDecided }: { readonly signoff: Signoff; readonly onDecided?: (result: unknown) => void }) {
  const [c, setC] = useState(signoff);
  const [by, setBy] = useState("");
  const [reason, setReason] = useState("");
  const [manualEdi, setManualEdi] = useState("");
  // Order price cases: the person can paste the corrected EDI; it goes back to Parse (DECISIONS.md, Order).
  const takesEdi = c.row === "order" && (c.kind === "price_fix" || c.kind === "manual_edi");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<Record<string, unknown>>();

  useEffect(() => {
    try {
      setBy(localStorage.getItem("brc:signer") ?? "");
    } catch {
      /* private mode */
    }
  }, []);

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      localStorage.setItem("brc:signer", by);
    } catch {
      /* ignore */
    }
    const res = await fetch(`/api/signoffs/${encodeURIComponent(c.caseId)}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve, by, reason, edits: takesEdi && manualEdi.trim() ? { manual_edi: manualEdi } : undefined }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(data.error ?? `Failed (${res.status})`);
    if (data.case) setC(data.case);
    setResult(data.result);
    onDecided?.(data);
  };

  const open = c.status === "pending";
  const subjectHref =
    c.row === "dispute" && c.subjectRef
      ? `/disputes?claim=${encodeURIComponent(c.subjectRef)}`
      : c.row === "order" && c.subjectRef
        ? `/orders?ref=${encodeURIComponent(c.subjectRef)}`
        : c.row === "shipping" && c.subjectRef
          ? `/shipping?ref=${encodeURIComponent(c.subjectRef)}`
          : null;

  return (
    <Panel
      title={<span className="flex items-center gap-2">{c.title ?? c.kind}</span>}
      aside={
        <span className="flex items-center gap-2">
          <SourceTag>{c.caseId}</SourceTag>
          <span>{ROW_LABEL[c.row] ?? c.row}</span>
          <SignoffStatus status={c.status} />
        </span>
      }
    >
      <div className="space-y-3 text-[13px]">
        {c.subjectRef ? (
          <p className="text-ink-68">
            About{" "}
            {subjectHref ? (
              <Link href={subjectHref} className="font-bold text-ink underline-offset-2 hover:underline">
                {c.subjectRef}
              </Link>
            ) : (
              <b className="text-ink">{c.subjectRef}</b>
            )}{" "}
            · asked {day(c.createdAt)}
            {c.row === "dispute" ? (
              <span className="text-ink-68"> · open the claim for the full email, threeway and audit trail</span>
            ) : null}
          </p>
        ) : null}

        {c.reasons?.length ? (
          <div className="rounded-[10px] bg-st-attention px-3 py-2 text-[13px] text-st-attention-ink">
            <b>Why the system stopped</b>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {c.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <Proposal row={c.row} proposal={c.proposal} />

        {open ? <DecisionConsequences row={c.row} proposal={c.proposal} /> : null}

        {open ? (
          <div className="space-y-2 rounded-[12px] border border-[var(--color-hairline)] bg-hh-seasalt p-3">
            <div className="text-[12px] text-ink-68">Sign with your name and one line of judgment — that line trains the Playbook.</div>
            <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
              <input
                className="h-9 rounded-lg border bg-hh-window px-3 text-[13px] outline-none focus:border-hh-asparagus"
                placeholder="Your name"
                value={by}
                onChange={(e) => setBy(e.target.value)}
              />
              <input
                className="h-9 rounded-lg border bg-hh-window px-3 text-[13px] outline-none focus:border-hh-asparagus"
                placeholder="One line on why (the Playbook learns from it)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            {takesEdi ? (
              <textarea
                className="h-24 w-full rounded-lg border bg-hh-window p-2 font-mono text-[11px] outline-none focus:border-hh-asparagus"
                placeholder="Optional: paste the corrected ORDERS EDI. Approving without it parks the order as pending until a new ORDERS arrives."
                value={manualEdi}
                onChange={(e) => setManualEdi(e.target.value)}
              />
            ) : null}
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy || !by.trim() || !reason.trim()}
                onClick={() => void decide(true)}
                className="h-8 rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window disabled:opacity-40"
              >
                Approve proposal
              </button>
              <button
                type="button"
                disabled={busy || !by.trim() || !reason.trim()}
                onClick={() => void decide(false)}
                className="h-8 rounded-full bg-hh-seasalt px-4 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.15)] disabled:opacity-40"
              >
                Reject proposal
              </button>
              {busy ? <span className="text-[12px] text-ink-68">Running the decision…</span> : null}
              {error ? <span className="text-[12px] text-st-wrong">{error}</span> : null}
            </div>
          </div>
        ) : (
          <p className="text-ink-78">
            {c.status === "approved" ? "Approved" : "Rejected"} by <b>{c.decidedBy}</b>
            {c.decisionReason ? `: “${c.decisionReason}”` : ""} {c.decidedAt ? `· ${day(c.decidedAt)}` : ""}
          </p>
        )}
        {result ? (
          <details className="text-[12px]" open>
            <summary className="cursor-pointer select-none text-ink-68">What ran after the decision</summary>
            <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-hh-honeydew p-3 font-mono text-[11px] text-ink-78">
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
    </Panel>
  );
}

/** Compact queue list; opening a case shows its card. Used on Overview and as the chat card. */
export function SignoffQueue({ cases, compact = false }: { readonly cases: Signoff[]; readonly compact?: boolean }) {
  const [openId, setOpenId] = useState<string>();
  if (!cases.length) return <p className="py-3 text-[13px] text-ink-68">Nothing is waiting for a person.</p>;
  return (
    <ul className="divide-y divide-[var(--color-hairline)]">
      {cases.map((c) => (
        <li key={c.caseId} className="py-2">
          <button
            type="button"
            onClick={() => setOpenId(openId === c.caseId ? undefined : c.caseId)}
            className="flex w-full items-center gap-3 text-left"
          >
            <span className="w-[72px] shrink-0 font-bold text-[13px]">{c.caseId}</span>
            <span className="w-[64px] shrink-0 text-[12px] text-ink-68">{ROW_LABEL[c.row] ?? c.row}</span>
            <span className={cn("min-w-0 flex-1 truncate text-[13px]", compact && "text-ink-78")}>{c.title ?? c.kind}</span>
            <SignoffStatus status={c.status} />
          </button>
          {openId === c.caseId ? (
            <div className="mt-2">
              <SignoffCard signoff={c} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
