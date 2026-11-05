/**
 * A split delivery (demo data, data/world/split): after the golden order, Carrefour orders more Carnaroli
 * than is free, so the order row's stock-short step runs. Run it after runGolden's earlier steps. Code computes the allowed answers from stock,
 * Grok picks the split and writes the retailer message (recorded answer offline), and the order desk
 * confirms. The part in stock joins the 6 Nov dispatch; the rest is a backorder from the next batch.
 */
import { readFileSync } from "node:fs";
import type { Erp } from "../core/erp";
import { batches, recordEvent } from "../core/stock";
import type { Caller } from "../grok/client";
import { confirmOrder, receiveOrder, resolveQtyCase } from "../order/service";
import { dataPath } from "../paths";
import { ingestConfirmedOrder } from "../shipping/service";

export const SPLIT_ORDER = "CRF-SPL-002";
const CARNAROLI = "8000000000001";

/** Replays the recorded Grok answer for the stock-short step. */
export function splitCaller(): Caller {
  const recorded = JSON.parse(readFileSync(dataPath("world", "split", "grok_recorded.json"), "utf8")) as Record<string, unknown>;
  return () => JSON.parse(JSON.stringify(recorded["order.qty_short"]));
}

export async function seedSplitOrder(erp: Erp, opts: { say?: (line: string) => void; caller?: Caller | null } = {}): Promise<string | null> {
  const say = opts.say ?? (() => {});
  // A small Carnaroli run just finished; the next one (LOT-C-0419, 4,000 packs) is planned for 9 Nov.
  // 4,200 packs: ESS-GOLD-001 still holds its 12,000 at the dock (case study), so 3,000 are free.
  if (!batches(erp, CARNAROLI).some((b) => b.batch === "LOT-C-0420")) {
    recordEvent(erp, "batch_finished", { batch: "LOT-C-0420", gtin: CARNAROLI, qty: 4200, note: "Carnaroli 1 kg, line 1, short run finished 5 Nov" });
  }
  const file = `ORDERS_${SPLIT_ORDER}.edi`;
  const caller = opts.caller === undefined ? splitCaller() : opts.caller;
  let r = await receiveOrder(erp, readFileSync(dataPath("world", "split", file), "utf8"), {
    sourceName: file,
    caller,
  });
  // Stock short stops at the person's choice. The demo takes Grok's split, then confirms it.
  if (r.step === "qty_choice") {
    const chosen = await resolveQtyCase(erp, r.case_id, {
      by: "Giulia, order desk",
      reason: "Grok's split works for Carrefour: the rest comes with the next batch",
      action: "split",
      caller,
    });
    if (chosen.status !== "awaiting_person" && chosen.status !== "confirmed") {
      throw new Error(`${file}: split did not return an order to confirm (${chosen.status})`);
    }
    r = chosen;
  }
  if (r.step !== "confirm" && r.step !== "auto_confirmed") throw new Error(`${file}: expected a split to confirm, got step ${r.step} (${r.case_id})`);
  if (r.step === "auto_confirmed") {
    say(`Split: ${SPLIT_ORDER} ships what is free on the dispatch day`);
    return r.order_ref;
  }
  const handoff = confirmOrder(erp, r.case_id, { by: "Giulia, order desk", reason: "Grok's split works for Carrefour: the rest comes with the next batch" });
  ingestConfirmedOrder(erp, handoff);
  const b = handoff.backorders[0];
  say(`Split: ${SPLIT_ORDER} ships what is free on the dispatch day${b ? `, ${b.qty} more from ${b.date}` : ""}`);
  return r.order_ref;
}
