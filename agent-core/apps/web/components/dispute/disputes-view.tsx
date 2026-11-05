"use client";

/**
 * The Disputes page: every retailer claim with what the retailer says, what Grok proposes (with
 * its sources) and the outcome; a detail panel per claim; and a box to run a new claim email.
 * Reads and writes only through /api/disputes (the same functions as the dispute_* tools).
 */
import type { ClaimDetail, ClaimRow } from "@agent/lib/dispute/views";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Drawer, Kpi, PageHeader } from "@/components/kit";
import { Page } from "@/components/shell/app-shell";
import { ClaimPanel } from "./claim-panel";
import { ClaimsTable } from "./claims-table";
import { SectionChat } from "@/components/shell/section-chat";

type ListResponse = { claims: ClaimRow[]; samples: { name: string; text: string }[] };

export function DisputesView() {
  const searchParams = useSearchParams();
  const claimFromUrl = searchParams.get("claim") ?? undefined;
  const [list, setList] = useState<ListResponse>();
  const [selected, setSelected] = useState<string | undefined>(claimFromUrl);
  const [open, setOpen] = useState(!!claimFromUrl);
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
          setSelected((s) => s ?? claimFromUrl ?? d.claims[0]?.claim_id);
        })
        .catch(() => {}),
    [claimFromUrl],
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

  // A decision made in the claim panel writes through the same API and asks the page to reload.
  useEffect(() => {
    const onChange = () => {
      loadList();
      if (selected) loadDetail(selected);
    };
    window.addEventListener("brc:changed", onChange);
    return () => window.removeEventListener("brc:changed", onChange);
  }, [loadList, loadDetail, selected]);

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
      <PageHeader title="Disputes" />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Claims" value={claims.length} />
        <Kpi label="Need a person" value={waiting} />
        <Kpi label="Credited" value={`€${Math.round(credited).toLocaleString("en-GB")}`} />
        <Kpi label="Replies sent" value={replies} />
      </div>

      {list ? (
        <ClaimsTable rows={claims} selected={open ? selected : undefined} onSelect={(r) => {
          setSelected(r.claim_id);
          setOpen(true);
        }} />
      ) : (
        <div className="h-40 animate-pulse rounded-[16px] bg-hh-honeydew" />
      )}

      <details className="group">
        <summary className="cursor-pointer list-none text-[14px] text-ink-68 hover:text-ink">
          Paste a new claim <span className="inline-block transition-transform group-open:rotate-90">›</span>
        </summary>
        <div className="mt-4">
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
        </div>
      </details>
      <SectionChat
        placeholder="Ask Grok about the claims…"
        context={{ page: "disputes" }}
        suggestions={["Which claims need a person, and why?", "Which claims did Grok settle on its own?"]}
      />
      <Drawer open={open && !!detail && detail.claim_id === selected} onClose={() => setOpen(false)}>
        {detail ? <ClaimPanel detail={detail} /> : null}
      </Drawer>
    </Page>
  );
}
