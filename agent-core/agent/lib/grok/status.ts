/**
 * What the UI may honestly say about Grok: whether a key is set (in this process, or in
 * agent-core/.env.local, which eve loads for the chat; the Next routes do not read that file),
 * and whether the records came from the offline demo seed, whose Grok steps are recorded answers.
 * It never says a call is running, and never reads out the key.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Erp } from "../core/erp";
import { repoRoot } from "../paths";
import { hasKey } from "./client";

export function grokKeySet(): boolean {
  if (hasKey()) return true;
  const file = join(repoRoot(), "agent-core", ".env.local");
  try {
    return existsSync(file) && /^\s*(XAI_API_KEY|GROK_API_KEY)\s*=\s*\S+/m.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

export function grokStatus(erp: Erp) {
  return { key: grokKeySet(), recorded_demo: erp.auditLog().some((a) => a.action === "demo.seeded") };
}
