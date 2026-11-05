"use client";

/**
 * One claim in the side panel, short: what the retailer says, what Grok proposes and how sure it
 * is, the three numbers, the evidence folded, the decision link (decisions happen only in
 * Sign-off), the documents to download and a chat about this claim.
 */
import type { ClaimDetail } from "@agent/lib/dispute/views";
import { DocLink, Kpi, Pill, SourceTag, day, eur } from "@/components/kit";
import { GrokMark } from "@/components/kit/icons";
import { DisputeWorkspace } from "@/components/core/dispute-workspace";
import { SignoffInline } from "@/components/core/signoff-desk";
import { SectionChat } from "@/components/shell/section-chat";
import { confidencePct, decisionLabel, outcomePill, retailerSays } from "./format";

export function ClaimPanel({ detail }: { readonly detail: ClaimDetail }) {
  const p = outcomePill(detail);
  const v = detail.verdict;
  const g = detail.grok;
  const by = detail.outcome?.approved_by;
  // Phone/chat handoffs use the normal verdict sign-off; legacy customer_dispute stays supported.
  const portalCase =
    detail.signoff_case &&
    detail.signoff_case.status === "pending" &&
    (detail.signoff_case.kind === "customer_dispute" ||
      (detail.signoff_case.kind === "verdict" && (detail.channel === "phone" || detail.channel === "customer_chat")))
      ? detail.signoff_case
      : null;
  const docs = [
    ...(detail.email ? [{ id: detail.email.doc_id, kind: "Claim email", label: detail.email.source }] : []),
    ...detail.documents.map((d) => ({ id: d.doc_id, kind: d.kind, label: d.key })),
  ];
  return (
    <article className="space-y-7 px-8 pt-8 pb-10">
      <header className="space-y-3 pr-12">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-bold text-[30px] leading-none tracking-[-0.035em]">{detail.claim_id}</h2>
          <Pill tone={p.tone}>{p.label}</Pill>
          {detail.channel === "phone" ? <Pill tone="live">Phone</Pill> : null}
          {detail.channel === "customer_chat" ? <Pill tone="quiet">Chat</Pill> : null}
        </div>
        <p className="text-[15px] text-ink-68">
          {[detail.customer, detail.order_ref ? `order ${detail.order_ref}` : null, `received ${day(detail.received_at)}`].filter(Boolean).join(" · ")}
        </p>
        <p className="text-[16px]">
          <span className="text-ink-68">The retailer says </span>
          <b>{retailerSays(detail)}</b>
        </p>
      </header>

      {portalCase ? (
        <DisputeWorkspace
          caseId={portalCase.caseId}
          onDecided={() => window.dispatchEvent(new Event("brc:changed"))}
        />
      ) : detail.signoff_case?.status === "pending" ? (
        <SignoffInline c={detail.signoff_case} onDecided={() => window.dispatchEvent(new Event("brc:changed"))} />
      ) : v ? (
        <section className="flex items-start gap-3 rounded-[12px] bg-hh-honeydew px-4 py-3">
          <GrokMark size={28} title="Grok's suggestion" />
          <span className="min-w-0 flex-1 text-[15px] leading-snug">
            <span className="text-ink-68">Grok suggests </span>
            <b>{decisionLabel(v.decision).toLowerCase()}{v.amount != null ? ` ${eur(v.amount, 0)}` : ""}</b>
            {v.summary ? <span className="mt-1 block text-[14px] text-ink-68">{v.summary}</span> : null}
            {by ? <span className="mt-1 block text-[13px] text-ink-68">Decided by {by}</span> : g && !g.needs_sign_off ? <span className="mt-1 block text-[13px] text-ink-68">Settled with no person</span> : null}
          </span>
          <span className="shrink-0 text-[13px] tabular-nums text-ink-68">{confidencePct(v.confidence)}</span>
        </section>
      ) : null}

      <div className="grid grid-cols-3 gap-3">
        <Kpi label="Claimed" value={detail.claimed_amount != null ? eur(detail.claimed_amount, 0) : "–"} />
        <Kpi label="Grok proposes" value={v?.amount != null && v.decision !== "reject" ? eur(v.amount, 0) : v ? decisionLabel(v.decision) : "–"} />
        <Kpi label="Sources" value={g?.sources ?? 0} />
      </div>

      {v?.points.length ? (
        <details className="group">
          <summary className="cursor-pointer list-none text-[14px] font-bold hover:text-ink-78">
            Evidence ({v.points.length}) <span className="inline-block transition-transform group-open:rotate-90">›</span>
          </summary>
          <ul className="mt-3 space-y-2">
            {v.points.map((pt, i) => (
              <li key={i} className="flex items-start justify-between gap-3 border-hairline border-b pb-2 text-[14px]">
                <span className="text-ink-78">{pt.text}</span>
                {pt.source?.ref && pt.source.ref !== "unspecified" ? <SourceTag>{pt.source.ref}</SourceTag> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {docs.length ? (
        <section>
          <h3 className="mb-2 text-[13px] text-ink-68">Documents</h3>
          <div className="flex flex-wrap gap-2">
            {docs.map((d) => (
              <DocLink key={d.id} href={`/api/documents/${encodeURIComponent(d.id)}`} kind={d.kind} label={d.label} />
            ))}
          </div>
        </section>
      ) : null}

      <SectionChat
        placeholder={`Ask Grok about ${detail.claim_id}…`}
        context={{ page: "claim", claim: detail.claim_id }}
        suggestions={[`Why did Grok propose this on ${detail.claim_id}?`]}
      />
    </article>
  );
}
