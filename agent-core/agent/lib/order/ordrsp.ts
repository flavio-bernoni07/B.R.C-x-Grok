/** Emit a minimal EDIFACT-like ORDRSP from a confirmed parsed order (port of order/ordrsp.py). */
import type { ParsedOrder } from "./parser";
import { pyFloat } from "./py";

export type HandoffLine = { line_no: number; gtin: string | null; quantity: number | null; unit_price: number | null };

/** The hand-over Shipping receives (Python `build_ordrsp().handoff`, snake_case keys). */
export type OrdrspHandoff = {
  order_number: string;
  buyer_gln: string | null;
  supplier_gln: string | null;
  order_date: string | null;
  lines: HandoffLine[];
  ordrsp: string;
};

export type OrdrspDocument = { order_number: string; body: string; handoff: OrdrspHandoff };

const todayCompact = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

/** `int(q)` when q is whole, else q itself (Python prints None as "None"). */
export const qtyText = (q: number | null | undefined) => (q == null ? "None" : String(q));

export function buildOrdrsp(order: ParsedOrder, opts: { responseDate?: string | null } = {}): OrdrspDocument {
  if (!order.order_number) throw new Error("Cannot build ORDRSP without order_number");
  const today = opts.responseDate || todayCompact();
  const segments = [
    "UNH+1+ORDRSP:D:96A:UN'",
    `BGM+231+${order.order_number}+29'`, // 29 = accepted (demo)
    `DTM+137:${today}:102'`,
    `RFF+ON:${order.order_number}'`,
  ];
  if (order.buyer_gln) segments.push(`NAD+BY+${order.buyer_gln}::9'`);
  if (order.supplier_gln) segments.push(`NAD+SU+${order.supplier_gln}::9'`);

  const handoffLines: HandoffLine[] = [];
  order.lines.forEach((line, i) => {
    const n = line.line_no || i + 1;
    segments.push(`LIN+${n}++${line.gtin || ""}:EN'`);
    segments.push(`QTY+21:${qtyText(line.quantity)}'`);
    if (line.unit_price != null) segments.push(`PRI+AAA:${pyFloat(line.unit_price)}:CT'`);
    handoffLines.push({ line_no: n, gtin: line.gtin, quantity: line.quantity, unit_price: line.unit_price });
  });

  segments.push("UNS+S'");
  segments.push(`UNT+${segments.length + 1}+1'`);
  const body = segments.join("");
  return {
    order_number: order.order_number,
    body,
    handoff: {
      order_number: order.order_number,
      buyer_gln: order.buyer_gln,
      supplier_gln: order.supplier_gln,
      order_date: order.order_date,
      lines: handoffLines,
      ordrsp: body,
    },
  };
}
