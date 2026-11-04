/**
 * The dispatch day of 6 Nov 2026 (demo data, data/world/dispatch): six Arborio orders for five
 * delivery points go through the real Order path (received, checked, confirmed by the order desk,
 * handed to Shipping), so the logistics agent has a real day to plan. The plan itself is not made
 * here: Grok proposes it (shipping_plan_routes, or "Plan with Grok" on the Shipping page) and the
 * transport planner approves it.
 */
import { readdirSync, readFileSync } from "node:fs";
import type { Erp } from "../core/erp";
import { batches, recordEvent } from "../core/stock";
import { confirmOrder, receiveOrder } from "../order/service";
import { dataPath } from "../paths";
import { ingestConfirmedOrder } from "../shipping/service";

export const DISPATCH_DAY = "2026-11-06";

export async function seedDispatchDay(erp: Erp, opts: { say?: (line: string) => void } = {}): Promise<string[]> {
  const say = opts.say ?? (() => {});
  const dir = dataPath("world", "dispatch");
  const files = readdirSync(dir).filter((f) => f.startsWith("ORDERS_") && f.endsWith(".edi")).sort();
  if (!batches(erp, "8000000000000").some((b) => b.batch === "LOT-A-0312")) {
    recordEvent(erp, "batch_finished", { batch: "LOT-A-0312", gtin: "8000000000000", qty: 20000, note: "Arborio 1 kg, line 2, finished 5 Nov" });
  }
  const refs: string[] = [];
  for (const f of files) {
    const r = await receiveOrder(erp, readFileSync(`${dir}/${f}`, "utf8"), { sourceName: f });
    // The fixtures are clean orders: anything but a plain confirmation means the world changed.
    if (r.step !== "confirm") throw new Error(`${f}: expected a clean order, got step ${r.step} (${r.case_id})`);
    const handoff = confirmOrder(erp, r.case_id, { by: "Giulia, order desk", reason: "Stock and contract price check out" });
    ingestConfirmedOrder(erp, handoff);
    refs.push(r.order_ref ?? f);
  }
  say(`Dispatch day ${DISPATCH_DAY}: ${refs.length} orders confirmed and ready to ship (${refs.join(", ")})`);
  return refs;
}
