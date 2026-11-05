import { describe, expect, it } from "vitest";
import { orderCompliance, passport } from "../agent/lib/compliance/passport";
import { seedCompliance } from "../agent/lib/compliance/seed";
import { allBatches } from "../agent/lib/core/stock";
import { freshErp } from "../agent/lib/core/world";
import { decideSignoff } from "../agent/lib/shipping/decide";

const statusOf = (erp: ReturnType<typeof freshErp>, batch: string) => allBatches(erp).find((b) => b.batch === batch)?.status;

describe("lot compliance passport", () => {
  it("opens an Italian Carnaroli passport with Art. 18 back and plant certs", () => {
    const erp = freshErp(":memory:");
    seedCompliance(erp);
    const p = passport(erp, "LOT-C-0418");
    expect(p).toBeTruthy();
    expect(p!.status).toBe("ok");
    expect(p!.origin.label).toMatch(/Italia/i);
    expect(p!.mrl.status).toBe("pass");
    expect(p!.oneStepBack.supplier).toMatch(/Vercelli/i);
    expect(p!.plant.certs.map((c) => c.scheme)).toEqual(expect.arrayContaining(["IFS Food", "BRCGS Food Safety"]));
    expect(p!.documents.length).toBeGreaterThan(2);
  });

  it("holds Basmati LOT-B-0901 for missing Decision 2011/884 papers until a person releases", async () => {
    const erp = freshErp(":memory:");
    const seeded = seedCompliance(erp);
    expect(seeded.held).toContain("LOT-B-0901");
    expect(statusOf(erp, "LOT-B-0901")).toBe("hold");
    const p = passport(erp, "LOT-B-0901");
    expect(p!.status).toBe("gap");
    expect(p!.missingDocs).toContain("china_gmo_pack");

    const so = erp.signoffs({ status: "pending" }).find((s) => s.kind === "compliance_docs" && s.subjectRef === "LOT-B-0901");
    expect(so).toBeTruthy();
    await decideSignoff(erp, so!.caseId, {
      approve: true,
      by: "Lab lead",
      reason: "Health certificate and analytical report attached for the import lot",
    });
    expect(statusOf(erp, "LOT-B-0901")).toBe("released");
  });

  it("lists passports for an order's product batches when nothing has shipped", () => {
    const erp = freshErp(":memory:");
    seedCompliance(erp);
    erp.saveOrder({
      orderRef: "TST-CMP-001",
      buyerGln: "BUYER001",
      supplierGln: "SUPPLIER001",
      status: "confirmed",
      orderDate: "2026-11-04",
      deliveryDate: "2026-11-06",
      sourceDoc: null,
      lines: [{ lineNo: 1, gtin: "8000000000001", quantity: 100, qtyConfirmed: 100, unitPrice: 2.2 }],
    });
    const c = orderCompliance(erp, "TST-CMP-001");
    expect(c.status).toBe("ok");
    expect(c.passports.some((p) => p.batch === "LOT-C-0417")).toBe(true);
  });
});

