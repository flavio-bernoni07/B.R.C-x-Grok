/**
 * Starting stock of the products added in the TypeScript app (data/world/stock_more.json, demo
 * data), recorded as production events after the golden demo, so the golden order's event ids stay
 * those of the Python reference (tests/fixtures/trace_ESS-GOLD-001.json). Skips batches already there.
 */
import { readFileSync } from "node:fs";
import type { Erp } from "../core/erp";
import { recordEvent } from "../core/stock";
import { dataPath } from "../paths";

type RawEvent = { kind: string; batch: string; gtin?: string; qty?: number; available_from?: string; note?: string };

export function seedMoreStock(erp: Erp, opts: { say?: (line: string) => void } = {}): number {
  const { events } = JSON.parse(readFileSync(dataPath("world", "stock_more.json"), "utf8")) as { events: RawEvent[] };
  const known = new Set((erp.sqlite.prepare("SELECT batch FROM batches").all() as { batch: string }[]).map((b) => b.batch));
  let n = 0;
  for (const e of events) {
    if (e.kind !== "quality_hold" && known.has(e.batch)) continue;
    recordEvent(erp, e.kind, { batch: e.batch, gtin: e.gtin ?? null, qty: e.qty ?? null, availableFrom: e.available_from ?? null, note: e.note ?? null });
    n += 1;
  }
  opts.say?.(`More products: ${n} production events (data/world/stock_more.json)`);
  return n;
}
