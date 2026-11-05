import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOSTED_TMP = join(process.env.TMPDIR || "/tmp", "brc-repo-root");

describe("hosted repo root pack", () => {
  beforeEach(() => {
    rmSync(HOSTED_TMP, { recursive: true, force: true });
    process.env.BRC_FORCE_HOSTED_ROOT = "1";
    delete process.env.RICE_REPO_ROOT;
  });

  afterEach(() => {
    delete process.env.BRC_FORCE_HOSTED_ROOT;
    rmSync(HOSTED_TMP, { recursive: true, force: true });
  });

  it("materializes DECISIONS.md and demo data when the checkout is unavailable", async () => {
    const { repoRoot, dataPath } = await import("../agent/lib/paths");
    const root = repoRoot();
    expect(root).toBe(HOSTED_TMP);
    expect(existsSync(join(root, "DECISIONS.md"))).toBe(true);
    expect(existsSync(dataPath("world", "products.json"))).toBe(true);
    expect(existsSync(dataPath("world", "split"))).toBe(true);
  });
});
