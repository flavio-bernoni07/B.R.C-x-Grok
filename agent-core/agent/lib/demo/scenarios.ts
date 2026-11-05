/**
 * Demo scenarios seeded after the golden order, so the operations workspace opens on real cases
 * (OPS-WORKSPACE-PROMPT.md section 8). Same backend code as a live run; Grok's answers are the
 * recorded ones in data/world/scenarios/ unless a key is set and `live` is passed.
 *
 * - ESS-AMB-001: Esselunga's ORDERS with a dd/mm/yyyy date and "6.000" packs. The parser flags it,
 *   Grok corrects both fields (parsed again by code), every check passes, and the order waits at
 *   the Ready-to-ship card for the one approval a person gives.
 */
import { readFileSync } from "node:fs";
import type { Erp } from "../core/erp";
import { receiveOrder } from "../order/service";
import { dataPath } from "../paths";

const scenario = (...f: string[]) => dataPath("world", "scenarios", ...f);

export type ScenarioSeed = { ambiguousOrder: { order_ref: string | null; case_id: string | null; status: string } };

export async function seedScenarios(erp: Erp, opts: { live?: boolean } = {}): Promise<ScenarioSeed> {
  const recorded = JSON.parse(readFileSync(scenario("ambiguous_order", "grok_recorded.json"), "utf8")) as Record<string, unknown>;
  const already = erp.order("ESS-AMB-001");
  if (already) return { ambiguousOrder: { order_ref: already.orderRef, case_id: null, status: already.status } };
  const r = await receiveOrder(erp, readFileSync(scenario("ambiguous_order", "ORDERS_ESS-AMB-001.edi"), "utf8"), {
    sourceName: "ORDERS_ESS-AMB-001.edi",
    caller: opts.live ? null : () => JSON.parse(JSON.stringify(recorded.fix_parse)),
  });
  return { ambiguousOrder: { order_ref: r.order_ref ?? null, case_id: r.case_id ?? null, status: r.status } };
}
