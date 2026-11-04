"use client";

/**
 * The Disputes page: every retailer claim with what the retailer says, what Grok proposes (with
 * its sources) and the outcome; a detail panel per claim; and a box to run a new claim email.
 * Reads and writes only through /api/disputes (the same functions as the dispute_* tools).
 */
import type { ClaimDetail, ClaimRow } from "@agent/lib/dispute/views";
import { useCallback, useEffect, useState } from "react";
import { PageHeader, Panel, Stat } from "@/components/kit";
import { Page } from "@/components/shell/app-shell";
import { askHref } from "@/components/shell/overview-chat";
import { ClaimDetailBody } from "./claim-detail";
import { ClaimsTable } from "./claims-table";

type ListResponse = { claims: ClaimRow[]; samples: { name: string; text: string }[] };

export function DisputesView() {
  const [list, setList] = useState<ListResponse>();
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<ClaimDetail>();
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const loadList = useCallback(
    () =>
      fetch("/api/disputes")
        .then((r) => r.json())
        .then((d: ListResponse) => {
          setList(d);
          setSelected((s) => s ?? d.claims[0]?.claim_id);
        })
        .catch(() => {}),
    [],
  );

  const loadDetail = useCallback((id: string) => {
    fetch(`/api/disputes/${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((d: { claim?: ClaimDetail }) => setDetail(d.claim))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (selected) loadDetail(selected);
  }, [selected, loadDetail]);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await fetch("/api/disputes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, source_name: source || undefined }),
      });
      const d = (await r.json()) as { error?: string; claim?: ClaimDetail };
      if (!r.ok || !d.claim) throw new Error(d.error ?? "The claim could not be handled");
      setText("");
      setSource("");
      await loadList();
      setSelected(d.claim.claim_id);
      setDetail(d.claim);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const claims = list?.claims ?? [];
  const waiting = claims.filter((c) => c.status === "awaiting_sign_off").length;
  const credits = claims.filter((c) => c.outcome?.kind === "credit_note");
  const replies = claims.filter((c) => c.outcome?.kind === "reject_reply").length;
  const credited = credits.reduce((s, c) => s + (c.outcome?.amount ?? 0), 0);

  return (
    <Page>
      <PageHeader
        title="Disputes"
        sub="Grok reads each claim and proposes a verdict with a source for every point. Code checks every euro and writes the credit note or the reply. A person decides only when something is unclear."
      >
        <a href={askHref("Which disputes wait for a person, and why?")} className="rounded-full bg-hh-dark px-4 py-1.5 font-bold text-[13px] text-hh-window">
          Ask Grok
        </a>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Claims" value={claims.length} />
        <Stat label="Need a person" value={waiting} />
        <Stat label="Credit notes" value={credits.length} hint={credits.length ? `€${credited.toLocaleString("en-GB", { minimumFractionDigits: 2 })} credited` : undefined} />
        <Stat label="Replies sent" value={replies} />
      </div>

      <Panel title="Claims" aside="click a claim to see its sources">
        {list ? (
          <ClaimsTable rows={claims} selected={selected} onSelect={(r) => setSelected(r.claim_id)} />
        ) : (
          <div className="h-40 animate-pulse rounded-[10px] bg-hh-honeydew" />
        )}
      </Panel>

      {detail && detail.claim_id === selected ? (
        <Panel title={`Claim ${detail.claim_id}`} aside={detail.signoff_case ? `sign-off ${detail.signoff_case.caseId}` : undefined}>
          <ClaimDetailBody
            detail={detail}
            onDecided={() => {
              loadList();
              loadDetail(detail.claim_id);
            }}
          />
        </Panel>
      ) : null}

      <Panel title="New claim" aside="paste the retailer's email or remittance text">
        <div className="space-y-3">
          {list?.samples.length ? (
            <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-68">
              <span>Demo claims:</span>
              {list.samples.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => {
                    setText(s.text);
                    setSource(s.name);
                  }}
                  className="rounded-full bg-hh-honeydew px-2.5 py-0.5 text-ink-78 hover:text-ink"
                >
                  {s.name.replace(/\.txt$/, "").replace(/_/g, " ")}
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            placeholder="Da: ufficio.acquisti@… Oggetto: Reclamo consegna ordine …"
            className="w-full resize-y rounded-[10px] bg-white p-3 font-mono text-[12px] text-ink shadow-[inset_0_0_0_1px_rgb(32_49_25/0.09)] outline-none focus:shadow-[inset_0_0_0_1.5px_rgb(32_49_25/0.3)]"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy || !text.trim()}
              onClick={submit}
              className="rounded-full bg-hh-dark px-4 py-1.5 font-bold text-[13px] text-hh-window disabled:opacity-50"
            >
              {busy ? "Reading the claim…" : "Handle claim"}
            </button>
            {error ? <span className="text-[13px] text-st-attention-ink">{error}</span> : null}
          </div>
        </div>
      </Panel>
    </Page>
  );
}
