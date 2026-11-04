/** The benchmark (port of bench/score.py): threeway against our reconciliation on 21 labelled cases. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { score, toMarkdown } from "../agent/lib/bench/score";
import { repoRoot } from "../agent/lib/paths";

describe("bench", () => {
  const res = score();

  it("reproduces the README numbers", () => {
    expect(res.n).toBe(21);
    expect(res.totals).toEqual({ threeway_attention_ok: 13, threeway_causes_ok: 10, ours_attention_ok: 21, ours_causes_ok: 21 });
  });

  it("gets every case right", () => {
    expect(res.rows.filter((r) => !(r.ours_attention_ok && r.ours_causes_ok)).map((r) => r.id)).toEqual([]);
  });

  it("writes the same table as docs/results.md", () => {
    expect(toMarkdown(res)).toBe(readFileSync(`${repoRoot()}/docs/results.md`, "utf8"));
  });
});
