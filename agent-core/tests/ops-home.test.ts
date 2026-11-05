import { beforeAll, describe, expect, it } from "vitest";
import type { Erp } from "../agent/lib/core/erp";
import { impactSummary } from "../agent/lib/core/impact";
import { search } from "../agent/lib/core/search";
import { freshErp } from "../agent/lib/core/world";
import { runGolden } from "../agent/lib/demo/golden";

let erp: Erp;

beforeAll(async () => {
  process.env.BRC_PLAYBOOK = "/tmp/brc-ops-home-playbook.md";
  erp = freshErp();
  await runGolden(erp, { dispatchDay: false, caseStudy: false }); // the golden order alone, shipped and invoiced; the 6 Nov dispatch day has its own tests
});

describe("impact summary", () => {
  it("counts from the records", () => {
    const s = impactSummary(erp);
    expect(s.counts.activeOrders).toBe(1);
    expect(s.counts.needingPerson + s.counts.runningAutomatically).toBe(s.counts.activeOrders);
    expect(s.counts.deliveriesAtRisk).toBe(1);
    expect(s.atRisk[0].why).toMatch(/quality hold/);
    expect(s.steps.byPeople).toBe(2);
    expect(s.steps.byAgents).toBeGreaterThan(20);
    expect(s.invoiceGapsCaught.count).toBe(1);
    expect(s.cases.total).toBeGreaterThanOrEqual(3);
    expect(s.cases.withoutPerson).toBeGreaterThanOrEqual(1);
    expect(s.recent.some((r) => r.text === "ESS-GOLD-001 dispatched on TRUCK-PV-01")).toBe(true);
    expect(s.recent.some((r) => r.text === "FT-2026/0001 reconciled")).toBe(true);
    expect(s.recent.length).toBeLessThanOrEqual(6);
    if (s.benchmark) expect(s.benchmark.ours).toBeGreaterThanOrEqual(s.benchmark.threeway);
  });
});

describe("search", () => {
  it("finds orders, invoices, claims, retailers and trucks", () => {
    expect(search(erp, "gold-001")[0]).toMatchObject({ label: "ESS-GOLD-001", href: "/orders?ref=ESS-GOLD-001" });
    expect(search(erp, "FT-2026/0001")[0]).toMatchObject({ href: "/orders?ref=ESS-GOLD-001" });
    expect(search(erp, "TRUCK-PV-01")[0]).toMatchObject({ href: "/shipping" });
    expect(search(erp, "esselunga").some((h) => h.sub === "Retailer")).toBe(true);
    const claim = search(erp, "CLM-00002")[0];
    expect(claim.href).toMatch(/^\/disputes\?claim=CLM-/);
    expect(search(erp, "x")).toEqual([]);
  });
});
