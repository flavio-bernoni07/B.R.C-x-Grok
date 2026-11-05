import { describe, expect, it } from "vitest";
import { Erp } from "../agent/lib/core/erp";
import { loadWorld } from "../agent/lib/core/world";
import { seedPortalDemoOrders } from "../agent/lib/demo/portal_orders";
import { clearPhoneClaims } from "../agent/lib/dispute/clear_phone";
import { simulatePhoneDispute } from "../agent/lib/dispute/phone_agent";
import { listClaims } from "../agent/lib/dispute/views";

describe("clearPhoneClaims", () => {
  it("removes phone DSP rows and leaves the portal orders", async () => {
    const erp = new Erp(":memory:");
    loadWorld(erp);
    seedPortalDemoOrders(erp);
    const sim = await simulatePhoneDispute(erp, {
      retailer: "Esselunga",
      order_ref: "ORD-3001",
      category: "shortage",
      claimed_quantity: 1100,
      customer_description: "received only 1100 packs",
      language: "en",
    });
    expect(sim.ok).toBe(true);
    expect(listClaims(erp).some((c) => c.channel === "phone")).toBe(true);

    const { removed } = clearPhoneClaims(erp);
    expect(removed.length).toBeGreaterThan(0);
    expect(listClaims(erp).filter((c) => c.channel === "phone")).toEqual([]);
    expect(erp.order("ORD-3001")).toBeTruthy();
    erp.close();
  }, 30_000);
});
