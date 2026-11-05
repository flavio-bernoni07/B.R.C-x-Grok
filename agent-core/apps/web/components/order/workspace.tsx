"use client";

import type { InboxStatus, OrderWorkspace } from "@agent/lib/order/workspace";
import type { ReactNode } from "react";
import { day, eur, Facts, Panel, Pill, type PillTone, qty, SourceTag } from "@/components/kit";
import { GrokbotIcon } from "@/components/kit/icons";
import { askHref } from "@/components/shell/overview-chat";

export const STATUS_TONE: Record<InboxStatus, PillTone> = { attention: "attention", on_track: "live", waiting: "quiet", completed: "ok" };

const when = (iso: string | null) =>
  iso ? new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: iso.length > 10 ? "2-digit" : undefined, minute: iso.length > 10 ? "2-digit" : undefined, timeZone: "UTC" }) : null;

function Section({ title, children, open }: { readonly title: string; readonly children: ReactNode; readonly open?: boolean }) {
  return (
    <details open={open} className="group border-hairline border-t py-2.5">
      <summary className="cursor-pointer list-none font-bold text-[14px] tracking-[-0.02em]">
        <span className="mr-1.5 inline-block text-ink-68 transition-transform group-open:rotate-90">›</span>
        {title}
      </summary>
      <div className="mt-2.5 space-y-2 text-[13px]">{children}</div>
    </details>
  );
}

const Muted = ({ children }: { readonly children: ReactNode }) => <p className="text-[13px] text-ink-68">{children}</p>;

