"use client";

/**
 * Building blocks shared by the Orders page and the chat cards: the orders table, the status pill,
 * and the order detail (lines, checks with their sources, ORDRSP, audit trail). Kit only.
 */
import type { OrderCheck, OrderDetail, OrderSummary } from "@agent/lib/order/views";
import type { ReactNode } from "react";
import { type Column, DataTable, day, eur, Facts, Pill, qty, SourceTag } from "@/components/kit";

export function OrderPill({ order }: { readonly order: Pick<OrderSummary, "pill"> }) {
  return <Pill tone={order.pill.tone}>{order.pill.label}</Pill>;
}

export function OrdersTable({
  orders,
  onSelect,
  selected,
  compact = false,
}: {
  readonly orders: OrderSummary[];
  readonly onSelect?: (o: OrderSummary) => void;
  readonly selected?: string;
  readonly compact?: boolean;
}) {
  const columns: Column<OrderSummary>[] = [
    { key: "order", header: "Order", main: true, cell: (o) => o.orderRef },
    { key: "retailer", header: "Retailer", cell: (o) => o.retailer },
    ...(compact
      ? []
      : [
          { key: "date", header: "Date", cell: (o: OrderSummary) => day(o.orderDate) },
          { key: "qty", header: "Qty", align: "right" as const, cell: (o: OrderSummary) => qty(o.qtyConfirmed ?? o.qtyOrdered) },
        ]),
    {
      key: "check",
      header: "Check",
      cell: (o) => (
        <span className="inline-block max-w-[340px] truncate align-middle" title={o.check}>
          {o.check}
        </span>
      ),
    },
    { key: "status", header: "Status", align: "right", cell: (o) => <OrderPill order={o} /> },
  ];
  return (
    <DataTable
      columns={columns}
      rows={orders}
      rowKey={(o) => o.orderRef}
      onRowClick={onSelect}
      selectedKey={selected}
      empty="No orders yet. Send an ORDERS message to start."
    />
  );
}

function CheckMark({ ok }: { readonly ok: boolean | null }) {
  if (ok === true) return <Pill tone="ok">Pass</Pill>;
  if (ok === false) return <Pill tone="attention">Stopped</Pill>;
  return <Pill tone="wait">Open</Pill>;
}

export function OrderChecks({ checks }: { readonly checks: OrderCheck[] }) {
  return (
    <ul className="space-y-2.5">
      {checks.map((c) => (
        <li key={c.name} className="flex items-start justify-between gap-3 border-hairline border-t pt-2.5 first:border-t-0 first:pt-0">
          <div className="min-w-0">
            <div className="font-bold text-[14px] tracking-[-0.02em]">{c.name}</div>
            <div className="mt-0.5 text-[13px] text-ink-78">{c.detail}</div>
            <div className="mt-1">
              <SourceTag title="Where this check reads from">{c.source}</SourceTag>
            </div>
          </div>
          <CheckMark ok={c.ok} />
        </li>
      ))}
    </ul>
  );
}

function Section({ title, aside, children }: { readonly title: string; readonly aside?: ReactNode; readonly children: ReactNode }) {
  return (
    <section className="space-y-2">
      <header className="flex items-baseline justify-between gap-3">
        <h4 className="font-bold text-[14px] tracking-[-0.02em]">{title}</h4>
        {aside ? <span className="text-[12px] text-ink-68">{aside}</span> : null}
      </header>
      {children}
    </section>
  );
}

const Edi = ({ text }: { readonly text: string }) => (
  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-[10px] bg-hh-honeydew p-2.5 font-mono text-[11.5px] text-ink-78 leading-relaxed">
    {text.replace(/'(?!$)/g, "'\n")}
  </pre>
);

export function OrderLines({ order }: { readonly order: OrderDetail }) {
  return (
    <DataTable
      columns={[
        { key: "n", header: "#", width: "28px", cell: (l) => l.lineNo },
        {
          key: "product",
          header: "Product",
          main: true,
          cell: (l) => (
            <span title={l.gtin ?? undefined}>
              {l.product ?? l.gtin ?? "–"}
            </span>
          ),
        },
        { key: "ordered", header: "Ordered", align: "right", cell: (l) => qty(l.qtyOrdered) },
        { key: "confirmed", header: "Confirmed", align: "right", cell: (l) => qty(l.qtyConfirmed) },
        {
          key: "price",
          header: "Price",
          align: "right",
          cell: (l) => (
            <span title={l.contractPrice != null ? `Contract ${eur(l.contractPrice)}` : undefined}>{eur(l.unitPrice)}</span>
          ),
        },
      ]}
      rows={order.lines}
      rowKey={(l) => String(l.lineNo)}
    />
  );
}

/** The full order: what the detail panel and the chat card for one order show. */
export function OrderDetailBody({ order, compact = false }: { readonly order: OrderDetail; readonly compact?: boolean }) {
  const ordrsp = order.ordrsp ?? order.draftOrdrsp;
  return (
    <div className="space-y-5">
      <Facts
        items={[
          ["Retailer", order.retailer],
          ["Order date", day(order.orderDate)],
          ["Status", order.status.replace(/_/g, " ")],
          ["Deciding check", order.check],
          ...(order.contractId ? ([["Contract", <SourceTag key="c">{order.contractId}</SourceTag>]] as [ReactNode, ReactNode][]) : []),
          ...(order.caseId ? ([["Sign-off", `${order.caseId} (${order.caseStatus})`]] as [ReactNode, ReactNode][]) : []),
        ]}
      />

      <Section title="Lines">
        <OrderLines order={order} />
      </Section>

      <Section title="Checks" aside="code first, Grok on exceptions, a person confirms">
        <OrderChecks checks={order.checks} />
      </Section>

      {order.grokbot.length ? (
        <Section title="Grokbot">
          <ul className="space-y-1.5 text-[13px] text-ink-78">
            {order.grokbot.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {order.draftMail ? (
        <Section title="Draft price mail" aside="a person reviews and sends it">
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-[10px] bg-hh-honeydew p-2.5 text-[12.5px] text-ink-78">{order.draftMail}</pre>
        </Section>
      ) : null}

      {ordrsp ? (
        <Section title={order.ordrsp ? "ORDRSP sent" : "Draft ORDRSP"} aside={order.ordrspRef ?? "sent only after a person confirms"}>
          <Edi text={ordrsp} />
        </Section>
      ) : null}

      {!compact && order.documents.length ? (
        <Section title="Documents">
          <ul className="space-y-1 text-[13px]">
            {order.documents.map((d) => (
              <li key={d.docId} className="flex items-center gap-2">
                <SourceTag>{d.docId}</SourceTag>
                <span className="font-bold">{d.kind}</span>
                {d.path ? <span className="truncate text-ink-68">{d.path}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {!compact && order.audit.length ? (
        <Section title="Audit trail">
          <ol className="space-y-1.5 text-[12.5px]">
            {order.audit.map((a) => (
              <li key={a.id} className="grid grid-cols-[92px_1fr] gap-2">
                <span className="text-ink-68 tabular-nums">{a.at.slice(11, 19)}</span>
                <span className="min-w-0">
                  <span className="font-bold">{a.actor}</span> <span className="text-ink-78">{a.action}</span>
                  {a.sourceDoc ? (
                    <>
                      {" "}
                      <SourceTag>{a.sourceDoc}</SourceTag>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}
    </div>
  );
}
