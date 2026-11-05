/** The hard case (demo/extreme.ts): one Coop order through every exception, closed with its story. */
import { describe, expect, it } from "vitest";
import { availableToPromise } from "../agent/lib/core/stock";
import { freshErp } from "../agent/lib/core/world";
import { SHOWCASE_ORDER } from "../agent/lib/demo/extreme";
import { runGolden } from "../agent/lib/demo/golden";
import { orderWorkspace } from "../agent/lib/order/workspace";

describe("the hard case, closed", () => {
  it("fixes, splits, books a loss, rejects the claim with a person, and closes", async () => {
    process.env.BRC_PLAYBOOK = "/tmp/brc-extreme-playbook-test.md";
    const erp = freshErp();
    await runGolden(erp, {});
    const ws = orderWorkspace(erp, SHOWCASE_ORDER)!;

    expect(ws.status).toBe("completed");
    expect(ws.exceptions).toEqual([]);
    const text = ws.story.map((s) => s.text).join("\n");
    expect(text).toContain("Grok fixes the order it could not read");
    expect(text).toContain("Grok splits the order");
    // On the wrong truck Grok asks instead of picking; Luca chooses the loss, and accounting gets its note.
    const asks = ws.story.find((s) => s.text.startsWith("Grok flags it and asks what to do"))!;
    expect(asks.text).toContain("hold the truck and scan the pallet again, or ship without the pallet and book it as a loss");
    expect(asks.options).toHaveLength(2);
    expect(text).not.toContain("Grok proposes: ship without the pallet");
    expect(text).not.toContain("Luca Galli agrees with Grok");
    expect(text).toContain("Luca Galli chooses: ship without the pallet and book it as a loss");
    expect(text).toMatch(/as a loss: write-off note DOC-\d+ for accounting/);
    expect(ws.story.find((s) => s.text.includes("write-off note"))!.quote).toContain("No time to wait");
    expect(erp.documents({ ref: SHOWCASE_ORDER, kind: "write-off note" })).toHaveLength(1);
    expect(text).toContain("Grok's verdict: reject the claim");
    expect(text).toContain("pays");
    // Every rejection and every fix is a named person's call.
    expect(new Set(ws.story.filter((s) => s.who === "person").map((s) => s.name))).toEqual(new Set(["Giulia Ferri", "Luca Galli", "Marco Bellini"]));
    // The live ambiguous-order demo (ESS-AMB-001) still finds its 6,000 Arborio packs.
    expect(availableToPromise(erp, "8000000000000").atp).toBeGreaterThanOrEqual(6000);
  }, 60_000);
});