function Journey({ steps }: { readonly steps: OrderWorkspace["journey"] }) {
  return (
    <ol className="space-y-0">
      {steps.map((s) => (
        <li key={s.key} className="grid grid-cols-[18px_1fr] gap-x-2.5">
          <span className="flex flex-col items-center">
            <span className={s.done ? "mt-1 size-2.5 rounded-full bg-hh-dark" : "mt-1 size-2.5 rounded-full border border-ink-68"} />
            <span className="w-px flex-1 bg-hairline" />
          </span>
          <div className="pb-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={s.done ? "font-bold text-[13px]" : "text-[13px] text-ink-68"}>{s.label}</span>
              {s.done ? (
                <span className="text-[12px] text-ink-68">
                  {[s.who, when(s.when)].filter(Boolean).join(", ")}
                </span>
              ) : (
                <span className="text-[12px] text-ink-68">not yet</span>
              )}
              {s.document ? <SourceTag>{s.document}</SourceTag> : null}
            </div>
            {s.detail ? <div className="text-[12px] text-ink-78">{s.detail}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** One order's workspace: header, journey, summary and collapsible sections. Used by the page and the chat card. */
export function OrderWorkspaceBody({ ws, compact }: { readonly ws: OrderWorkspace; readonly compact?: boolean }) {
  const s = ws.summary;
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-bold text-[18px] tracking-[-0.03em]">{ws.retailer}</span>
          <span className="text-[13px] text-ink-68">{ws.orderRef}</span>
          <Pill tone={STATUS_TONE[ws.status]}>{ws.statusLabel}</Pill>
        </div>
        <p className="text-[13px] text-ink">{ws.statusText}</p>
        <p className="text-[12px] text-ink-68">
          Delivery target {ws.deliveryDate ? day(ws.deliveryDate) : "not set on the order"} · {ws.counter.text}
        </p>
        <p className="text-[13px]">
          <span className="text-ink-68">Next step: </span>
          {ws.nextStep}
        </p>
      </div>

      {ws.exceptions.map((x) => (
        <div key={x.caseId} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-st-attention px-3 py-2 text-[13px] text-st-attention-ink">
          <span>
            <b>{x.caseId}</b> {x.text}
          </span>
          <a href={x.href} className="rounded-full bg-hh-dark px-3 py-1 font-bold text-[12px] text-hh-window">
            Review proposed resolution
          </a>
        </div>
      ))}

      {ws.details.grokChanges.length ? (
        <div className="space-y-2">
          <h4 className="flex items-center gap-1.5 font-bold text-[14px] tracking-[-0.02em]">
            <GrokbotIcon size={16} title="Grokbot" />
            What Grokbot did
          </h4>
          <ul className="space-y-2">
            {ws.details.grokChanges.map((g, i) => (
              <li key={`${g.what}-${g.before}-${g.after}-${i}`} className="rounded-[10px] bg-hh-honeydew px-3 py-2 text-[13px] leading-snug">
                <div className="font-bold tracking-[-0.01em]">
                  {g.what}: {g.before} → {g.after}
                </div>
                {g.why ? <div className="mt-0.5 text-[12.5px] text-ink-78">{g.why}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={compact ? "grid gap-4" : "grid gap-5 md:grid-cols-[minmax(0,1fr)_260px]"}>
        <div>
          <h4 className="mb-2 font-bold text-[14px]">Journey</h4>
          <Journey steps={ws.journey} />
        </div>
        <div>
          <h4 className="mb-2 font-bold text-[14px]">Summary</h4>
          <Facts
            items={[
              ["Confirmed", qty(s.confirmed)],
              ["Reserved", qty(s.reserved)],
              ["Shipped", qty(s.shipped)],
              ["Remaining", qty(s.remaining)],
              ["Received by retailer", s.received == null ? "not yet" : qty(s.received)],
              ["Money at stake", <span key="m">{eur(s.moneyAtStake)} <span className="text-ink-68">({s.moneyAtStakeNote})</span></span>],
              ["Next expected", s.nextEvent],
            ]}
          />
        </div>
      </div>

      {compact ? null : (
        <div>
          <Section title="Order details">
            <Facts
              items={[
                ["ORDERS", ws.details.ordersDoc ?? "none"],
                ["ORDRSP", ws.details.ordrspDoc ?? "not sent yet"],
                ["Contract", ws.details.contractId ?? "none"],
              ]}
            />
            {ws.details.lines.map((l) => (
              <div key={l.lineNo} className="flex flex-wrap gap-x-3">
                <span className="font-bold">{l.product ?? l.gtin}</span>
                <span>ordered {qty(l.ordered)}</span>
                <span>confirmed {qty(l.confirmed)}</span>
                <span>price {eur(l.unitPrice)}</span>
                <span className="text-ink-68">contract {eur(l.contractPrice)}</span>
              </div>
            ))}
            {ws.details.grokChanges.length ? (
              <Muted>See “What Grokbot did” above for the parse / quantity fixes on this order.</Muted>
            ) : (
              <Muted>Grokbot changed nothing on this order.</Muted>
            )}
          </Section>
          <Section title="Inventory">
            {ws.inventory.lines.map((l) => (
              <p key={l.gtin}>
                {l.product ?? l.gtin}: {qty(l.atp)} can be promised now, {qty(l.held)} on quality hold, {qty(l.committed)} reserved for open orders
              </p>
            ))}
            {ws.inventory.batches.map((b) => (
              <div key={b.batch} className="flex gap-3">
                <SourceTag>{b.batch}</SourceTag>
                <span>
                  {qty(b.qty)} {b.status === "hold" ? "on hold" : b.status}
                </span>
              </div>
            ))}
            {ws.inventory.events.map((e) => (
              <Muted key={e.event_id}>
                {e.event_id}: {e.kind.replace(/_/g, " ")} on {e.batch}
                {e.qty ? `, ${qty(e.qty)}` : ""}
                {e.note ? ` (${e.note})` : ""}
              </Muted>
            ))}
          </Section>
          <Section title="Shipping">
            {ws.shipping ? (
              <>
                <Facts
                  items={[
                    ["Truck", ws.shipping.truck ? `${ws.shipping.truck.id}${ws.shipping.truck.plate ? ` (${ws.shipping.truck.plate})` : ""} to ${ws.shipping.truck.destination ?? "–"}` : "not planned"],
                    ["Manifest", ws.shipping.manifest ? `${ws.shipping.manifest.id}, ${ws.shipping.manifest.pallets} pallets, orders ${ws.shipping.manifest.orders.join(", ")}` : "none"],
                    ["Pallets", String(ws.shipping.pallets)],
                    ["Scans", `${ws.shipping.scans.ok} correct, ${ws.shipping.scans.other} flagged`],
                    ["Loaded", ws.shipping.loaded ? "yes" : "not yet"],
                  ]}
                />
                {ws.shipping.scans.notes.map((t, i) => (
                  <Muted key={i}>{t}</Muted>
                ))}
                {ws.shipping.shipments.map((sh) => (
                  <div key={sh.desadv} className="space-y-1">
                    <p>
                      {sh.desadv}, DDT {sh.ddt ?? "–"}, {day(sh.shipDate)}: {qty(sh.qty)} units from {sh.batches.join(", ")}
                    </p>
                    {sh.notes ? <Muted>{sh.notes}</Muted> : null}
                    <div className="flex flex-wrap gap-1.5">
                      {sh.documents.map((d) => (
                        <SourceTag key={d.docId}>
                          {d.docId} {d.kind}
                        </SourceTag>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <Muted>Not handed to shipping yet.</Muted>
            )}
          </Section>
          <Section title="Finance">
            {ws.finance.invoices.length ? (
              ws.finance.invoices.map((i) => (
                <div key={i.invoice} className="space-y-1">
                  <p>
                    <b>{i.invoice}</b> {eur(i.total)}: {i.statusText}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {i.documents.map((d) => (
                      <SourceTag key={d.docId}>
                        {d.docId} {d.kind}
                      </SourceTag>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <Muted>No invoice yet.</Muted>
            )}
            <p>{ws.finance.paymentNote}</p>
            {ws.finance.deductions.map((d) => (
              <Muted key={d.deduction_id}>
                Deducted {eur(d.amount)} {d.note ?? ""}: {d.status}
              </Muted>
            ))}
            {ws.claims.map((c) => (
              <p key={c.claim_id}>
                Claim {c.claim_id}: {c.decision ?? "no verdict yet"} {c.amount != null ? eur(c.amount) : ""}, {c.status}. Outputs {c.outputs.join(", ") || "none"}
              </p>
            ))}
          </Section>
          <Section title={`History (${ws.history.length})`}>
            {ws.history.length ? (
              ws.history.map((h, i) => (
                <div key={i} className="grid grid-cols-[110px_140px_1fr] gap-2">
                  <span className="text-ink-68">{when(h.at)}</span>
                  <span className="truncate">{h.who}</span>
                  <span>
                    {h.action} {h.document ? <SourceTag>{h.document}</SourceTag> : null}
                  </span>
                </div>
              ))
            ) : (
              <Muted>No recorded actions yet.</Muted>
            )}
          </Section>
        </div>
      )}

      <a href={askHref(ws.askQuestion)} className="inline-block text-[13px] font-bold underline underline-offset-2">
        Ask about this order
      </a>
    </div>
  );
}

/** Chat card for order_workspace: the header, the journey and the summary. */
export function OrderWorkspaceCard({ output }: { readonly output: unknown }) {
  const o = (output ?? {}) as { workspace?: OrderWorkspace; error?: string };
  if (!o.workspace) {
    return (
      <Panel>
        <p className="text-[13px] text-ink-78">{o.error ?? "No order."}</p>
      </Panel>
    );
  }
  return (
    <Panel
      title={`Order ${o.workspace.orderRef}`}
      aside={<a href={`/orders?ref=${encodeURIComponent(o.workspace.orderRef)}`}>Open the workspace</a>}
    >
      <OrderWorkspaceBody ws={o.workspace} compact />
    </Panel>
  );
}
