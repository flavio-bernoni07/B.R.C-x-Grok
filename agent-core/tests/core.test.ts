import { describe, expect, it } from "vitest";
import { decide, pending, requestSignoff } from "../agent/lib/core/signoff";
import { allocate, availableToPromise, recordEvent } from "../agent/lib/core/stock";
import { freshErp } from "../agent/lib/core/world";
import { numbersIn } from "../agent/lib/core/checks";
import { buildDigest } from "../agent/lib/core/digest";

describe("core", () => {
  it("loads the world and computes available to promise", () => {
    const erp = freshErp();
    expect(erp.products().length).toBeGreaterThan(3);
    const before = availableToPromise(erp, "8000000000001");
    recordEvent(erp, "quality_hold", { batch: "LOT-C-0418", qty: 1200 });
    const after = availableToPromise(erp, "8000000000001");
    expect(before.released - after.released).toBe(1200);
    expect(after.held).toBe(1200);
    const { taken, shortfall } = allocate(erp, "8000000000001", after.released + 5);
    expect(shortfall).toBe(5);
    expect(taken.every((t) => !t.batch.endsWith("-HOLD"))).toBe(true);
  });

  it("runs the sign-off queue and needs a reason", () => {
    const erp = freshErp();
    const id = requestSignoff(erp, { row: "order", kind: "confirm", subjectRef: "X", title: "t", proposal: {}, reasons: ["always"] });
    expect(pending(erp)).toHaveLength(1);
    expect(() => decide(erp, id, { approve: true, by: "Giulia", reason: " " })).toThrow();
    expect(decide(erp, id, { approve: true, by: "Giulia", reason: "ok" }).status).toBe("approved");
    expect(buildDigest(erp).signoffs.decided).toBe(1);
  });

  it("compares numbers the way agent/checks.py does", () => {
    expect([...numbersIn("12.000 and 2,20")]).toEqual(["12000", "220"]);
  });
});
