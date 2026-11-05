"use client";

/**
 * Lot compliance passport — same denseness as Stock drawer / Order workspace sections.
 * No new nav: this panel is embedded under a batch row or in an order Section.
 */
import type { LotPassport, OrderCompliance } from "@agent/lib/compliance/passport";
import type { ReactNode } from "react";
import { Pill, type PillTone, SourceTag } from "@/components/kit";

const DOC_HREF = (docId: string) => `/api/documents/${encodeURIComponent(docId)}?inline=1`;

function DocLink({ docId, children }: { readonly docId: string; readonly children: ReactNode }) {
  return (
    <a href={DOC_HREF(docId)} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
      {children}
    </a>
  );
}

export function PassportBody({ p, compact }: { readonly p: LotPassport; readonly compact?: boolean }) {
  const tone: PillTone = p.status === "ok" ? "ok" : "attention";
  return (
    <div className={compact ? "space-y-2 text-[13px]" : "space-y-3 text-[14px]"}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={tone}>{p.status === "ok" ? "Docs on file" : "Gap"}</Pill>
        {p.badges.map((b) => (
          <Pill key={b} tone="quiet">
            {b}
          </Pill>
        ))}
        {p.batchStatus === "hold" ? <Pill tone="attention">On hold</Pill> : null}
      </div>
      <p className="text-ink-78">
        <b className="text-ink">{p.lotMark}</b>
        {p.variety ? ` · ${p.variety}` : ""}
        {p.product ? ` · ${p.product}` : ""}
      </p>
      <p>
        <span className="text-ink-68">Origin · </span>
        {p.origin.label}
      </p>
      <p>
        <span className="text-ink-68">Lab MRL · </span>
        {p.mrl.status === "pass" ? "Pass" : p.mrl.status} ({p.mrl.reportId}, {p.mrl.testedOn})
      </p>
      <p>
        <span className="text-ink-68">GMO · </span>
        {p.gmo.status === "ok" ? "Declaration on file" : p.gmo.summary}
      </p>
      <p>
        <span className="text-ink-68">Plant · </span>
        {p.plant.certs.map((c) => c.scheme).join(", ")}
      </p>
      {!compact ? (
        <>
          <div>
            <p className="font-bold text-[13px] tracking-[-0.02em]">One step back</p>
            <p className="text-ink-78">
              {p.oneStepBack.supplier} · {p.oneStepBack.farm}, {p.oneStepBack.region} · {p.oneStepBack.tonnes} t on {p.oneStepBack.receivedOn}
            </p>
            <p className="text-[12px] text-ink-68">Intake {p.oneStepBack.intakeId} · Reg (EC) 178/2002 Art. 18</p>
          </div>
          <div>
            <p className="font-bold text-[13px] tracking-[-0.02em]">One step forward</p>
            {p.oneStepForward.length ? (
              <ul className="space-y-1">
                {p.oneStepForward.map((c) => (
                  <li key={`${c.orderRef}-${c.desadv ?? "x"}`} className="flex flex-wrap gap-x-2">
                    <a href={`/orders?ref=${encodeURIComponent(c.orderRef)}`} className="font-bold hover:underline">
                      {c.orderRef}
                    </a>
                    <span className="text-ink-68">
                      {c.retailer ?? "retailer"} · {Math.round(c.qty).toLocaleString("en-GB")}
                      {c.desadv ? ` · ${c.desadv}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-68">Not shipped on any order yet.</p>
            )}
          </div>
        </>
      ) : null}
      {p.documents.length ? (
        <div className="flex flex-wrap gap-1.5">
          {p.documents.map((d) => (
            <SourceTag key={d.docId}>
              <DocLink docId={d.docId}>{d.kind}</DocLink>
            </SourceTag>
          ))}
        </div>
      ) : null}
      {p.status === "gap" ? <p className="text-[13px] text-st-pending-ink">{p.statusText}</p> : null}
    </div>
  );
}

/** Chat card for `compliance_passport`. */
export function CompliancePassportCard({ output }: { readonly output: unknown }) {
  const o = (output ?? {}) as { passport?: LotPassport; passports?: LotPassport[]; statusText?: string; error?: string; orderRef?: string };
  if (o.error) {
    return (
      <div className="rounded-[14px] bg-white/70 p-4 ring-1 ring-hairline">
        <p className="text-[14px] text-ink-68">{o.error}</p>
      </div>
    );
  }
  if (o.passport) {
    return (
      <div className="rounded-[14px] bg-white/70 p-4 ring-1 ring-hairline">
        <header className="mb-3 flex items-baseline justify-between gap-3">
          <h3 className="font-bold text-[15px] tracking-[-0.02em]">Lot {o.passport.batch}</h3>
          <a className="text-[12px] text-ink-68 underline underline-offset-2" href={`/stock?product=${encodeURIComponent(o.passport.gtin ?? "")}`}>
            Open in Stock
          </a>
        </header>
        <PassportBody p={o.passport} />
      </div>
    );
  }
  const list = o.passports ?? [];
  return (
    <div className="rounded-[14px] bg-white/70 p-4 ring-1 ring-hairline">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="font-bold text-[15px] tracking-[-0.02em]">Compliance{o.orderRef ? ` · ${o.orderRef}` : ""}</h3>
        <span className="text-[12px] text-ink-68">{o.statusText}</span>
      </header>
      <div className="space-y-4">
        {list.map((p) => (
          <div key={p.batch} className="border-hairline border-t pt-3 first:border-0 first:pt-0">
            <p className="mb-1.5 font-bold text-[14px]">{p.batch}</p>
            <PassportBody p={p} compact />
          </div>
        ))}
      </div>
    </div>
  );
}

export function OrderComplianceSection({ data }: { readonly data: OrderCompliance }) {
  if (data.status === "none") {
    return <p className="text-[13px] text-ink-68">{data.statusText}</p>;
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={data.status === "ok" ? "ok" : "attention"}>{data.status === "ok" ? "Docs on file" : "Gap"}</Pill>
        <span className="text-[13px] text-ink-68">{data.statusText}</span>
      </div>
      {data.passports.map((p) => (
        <div key={p.batch} className="space-y-1.5 border-hairline border-t pt-2.5 first:border-0 first:pt-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <SourceTag>{p.batch}</SourceTag>
            <span className="text-[12px] text-ink-68">{p.lotMark}</span>
            {p.gtin ? (
              <a href={`/stock?product=${encodeURIComponent(p.gtin)}`} className="text-[12px] font-bold text-ink-78 hover:underline">
                Full passport ›
              </a>
            ) : null}
          </div>
          <PassportBody p={p} compact />
        </div>
      ))}
    </div>
  );
}
