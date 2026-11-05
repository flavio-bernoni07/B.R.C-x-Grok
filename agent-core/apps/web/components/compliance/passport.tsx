"use client";

/**
 * Lot compliance passport — denseness and Facts layout match the rest of the desk.
 * Status is one clear line; Fairtrade/SRP are scheme labels, not a second traffic-light.
 */
import type { LotPassport, OrderCompliance } from "@agent/lib/compliance/passport";
import { Facts, Pill } from "@/components/kit";

const DOC_HREF = (docId: string) => `/api/documents/${encodeURIComponent(docId)}?inline=1`;

function DocChip({ docId, label }: { readonly docId: string; readonly label: string }) {
  return (
    <a
      href={DOC_HREF(docId)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center rounded-md bg-hh-honeydew px-2.5 py-1 text-[12px] font-medium text-ink no-underline hover:bg-hh-mint"
    >
      {label}
    </a>
  );
}

function statusLabel(p: LotPassport): string {
  if (p.status === "gap") return "Needs papers";
  return "Compliant";
}

export function PassportBody({ p, compact }: { readonly p: LotPassport; readonly compact?: boolean }) {
  const schemes = p.badges.length ? p.badges.join(", ") : "None claimed on this lot";
  return (
    <div className={compact ? "space-y-3 text-[13px]" : "space-y-4 text-[14px]"}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={p.status === "ok" ? "ok" : "attention"}>{statusLabel(p)}</Pill>
        {p.batchStatus === "hold" ? <Pill tone="attention">On hold</Pill> : null}
        <span className="text-[13px] text-ink-68">Lot mark {p.lotMark}</span>
      </div>
      {p.status === "gap" ? <p className="text-[13px] text-st-pending-ink">{p.statusText}</p> : null}

      <Facts
        items={[
          ["Variety", p.variety],
          ["Origin", p.origin.label],
          ["Lab residues", p.mrl.status === "pass" ? `Pass (${p.mrl.reportId})` : p.mrl.status],
          ["GMO", p.gmo.status === "ok" ? "Declaration on file" : p.gmo.summary],
          ["Plant certs", p.plant.certs.map((c) => c.scheme.replace(/ Food Safety$| Food$/, "")).join(", ")],
          ["Extra schemes", schemes],
        ]}
      />

      {!compact ? (
        <>
          <div>
            <p className="mb-1 font-bold text-[13px] tracking-[-0.02em]">From the farm</p>
            <p className="text-ink-78">
              {p.oneStepBack.supplier}
              <br />
              {p.oneStepBack.farm}, {p.oneStepBack.region}
              <br />
              {p.oneStepBack.tonnes} t received {p.oneStepBack.receivedOn}
            </p>
            <p className="mt-1 text-[12px] text-ink-68">Intake {p.oneStepBack.intakeId} — Reg (EC) 178/2002 Art. 18</p>
          </div>
          <div>
            <p className="mb-1 font-bold text-[13px] tracking-[-0.02em]">Shipped to</p>
            {p.oneStepForward.length ? (
              <ul className="space-y-1">
                {p.oneStepForward.map((c) => (
                  <li key={`${c.orderRef}-${c.desadv ?? "x"}`} className="flex flex-wrap gap-x-2">
                    <a href={`/orders?ref=${encodeURIComponent(c.orderRef)}`} className="font-bold text-ink no-underline hover:text-ink-78">
                      {c.orderRef}
                    </a>
                    <span className="text-ink-68">
                      {c.retailer ?? "retailer"}
                      {`, ${Math.round(c.qty).toLocaleString("en-GB")} packs`}
                      {c.desadv ? `, ${c.desadv}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-68">Not on a shipment yet.</p>
            )}
          </div>
        </>
      ) : null}

      {p.documents.length ? (
        <div>
          <p className="mb-1.5 font-bold text-[13px] tracking-[-0.02em]">Documents</p>
          <div className="flex flex-wrap gap-1.5">
            {p.documents.map((d) => (
              <DocChip key={d.docId} docId={d.docId} label={d.kind} />
            ))}
          </div>
        </div>
      ) : null}
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
          {o.passport.gtin ? (
            <a className="text-[12px] font-bold text-ink-78 no-underline hover:text-ink" href={`/stock?product=${encodeURIComponent(o.passport.gtin)}`}>
              Open in Stock
            </a>
          ) : null}
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
        <Pill tone={data.status === "ok" ? "ok" : "attention"}>{data.status === "ok" ? "Compliant" : "Needs papers"}</Pill>
        <span className="text-[13px] text-ink-68">{data.statusText}</span>
      </div>
      {data.passports.map((p) => (
        <div key={p.batch} className="space-y-1.5 border-hairline border-t pt-2.5 first:border-0 first:pt-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-bold text-[13px]">{p.batch}</p>
            {p.gtin ? (
              <a href={`/stock?product=${encodeURIComponent(p.gtin)}`} className="text-[12px] font-bold text-ink-78 no-underline hover:text-ink">
                Full passport
              </a>
            ) : null}
          </div>
          <PassportBody p={p} compact />
        </div>
      ))}
    </div>
  );
}
