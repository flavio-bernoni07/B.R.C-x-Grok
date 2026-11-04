/** core/trace.py parity: the chain behind ESS-GOLD-001 after the golden demo matches the Python reference. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chain, gaps, render } from "../agent/lib/core/trace";
import { freshErp } from "../agent/lib/core/world";
import { runGolden } from "../agent/lib/demo/golden";
import { orderWorkspace } from "../agent/lib/order/workspace";
import { ordersInbox } from "../agent/lib/order/inbox";

// Produced by core.trace.chain after the same golden steps as agent/lib/demo/golden.ts
// (python, demo.py without RECADV and remittance), audit `at` blanked.
const REF = JSON.parse(readFileSync(join(__dirname, "fixtures", "trace_ESS-GOLD-001.json"), "utf8"));

describe("trace (core/trace.py)", () => {
  it("walks the golden order like the Python", async () => {
    process.env.BRC_PLAYBOOK = "/tmp/brc-trace-playbook-test.md";
    const erp = freshErp();
    await runGolden(erp);
    const c = chain(erp, "ESS-GOLD-001");
    const got = JSON.parse(JSON.stringify({ ...c, audit: c.audit.map((a) => ({ ...a, at: null })) }));
    expect(got).toEqual(REF);
    expect(gaps(erp)).toEqual([]);
    expect(render(c)).toContain("DESADV   DESADV-ESS-GOLD-001-1");
    expect(() => chain(erp, "NOPE")).toThrow();

    const ws = orderWorkspace(erp, "ESS-GOLD-001")!;
    const step = (k: string) => ws.journey.find((s) => s.key === k)!;
    expect(step("received").done).toBe(true);
    expect(step("dispatched").done).toBe(true);
    expect(step("received_by_retailer").done).toBe(true);
    expect(step("paid").done).toBe(false);
    expect(step("claim").done).toBe(true);
    expect(ws.summary.shipped).toBe(10800);
    expect(ws.counter.people).toBe(c.audit.filter((a) => a.actor.startsWith("person:")).length + c.exception_cases.filter((x) => x.approved_by).length);
    expect(ws.counter.agents).toBe(c.audit.filter((a) => a.actor === "code" || a.actor === "grok").length);

    const inbox = ordersInbox(erp);
    const row = inbox.find((r) => r.orderRef === "ESS-GOLD-001")!;
    expect(row.statusLine).toContain("10,800");
    expect(ordersInbox(erp, { q: "zzz-nothing" })).toEqual([]);
  });
});
