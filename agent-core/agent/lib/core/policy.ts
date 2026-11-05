/**
 * Team policy read from agent-core/policy.json (BRC_POLICY overrides the path). Today only
 * `order_confirmation`:
 *
 *   always_person    a person confirms every order before ORDRSP (the Order team's first rule,
 *                    and the default when the file is missing or unreadable)
 *   auto_when_clean  an order that passes every check with no Grok correction, no split and no
 *                    price issue is confirmed by Grok, the order agent (order/service.ts
 *                    `receiveOrder`); anything else still waits for a person
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../paths";

export type Policy = { order_confirmation: "always_person" | "auto_when_clean" };
export const DEFAULT_POLICY: Policy = { order_confirmation: "always_person" };
export const ALWAYS_PERSON: Policy = { order_confirmation: "always_person" };
export const AUTO_WHEN_CLEAN: Policy = { order_confirmation: "auto_when_clean" };

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
  p.order_confirmation === "always_person"
    ? "Order confirmation: a person always confirms"
    : "Order confirmation: Grok confirms clean orders, a person confirms every exception";
