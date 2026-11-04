/** Weekly digest for the accountant and managers, written from the Mini ERP (port of core/digest.py). */
import type { Erp } from "./erp";

export type Digest = {
  title: string;
  orders: { total: number; byStatus: Record<string, number> };
  invoices: { sent: number; net: number; gross: number; heldBack: string[] };
  claims: number;
  creditNotes: number;
  signoffs: { decided: number; waiting: number };
  waiting: { caseId: string; row: string; title: string | null; reasons: string[] }[];
  decided: { caseId: string; row: string; status: string; decidedBy: string | null; reason: string | null }[];
  shortDeliveries: { orderRef: string; gap: unknown }[];
  markdown: string;
};

const eur = (n: number) => `€${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function buildDigest(erp: Erp, title = "Weekly digest"): Digest {
  const orders = erp.orders();
  const invoices = erp.invoices();
  const claims = erp.claims();
  const signoffs = erp.signoffs();
  const creditNotes = erp.documents({ kind: "FatturaPA TD04" }).length;

  const sent = invoices.filter((i) => i.status === "sent");
  const held = invoices.filter((i) => i.status !== "sent");
  const net = sent.reduce((a, i) => a + (i.totalNet ?? 0), 0);
  const gross = sent.reduce((a, i) => a + (i.total ?? 0), 0);
  const byStatus: Record<string, number> = {};
  for (const o of orders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
  const waiting = signoffs.filter((c) => c.status === "pending");
  const decided = signoffs.filter((c) => c.status !== "pending");
  const gaps = orders.filter((o) => o.notes?.fulfilment_gap).map((o) => ({ orderRef: o.orderRef, gap: o.notes!.fulfilment_gap }));

  const statusText = Object.keys(byStatus).sort().map((k) => `${k} ${byStatus[k]}`).join(", ") || "none";
  const md = [`# ${title}`, ""];
  md.push(`- Orders received: ${orders.length} (${statusText})`);
  md.push(`- Invoices sent: ${sent.length}, net ${eur(net)}, with VAT ${eur(gross)}`);
  if (held.length) md.push(`- Invoices held back: ${held.length} (${held.map((i) => i.invoiceRef).join(", ")})`);
  md.push(`- Claims: ${claims.length}; credit notes issued: ${creditNotes}`);
  md.push(`- Sign-offs: ${decided.length} decided, ${waiting.length} waiting`);
  if (waiting.length) {
    md.push("", "## Waiting for a person");
    for (const c of waiting) md.push(`- ${c.caseId} (${c.row}): ${c.title}. Why: ${(c.reasons ?? []).join("; ")}`);
  }
  if (decided.length) {
    md.push("", "## Decided by a person");
    for (const c of decided) md.push(`- ${c.caseId} (${c.row}): ${c.status} by ${c.decidedBy}: ${c.decisionReason}`);
  }
  if (gaps.length) {
    md.push("", "## Short deliveries to follow up");
    for (const g of gaps) md.push(`- ${g.orderRef}: ${typeof g.gap === "string" ? g.gap : JSON.stringify(g.gap)}`);
  }

  return {
    title,
    orders: { total: orders.length, byStatus },
    invoices: { sent: sent.length, net, gross, heldBack: held.map((i) => i.invoiceRef) },
    claims: claims.length,
    creditNotes,
    signoffs: { decided: decided.length, waiting: waiting.length },
    waiting: waiting.map((c) => ({ caseId: c.caseId, row: c.row, title: c.title, reasons: c.reasons ?? [] })),
    decided: decided.map((c) => ({ caseId: c.caseId, row: c.row, status: c.status, decidedBy: c.decidedBy, reason: c.decisionReason })),
    shortDeliveries: gaps,
    markdown: `${md.join("\n")}\n`,
  };
}
