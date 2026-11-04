"use client";

import type { ClaimExtraction } from "@agent/lib/dispute/claim_reader";
import type { LookupMiss } from "@agent/lib/dispute/mini_erp";
import type { ClaimDetail } from "@agent/lib/dispute/views";
import { Facts, Panel, Pill, SourceTag } from "@/components/kit";
import { ClaimDetailBody, ExtractionFacts } from "./claim-detail";

/** Chat card for `dispute_get` (a ClaimDetail) and `dispute_handle_claim` ({ mode, result, claim }). */
export function ClaimCard({ output }: { readonly output: unknown }) {
  const o = output as (ClaimDetail & { claim?: undefined }) | { mode?: string; claim: ClaimDetail | null };
  const detail = (o && "claim" in o && o.claim ? o.claim : (o as ClaimDetail)) ?? null;
  const mode = o && "mode" in o ? o.mode : undefined;
  if (!detail?.claim_id) return null;
  return (
    <Panel title={`Claim ${detail.claim_id}`} aside={mode === "offline" ? "recorded Grok answers (no API key)" : undefined}>
      <ClaimDetailBody detail={detail} compact />
    </Panel>
  );
}

type RefCheck = { found: true; ref: string | null; customer?: string | null } | { found: false; miss: LookupMiss | null };

/** Chat card for `dispute_read_claim`: what Grok read, and which references exist. */
export function ClaimReadCard({ output }: { readonly output: unknown }) {
  const o = output as { mode?: string; extraction: ClaimExtraction; ref_checks: Record<"order" | "desadv" | "invoice", RefCheck> };
  if (!o?.extraction) return null;
  const check = (label: string, c: RefCheck) =>
    c.found ? (
      <span className="inline-flex items-center gap-2">
        <Pill tone="ok">found</Pill>
        <SourceTag>{c.ref ?? label}</SourceTag>
        {"customer" in c && c.customer ? <span className="text-ink-68">{c.customer}</span> : null}
      </span>
    ) : (
      <span className="inline-flex items-center gap-2">
        <Pill tone="attention">not found</Pill>
        <span className="text-ink-68">{c.miss?.detail}</span>
      </span>
    );
  return (
    <Panel title="Claim read" aside={o.mode === "offline" ? "recorded Grok answer (no API key)" : "Grok extracts, code checks the refs"}>
      <div className="grid gap-4 md:grid-cols-2">
        <ExtractionFacts extraction={o.extraction} />
        <Facts
          items={[
            ["Order", check("order", o.ref_checks.order)],
            ["DESADV", check("DESADV", o.ref_checks.desadv)],
            ["Invoice", check("invoice", o.ref_checks.invoice)],
          ]}
        />
      </div>
    </Panel>
  );
}
