import { describe, expect, it } from "vitest";
import { freshErp } from "../agent/lib/core/world";
import { runGolden } from "../agent/lib/demo/golden";

describe("golden order end to end (demo.py)", () => {
  it("runs every row offline like the Python demo", async () => {
    process.env.BRC_PLAYBOOK = "/tmp/brc-golden-playbook-test.md";
    const erp = freshErp();
    const r = await runGolden(erp, { decideUnclear: true });
    expect(r.order).toBe("confirmed");
    expect(r.goldenClaim).toBe("closed");
    expect(r.unclearClaim).toBe("awaiting_person");
    expect(r.pendingSignoffs).toBe(0);
    expect(r.disputeCatalogOrders).toBe(1);
    expect(r.auditEvents).toBeGreaterThan(40);
  });
});
