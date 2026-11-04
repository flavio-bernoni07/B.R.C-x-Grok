/** The Ready-to-ship demo case (ESS-AMB-001), stock checked again at approval time, and the Grok status labels. */
import { describe, expect, it } from "vitest";
import { recordEvent } from "../agent/lib/core/stock";
import { freshErp } from "../agent/lib/core/world";
import { seedDemo } from "../agent/lib/demo/seed";
import { grokStatus } from "../agent/lib/grok/status";
import { confirmOrder } from "../agent/lib/order/service";
import { stockNow } from "../agent/lib/order/stock_now";

describe("ESS-AMB-001 waits at the Ready-to-ship card", async () => {
  const erp = freshErp(":memory:");
  await seedDemo(erp);
  const so = erp.signoffs({ status: "pending" }).find((s) => s.subjectRef === "ESS-AMB-001");

  it("Grok fixed the date and the quantity, code read it again, one approval is left", () => {
    expect(erp.order("ESS-AMB-001")?.status).toBe("awaiting_confirmation");
    expect(so?.kind).toBe("confirm");
    const fix = erp.auditLog("ESS-AMB-001").find((a) => a.action === "order.parse_fix");
    expect((fix?.detail as { segment: string }[]).map((c) => c.segment)).toEqual(["DTM", "QTY"]);
    expect(erp.order("ESS-AMB-001")?.lines[0].qtyOrdered).toBe(6000);
  });

  it("the demo is marked as recorded", () => {
    expect(grokStatus(erp).recorded_demo).toBe(true);
  });

  it("stock checked now passes, then fails once the stock is no longer free", () => {
    expect(stockNow(erp, "ESS-AMB-001").every((c) => c.ok)).toBe(true);
    const free = Number(/(\d[\d,]*) free/.exec(stockNow(erp, "ESS-AMB-001")[0].detail)![1].replace(/,/g, ""));
    recordEvent(erp, "quality_hold", { batch: "LOT-A-0311", qty: free - 5000, note: "test: most of the Arborio goes on hold" });
    const now = stockNow(erp, "ESS-AMB-001");
    expect(now[0].ok).toBe(false);
    expect(now[0].detail).toContain("6,000 needed");
  });

  it("once confirmed, the order's own reservation is not counted against it", async () => {
    const e2 = freshErp(":memory:");
    await seedDemo(e2);
    const c = e2.signoffs({ status: "pending" }).find((s) => s.subjectRef === "ESS-AMB-001")!;
    confirmOrder(e2, c.caseId, { by: "Test, order desk", reason: "checks pass" });
    expect(stockNow(e2, "ESS-AMB-001").every((x) => x.ok)).toBe(true);
  });
});
