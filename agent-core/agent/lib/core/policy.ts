/**
 * Team policy read from agent-core/policy.json. Today only `order_confirmation`:
 * `always_person` (default, the Order team's rule) or `auto_when_clean`.
 * Read only: the auto-confirm path is not built, so `auto_when_clean` changes nothing yet.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../paths";

export type Policy = { order_confirmation: "always_person" | "auto_when_clean" };
export const DEFAULT_POLICY: Policy = { order_confirmation: "always_person" };

export function readPolicy(): Policy {
  try {
    const path = process.env.BRC_POLICY || join(repoRoot(), "agent-core", "policy.json");
    if (!existsSync(path)) return DEFAULT_POLICY;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Policy>;
    const oc = raw.order_confirmation === "auto_when_clean" ? "auto_when_clean" : "always_person";
    return { order_confirmation: oc };
  } catch {
    return DEFAULT_POLICY;
  }
}

export const policyLabel = (p: Policy) =>
  p.order_confirmation === "always_person" ? "Order confirmation: a person always confirms" : "Order confirmation: clean orders go through on their own";
