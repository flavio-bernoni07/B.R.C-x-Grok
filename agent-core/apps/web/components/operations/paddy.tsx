"use client";

import type { PaddyPlan, PaddyRow } from "@agent/lib/purchasing/paddy";
import { Fragment, useState } from "react";
import { eur, Panel, Pill, type PillTone, SourceTag } from "@/components/kit";

const CALL_TONE: Record<PaddyRow["call"], PillTone> = { "BUY NOW": "attention", WAIT: "quiet", "BUY AS USUAL": "wait", "NOTHING TO BUY": "ok" };
const callLabel = (c: PaddyRow["call"]) => c.charAt(0) + c.slice(1).toLowerCase();
const t = (x: number | null) => (x == null ? "–" : `${x.toLocaleString("en-GB", { maximumFractionDigits: 1 })} t`);

function Row({ row, onPropose, busy }: { readonly row: PaddyRow; readonly onPropose?: (variety: string) => void; readonly busy: boolean }) {
  const [open, setOpen] = useState(false);
  const p = row.price;
  return (
    <Fragment>
      <tr className="border-hairline border-t first:border-t-0 align-middle text-[14px] tabular-nums">
        <td className="h-[54px] pr-4 font-bold">{row.variety}</td>
        <td className="pr-4 text-right">{row.cover_weeks == null ? "–" : `${row.cover_weeks} wk`}</td>
        <td className="pr-4 text-right">{t(row.need_paddy_t)}</td>
        <td className="pr-4 text-right">
          <b>{t(row.suggested_t)}</b>
          <div className="text-[12px] text-ink-68">{row.spend_eur == null ? "no price" : eur(row.spend_eur, 0)}</div>
        </td>
        <td className="pr-4">
          <Pill tone={CALL_TONE[row.call]}>{callLabel(row.call)}</Pill>
        </td>
        <td className="pr-4 text-[13px]">
          {p ? (
            <>
              {eur(p.last, 0)} → {eur(p.forecast, 0)}/t
              <div className="text-[12px] text-ink-68">
                80% band {eur(p.lower, 0)} to {eur(p.upper, 0)}, {p.change_pct >= 0 ? "+" : ""}
                {p.change_pct}%
              </div>
            </>
          ) : (
            <span className="text-ink-68">Price forecast unavailable</span>
          )}
        </td>
        <td className="pr-4">
          <Pill tone={row.confidence === "ok" ? "ok" : "attention"}>{row.confidence === "ok" ? "Model beats naive" : row.confidence === "low" ? "Low confidence" : "No price"}</Pill>
          {p ? (
            <div className="mt-1 text-[12px] text-ink-68">
              error {p.mape_prophet_pct ?? "?"}% vs {p.mape_naive_pct ?? "?"}% naive
            </div>
          ) : null}
        </td>
        <td className="whitespace-nowrap text-right text-[13px]">
          <button type="button" className="text-ink-68 hover:text-ink" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "How we got this number"}
          </button>
          {onPropose && row.suggested_t > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onPropose(row.variety)}
              className="ml-3 rounded-full bg-hh-dark px-3 py-1 font-bold text-[12px] text-hh-window disabled:opacity-50"
            >
              Prepare purchase proposal
            </button>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={8} className="pb-4">
            <ol className="space-y-1 rounded-[10px] bg-hh-honeydew/60 px-3 py-2 text-[13px]">
              {row.steps.map((s, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-ink-68">{i + 1}.</span>
                  <span>{s.step}:</span>
                  <b>{s.value}</b>
                  <SourceTag>{s.source}</SourceTag>
                </li>
              ))}
            </ol>
            {row.confidence_note ? <p className="mt-1 text-[12px] text-ink-68">{row.confidence_note}</p> : null}
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

/** "Paddy to buy": one row per variety. Used on the Operations page and as the chat card. */
export function PaddyToBuy({ plan, interactive = false }: { readonly plan: PaddyPlan; readonly interactive?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const propose = (variety: string) => {
    setBusy(true);
    setMessage(null);
    fetch("/api/purchasing/propose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variety }) })
      .then((r) => r.json())
      .then((d: { case_id?: string; created?: boolean; error?: string }) =>
        setMessage(
          d.error
            ? d.error
            : d.created
              ? `Proposal ${d.case_id} is waiting in Sign-off for a person to approve with a reason. Nothing is bought by the app.`
              : `Proposal ${d.case_id} is already waiting in Sign-off.`,
        ),
      )
      .catch(() => setMessage("The proposal could not be sent. Please try again."))
      .finally(() => setBusy(false));
  };
  return (
    <Panel title="Paddy to buy" aside={`next ${plan.horizon_weeks} weeks · suggestion only${plan.demo ? " · silo data is demo" : ""}`}>
      <div className="w-full overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="text-[12px] text-ink-68">
              <th className="pr-4 pb-2 font-medium">Variety</th>
              <th className="pr-4 pb-2 text-right font-medium">Cover now</th>
              <th className="pr-4 pb-2 text-right font-medium">Need, 8 weeks (paddy)</th>
              <th className="pr-4 pb-2 text-right font-medium">Suggested from farmers</th>
              <th className="pr-4 pb-2 font-medium">Call</th>
              <th className="pr-4 pb-2 font-medium">Price now → in 8 weeks</th>
              <th className="pr-4 pb-2 font-medium">Confidence</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((r) => (
              <Row key={r.variety} row={r} busy={busy} onPropose={interactive ? propose : undefined} />
            ))}
          </tbody>
        </table>
      </div>
      {message ? <p className="mt-3 rounded-[10px] bg-hh-honeydew px-3 py-2 text-[13px]">{message}</p> : null}
      <div className="mt-3 space-y-0.5 text-[12px] text-ink-68">
        {plan.excluded.map((e) => (
          <p key={e.item_code}>
            {e.item_code} ({e.variety}) is excluded: {e.why}.
          </p>
        ))}
        {plan.assumptions.map((a) => (
          <p key={a}>{a}</p>
        ))}
      </div>
    </Panel>
  );
}
