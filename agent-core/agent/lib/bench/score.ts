/**
 * Score our reconciliation against the threeway baseline on the labelled cases (port of
 * bench/score.py).
 *
 * Two questions per case:
 * - attention: does someone at Riso Scotti have to act?
 * - causes:    are all the causes named, and nothing else?
 *
 * threeway runs as ported in agent/lib/threeway/core.ts with its default settings (no
 * unit-conversion map). Ours is reconcileDocuments (agent/lib/shipping/reconcile.ts) with the
 * product list from data/world/products.json.
 */
import { readFileSync } from "node:fs";
import { dataPath } from "../paths";
import { type DocLine, type ProductInfo, reconcileDocuments } from "../shipping/reconcile";
import { ORPHAN_REASON, type RawLine, reconcile, TIMING_REASON, UOM_MISMATCH_REASON } from "../threeway/core";

export const casesPath = () => dataPath("bench", "cases.json");
export const productsPath = () => dataPath("world", "products.json");

export const THREEWAY_CAUSE: Record<string, string> = {
  "Invoiced but nothing received": "overbilled",
  "No receipt and no invoice yet": "not_shipped",
  "Billed for more than was received": "overbilled",
  "Received more than was ordered": "over_delivery",
  "Short delivery against the order": "short_delivery",
  "Invoice price differs from the PO price": "price_difference",
  "Value gap with matching quantities": "price_difference",
  [UOM_MISMATCH_REASON]: "uom_unknown",
  [TIMING_REASON]: "timing",
};

export type BenchCase = {
  id: string;
  kind: string;
  description: string;
  po: DocLine[];
  received: DocLine[];
  invoiced: DocLine[];
  expected: { attention: boolean; causes: string[] };
};

export type Answer = { attention: boolean; causes: string[] };

export type BenchRow = {
  id: string;
  kind: string;
  description: string;
  expected: Answer;
  threeway: Answer;
  ours: Answer;
  threeway_attention_ok: boolean;
  threeway_causes_ok: boolean;
  ours_attention_ok: boolean;
  ours_causes_ok: boolean;
};

export type BenchResult = {
  n: number;
  totals: { threeway_attention_ok: number; threeway_causes_ok: number; ours_attention_ok: number; ours_causes_ok: number };
  rows: BenchRow[];
};

function raw(lines: DocLine[], withPrice: boolean): RawLine[] {
  return lines.map((l) => ({
    poNumber: l.order_ref,
    itemCode: l.item_code,
    quantity: String(l.quantity),
    price: withPrice && l.unit_price != null ? String(l.unit_price) : null,
    uom: l.uom ?? null,
  }));
}

export function runThreeway(c: Pick<BenchCase, "po" | "received" | "invoiced">): Answer {
  const result = reconcile(raw(c.po, true), raw(c.received, false), raw(c.invoiced, true));
  const causes = new Set<string>();
  let attention = false;
  for (const line of result.lines) {
    if (line.status === "matched") continue;
    attention = true;
    if (line.reason === ORPHAN_REASON) causes.add(line.invoiced > 0 ? "orphan_invoice" : "orphan_receipt");
    else causes.add(THREEWAY_CAUSE[line.reason] ?? line.reason);
  }
  return { attention, causes: [...causes].sort() };
}

export function runOurs(c: Pick<BenchCase, "po" | "received" | "invoiced">, products: ProductInfo[]): Answer {
  const report = reconcileDocuments(c.po, c.received, c.invoiced, { products });
  return { attention: report.status !== "matched", causes: [...report.causes].sort() };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function score(cases = casesPath(), products = productsPath()): BenchResult {
  const allCases = (JSON.parse(readFileSync(cases, "utf8")) as { cases: BenchCase[] }).cases;
  const prods = (JSON.parse(readFileSync(products, "utf8")) as { products: ProductInfo[] }).products;
  const rows: BenchRow[] = allCases.map((c) => {
    const tw = runThreeway(c);
    const us = runOurs(c, prods);
    const exp = c.expected;
    return {
      id: c.id,
      kind: c.kind,
      description: c.description,
      expected: exp,
      threeway: tw,
      ours: us,
      threeway_attention_ok: tw.attention === exp.attention,
      threeway_causes_ok: sameList(tw.causes, exp.causes),
      ours_attention_ok: us.attention === exp.attention,
      ours_causes_ok: sameList(us.causes, exp.causes),
    };
  });
  const count = (k: keyof BenchResult["totals"]) => rows.filter((r) => r[k]).length;
  return {
    n: rows.length,
    totals: {
      threeway_attention_ok: count("threeway_attention_ok"),
      threeway_causes_ok: count("threeway_causes_ok"),
      ours_attention_ok: count("ours_attention_ok"),
      ours_causes_ok: count("ours_causes_ok"),
    },
    rows,
  };
}

export function fmt(result: Answer): string {
  return (result.attention ? "act" : "ok") + (result.causes.length ? `: ${result.causes.join(", ")}` : "");
}

export function toMarkdown(res: BenchResult): string {
  const { n, totals: t } = res;
  const mark = (ok: boolean) => (ok ? "" : " ✗");
  const out = [
    "# Reconciliation against the threeway baseline",
    "",
    `${n} labelled cases in \`data/bench/cases.json\`. Run \`python -m bench.score\` to reproduce.`,
    "",
    "| | threeway | ours |",
    "|---|---|---|",
    `| Right call on whether someone must act | ${t.threeway_attention_ok}/${n} | ${t.ours_attention_ok}/${n} |`,
    `| Every cause named, nothing extra | ${t.threeway_causes_ok}/${n} | ${t.ours_causes_ok}/${n} |`,
    "",
    "| Case | What happened | Right answer | threeway | ours |",
    "|---|---|---|---|---|",
  ];
  for (const r of res.rows) {
    out.push(
      `| ${r.id} | ${r.description} | ${fmt(r.expected)} | ${fmt(r.threeway)}` +
        `${mark(r.threeway_attention_ok && r.threeway_causes_ok)} | ${fmt(r.ours)}` +
        `${mark(r.ours_attention_ok && r.ours_causes_ok)} |`,
    );
  }
  out.push(
    "",
    "How to read this: we wrote these cases and their answers ourselves, before running either matcher, " +
      "to cover the blind spots we found in threeway's code. A full score on our own set shows those blind " +
      "spots are handled; it is not a measure of accuracy on documents we have not seen. threeway runs with " +
      "its default settings: it can convert units if it is given a conversion map, which the baseline does not have.",
    "",
  );
  return out.join("\n");
}
