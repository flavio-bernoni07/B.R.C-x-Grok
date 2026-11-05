/** The README case study in the app: ESS-GOLD-001 stops at the truck with what a person decides. */
import { describe, expect, it } from "vitest";
import { freshErp } from "../agent/lib/core/world";
import { parseRemadv } from "../agent/lib/demo/case-study";
import { runGolden } from "../agent/lib/demo/golden";
import { orderWorkspace } from "../agent/lib/order/workspace";

describe("case study (README) on ESS-GOLD-001", () => {
  it("reads the REMADV like finance/receivables.py", () => {
    const r = parseRemadv(
      "UNH+1+REMADV:D:96A:UN:EAN002'BGM+481+RA-1+9'DTM+209:20261130:102'NAD+PR+BUYER001::9'MOA+9:23882.40'" +
        "DOC+380+FT-2026/0001'MOA+12:24710.40'MOA+9:23882.40'AJT+CN'MOA+5:528.00'FTX+AAI+++Nota'AJT+PC'MOA+5:300.00'FTX+AAI+++Contributo volantino'UNT+18+1'",
    );
    expect(r).toMatchObject({ ref: "RA-1", valueDate: "2026-11-30", payer: "BUYER001", total: 23882.4 });
    expect(r.docs[0].adjustments).toEqual([
      { code: "CN", amount: 528, note: "Nota" },
      { code: "PC", amount: 300, note: "Contributo volantino" },
    ]);
  });

  it("stops ESS-GOLD-001 at the truck with two cases to decide", async () => {
    process.env.BRC_PLAYBOOK = "/tmp/brc-case-study-playbook-test.md";
    const erp = freshErp();
    await runGolden(erp, { history: false });
    const ws = orderWorkspace(erp, "ESS-GOLD-001")!;

    expect(ws.status).toBe("attention");
    expect(ws.owner).toMatchObject({ kind: "person", name: "Warehouse lead" });
    expect(ws.journey.find((s) => s.key === "dispatched")!.done).toBe(false);
    expect(erp.invoices("ESS-GOLD-001")).toEqual([]);
    expect(erp.claims().filter((c) => c.orderRef === "ESS-GOLD-001")).toEqual([]);

    // The truck waits: Grok's rescan first, the loss as the other choice.
    const [truck, short] = ws.caught;
    expect(ws.caught.map((c) => c.atStake)).toEqual([2112, 2640]);
    expect(truck).toMatchObject({ problem: "Pallet 04 on the wrong truck", alert: "TRUCK-PV-01 stopped until you decide", done: false });
    expect(truck.options.map((o) => o.label)).toEqual(["Fix now, truck waits", "Let it go, book €2,112 loss"]);
    expect(short).toMatchObject({ problem: "1,200 packs on quality hold", done: false });
    expect(short.options.find((o) => o.grok)?.action).toBe("CONFIRM_SHORT_SHIPMENT");
    erp.close();
  });
});
