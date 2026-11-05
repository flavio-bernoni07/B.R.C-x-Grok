/**
 * The tests assert the Order team's rule (a person confirms every order) unless a test says
 * otherwise: the repo's policy.json is `auto_when_clean` (Grok confirms clean orders), so pin the
 * suite to `always_person`. A test that checks Grok's confirmation points BRC_POLICY elsewhere.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.BRC_POLICY) {
  const path = join(mkdtempSync(join(tmpdir(), "brc-policy-")), "policy.json");
  writeFileSync(path, JSON.stringify({ order_confirmation: "always_person" }));
  process.env.BRC_POLICY = path;
}
