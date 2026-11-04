/**
 * What a new app database is filled with: the golden order through every row, then the demo
 * scenarios (scenarios.ts). Offline with recorded Grok answers; the `demo.seeded` audit entry is
 * how the UI knows to mark Grok steps as recorded, not live.
 */
import type { Erp } from "../core/erp";
import { runGolden } from "./golden";
import { seedScenarios } from "./scenarios";

export async function seedDemo(erp: Erp, opts: { say?: (line: string) => void } = {}) {
  const golden = await runGolden(erp, { say: opts.say });
  const scenarios = await seedScenarios(erp);
  opts.say?.(`== Scenarios\nESS-AMB-001: ${scenarios.ambiguousOrder.status} (${scenarios.ambiguousOrder.case_id ?? "already there"})`);
  erp.log("code", "demo.seeded", null, { detail: { grok: "recorded", scenarios: Object.keys(scenarios) } });
  return { golden, scenarios };
}
