"use client";

/**
 * What code and Grok caught on one order, one short card each: the problem, what it blocks (red),
 * Grok's suggestion and the choices. A click posts the choice; code checks it and the sign-off
 * records who chose. Decided cards turn green with what happened. Detail is one click away.
 */
import type { Signoff } from "@agent/lib/core/erp";
import type { Caught } from "@agent/lib/order/caught";
import type { OrderWorkspace } from "@agent/lib/order/workspace";
import Link from "next/link";
import { useEffect, useState } from "react";
import { GrokMark } from "@/components/kit/icons";
import { Btn, eur } from "@/components/kit";
import { CaseDetail } from "@/components/core/actions-view";
import { DecideBar } from "@/components/core/signoff-desk";
import { announceChange } from "@/components/shell/app-shell";
import { cn } from "@/lib/utils";

const caseIdOf = (href: string | null) => {
  const m = href?.match(/[?&]case=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};

function Card({ c, signoff }: { readonly c: Caught; readonly signoff?: Signoff }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);

  async function choose(action: string, params?: Record<string, unknown> | null) {
    if (!c.caseId) return;
    setBusy(action);
    setError(null);
    const r = await fetch(`/api/shipping/cases/${encodeURIComponent(c.caseId)}/choose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, params: params ?? null, by: c.role }),
    });
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(null);
    if (!r.ok) return setError(d.error ?? "Could not save the choice");
    announceChange();
  }

  if (c.done) {
    return (
      <li className="flex items-center gap-3 rounded-[14px] bg-st-ok px-4 py-3 text-st-ok-ink">
        <span className="font-bold text-[15px]">✓</span>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-[14px] leading-snug">{c.problem}</p>
          <p className="text-[13px] leading-snug">{c.outcome}</p>
        </div>
        <b className="shrink-0 text-[14px] tabular-nums">{eur(c.atStake, 0)}</b>
      </li>
    );
  }

  return (
    <li className="space-y-3 rounded-[14px] bg-white px-4 py-4 shadow-[inset_4px_0_0_var(--color-st-pending)] ring-1 ring-hairline">
      <div className="flex items-start justify-between gap-3">
        <p className="font-bold text-[15px] leading-snug">{c.problem}</p>
        <b className="shrink-0 text-[15px] tabular-nums">{eur(c.atStake, 0)}</b>
      </div>
      {c.alert ? (
        <p className="flex items-center gap-2 font-bold text-[13px] text-st-pending-ink">
          <span className="block size-[8px] shrink-0 rounded-full bg-st-pending" />
          {c.alert}
        </p>
      ) : null}
      {c.grok ? (
        <p className="flex items-center gap-2 text-[14px]">
          <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-hh-dark text-hh-flex">
            <GrokMark size={13} title="Grok suggests" />
          </span>
          <span>{c.grok}</span>
        </p>
      ) : null}
      {c.options.length ? (
        <div className="flex flex-wrap gap-2">
          {c.options.map((o) => (
            <Btn key={o.action} variant={o.grok ? "primary" : "outline"} disabled={!!busy} onClick={() => choose(o.action, o.params)}>
              {busy === o.action ? "Saving…" : o.label}
            </Btn>
          ))}
          {c.href ? (
            <Link href={c.href} className="ml-auto self-center font-bold text-[13px] text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
              Details
            </Link>
          ) : null}
        </div>
      ) : signoff?.status === "pending" ? (
        <div className="space-y-3">
          <DecideBar c={signoff} onDecided={() => announceChange()} />
          <button type="button" onClick={() => setDetails((v) => !v)} className="font-bold text-[13px] text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
            {details ? "Hide details" : "Details"}
          </button>
          {details ? <CaseDetail signoff={signoff} onChanged={() => announceChange()} hideDecision /> : null}
        </div>
      ) : c.href ? (
        <Link href={c.href} className="inline-flex h-[34px] items-center rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window">
          Open the case
        </Link>
      ) : null}
      {error ? <p className="text-[13px] text-st-wrong">{error}</p> : null}
    </li>
  );
}

export function CaughtList({ ws }: { readonly ws: OrderWorkspace }) {
  const items = ws.caught ?? [];
  const [cases, setCases] = useState<Record<string, Signoff>>({});
  const wanted = items.map((c) => caseIdOf(c.href)).filter((id): id is string => !!id).join("|");

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    Promise.all(
      wanted.split("|").map((id) => fetch(`/api/signoffs/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null))),
    )
      .then((rows) => {
        if (!live) return;
        const next: Record<string, Signoff> = {};
        for (const d of rows) if (d?.case?.caseId) next[d.case.caseId] = d.case as Signoff;
        setCases(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [wanted]);

  if (!items.length) return null;
  const open = items.filter((c) => !c.done);
  return (
    <section className="space-y-2">
      <h3 className={cn("text-[13px]", open.length ? "font-bold text-st-pending-ink" : "text-ink-68")}>
        {open.length ? `${open.length} to decide` : "All caught and fixed"}
      </h3>
      <ul className="space-y-2">
        {[...open, ...items.filter((c) => c.done)].map((c) => (
          <Card key={c.key} c={c} signoff={caseIdOf(c.href) ? cases[caseIdOf(c.href)!] : undefined} />
        ))}
      </ul>
    </section>
  );
}
