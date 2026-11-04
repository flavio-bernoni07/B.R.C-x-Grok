/** Order row: ports of tests/test_order_parser.py, test_order_pipeline.py and test_order_service.py. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordEvent } from "../agent/lib/core/stock";
import { freshErp } from "../agent/lib/core/world";
import { StubAvailabilityProvider } from "../agent/lib/order/availability";
import { checkPrices, loadContract } from "../agent/lib/order/contract";
import { decideSignoff } from "../agent/lib/order/decide";
import * as grokbot from "../agent/lib/order/grokbot";
import { codeParseFix } from "../agent/lib/order/grokbot";
import { parseOrdersEdi, parseOrdersFile } from "../agent/lib/order/parser";
import { PipelineStatus, runOrderFile } from "../agent/lib/order/pipeline";
import {
  confirmOrder,
  receiveOrder,
  rejectOrder,
  resolvePriceCase,
  resolveQtyCase,
  simulateOrderFeed,
} from "../agent/lib/order/service";
import { listOrders, orderDetail } from "../agent/lib/order/views";
import { dataPath } from "../agent/lib/paths";

const EDI = dataPath("orders", "edi");
const edi = (name: string) => readFileSync(join(EDI, name), "utf8");
const GOLDEN = readFileSync(dataPath("world", "golden", "ORDERS_ESS-GOLD-001.edi"), "utf8");

describe("order parser", () => {
  it("clean orders parses key fields", () => {
    const result = parseOrdersFile(join(EDI, "ordine_ess_001.edi"));
    expect(result.ok).toBe(true);
    expect(result.order.order_number).toBe("ESS001");
    expect(result.order.order_date).toBe("20261104");
    expect(result.order.buyer_gln).toBe("BUYER001");
    expect(result.order.supplier_gln).toBe("SUPPLIER001");
    expect(result.order.lines).toHaveLength(1);
    const line = result.order.lines[0];
    expect(line.gtin).toBe("8000000000000");
    expect(line.quantity).toBe(10000);
    expect(line.unit_price).toBe(1.85);
  });

  it("messy qty raises parse flags", () => {
    const result = parseOrdersFile(join(EDI, "ordine_ess_messy.edi"));
    expect(result.ok).toBe(false);
    const codes = new Set(result.flags.map((f) => f.code));
    expect(codes.has("qty_ambiguous_it_thousands") || codes.has("qty_ambiguous_dot")).toBe(true);
    expect(codes.has("dtm_bad_format")).toBe(true);
  });

  it("indent and whitespace normalized", () => {
    const raw =
      "  \n  BGM+220+X1+9'  \n  DTM+137:20261104:102'\nNAD+BY+BUYER001::9'\nNAD+SU+SUPPLIER001::9'\nLIN+1++8000000000000:EN'\nQTY+21:10'\n";
    const result = parseOrdersEdi(raw);
    expect(result.order.order_number).toBe("X1");
    expect(result.order.lines[0].quantity).toBe(10);
  });

  it("missing BGM flags", () => {
    const raw =
      "UNH+1+ORDERS:D:96A:UN'DTM+137:20261104:102'NAD+BY+BUYER001::9'NAD+SU+SUPPLIER001::9'LIN+1++8000000000000:EN'QTY+21:5'";
    const result = parseOrdersEdi(raw);
    expect(result.ok).toBe(false);
    expect(result.flags.some((f) => f.code === "missing_segment" && f.segment === "BGM")).toBe(true);
  });
});

describe("order pipeline", () => {
  it("availability stub caps stock", () => {
    const hit = new StubAvailabilityProvider().getAvailability({
      gtin: "8000000000000",
      buyer_gln: "BUYER001",
      supplier_gln: "SUPPLIER001",
      requested_date: "20261104",
    });
    expect(hit.found).toBe(true);
    expect(hit.available_qty).toBe(25000);
  });

  it("volume discount price", () => {
    const contract = loadContract();
    expect(contract.expectedUnitPrice("8000000000000", 20000)).toBe(1.7);
    expect(contract.expectedUnitPrice("8000000000000", 100)).toBe(1.85);
  });

  it("clean order awaits confirm then ORDRSP", () => {
    const waiting = runOrderFile(join(EDI, "ordine_ess_001.edi"));
    expect(waiting.status).toBe(PipelineStatus.AWAIT_CONFIRM_SIGNOFF);
    const done = runOrderFile(join(EDI, "ordine_ess_001.edi"), { confirm: true });
    expect(done.status).toBe(PipelineStatus.READY_ORDRSP);
    expect(done.ordrsp).not.toBeNull();
    expect(done.ordrsp!.body).toContain("ORDRSP");
    expect(done.ordrsp!.handoff.order_number).toBe("ESS001");
  });

  it("volume discount fixture confirms", () => {
    const result = runOrderFile(join(EDI, "ordine_ess_discount_ok.edi"), { confirm: true });
    expect(result.status).toBe(PipelineStatus.READY_ORDRSP);
    expect(result.price_check?.ok).toBe(true);
  });

  it("messy awaits grok parse", () => {
    expect(runOrderFile(join(EDI, "ordine_ess_messy.edi")).status).toBe(PipelineStatus.AWAIT_GROK_PARSE);
  });

  it("short awaits grok qty", () => {
    const result = runOrderFile(join(EDI, "ordine_ess_short.edi"));
    expect(result.status).toBe(PipelineStatus.AWAIT_GROK_QTY);
    expect(result.availability.length).toBeGreaterThan(0);
    expect(result.availability[0].ok).toBe(false);
  });

  it("bad price drafts a mail, not the confirm sign-off", () => {
    const result = runOrderFile(join(EDI, "ordine_ess_bad_price.edi"));
    expect(result.status).toBe(PipelineStatus.AWAIT_PRICE_HUMAN);
    expect(result.draft_mail).not.toBeNull();
    expect(result.draft_mail).toContain("Price discrepancy");
    expect(result.draft_mail).toContain("Draft — review and send manually");
    expect(result.draft_mail).toContain("ordered €2.5, contract €1.85 (qty 10000.0)");
    expect(result.status).not.toBe(PipelineStatus.AWAIT_CONFIRM_SIGNOFF);
  });

  it("price check skips missing PRI", () => {
    const check = checkPrices({ lines: [{ gtin: "8000000000000", quantity: 10, unit_price: null }] });
    expect(check.ok).toBe(true);
    expect(check.lines[0].reason).toBe("no_PRI_on_order");
  });
});

describe("order service on the Mini ERP", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["XAI_API_KEY", "GROK_API_KEY"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  });

  const ediFor = (ref: string, gtin: string, qty: number, price: number) =>
    `UNH+1+ORDERS:D:96A:UN'BGM+220+${ref}+9'DTM+137:20261104:102'NAD+BY+BUYER001::9'` +
    `NAD+SU+SUPPLIER001::9'LIN+1++${gtin}:EN'QTY+21:${qty}'PRI+AAA:${price}:CT'UNS+S'UNT+10+1'`;

  it("clean order still waits for a person, then hands over", async () => {
    const erp = freshErp();
    const r = await receiveOrder(erp, GOLDEN);
    expect(r.step).toBe("confirm");
    expect(erp.order("ESS-GOLD-001")!.status).toBe("awaiting_confirmation");
    expect(erp.signoff(r.case_id)!.reasons).toEqual(["Order rule: a person confirms every order before ORDRSP"]);
    expect((erp.signoff(r.case_id)!.proposal!.availability as { source: string }[])[0].source).toBe(
      "erp_atp(released 12000 + planned 0 - committed 0)",
    );
    const handoff = confirmOrder(erp, r.case_id, { by: "Giulia", reason: "checks pass" });
    expect(handoff.order_number).toBe("ESS-GOLD-001");
    expect(handoff.lines).toEqual([{ line_no: 1, gtin: "8000000000001", quantity: 12000, unit_price: 2.2 }]);
    expect(erp.order("ESS-GOLD-001")!.status).toBe("confirmed");
    expect(erp.document(handoff.ordrsp_ref)!.body).toContain("BGM+231+ESS-GOLD-001");
    expect(handoff.ordrsp).toBe(
      "UNH+1+ORDRSP:D:96A:UN'BGM+231+ESS-GOLD-001+29'DTM+137:20261104:102'RFF+ON:ESS-GOLD-001'" +
        "NAD+BY+BUYER001::9'NAD+SU+SUPPLIER001::9'LIN+1++8000000000001:EN'QTY+21:12000'PRI+AAA:2.2:CT'UNS+S'UNT+11+1'",
    );
    expect(handoff.backorders).toEqual([]);
    expect(handoff.signoff_case).toBe(r.case_id);
  });

  it("confirmed orders reduce what the next order can get", async () => {
    const erp = freshErp();
    const r = await receiveOrder(erp, GOLDEN);
    confirmOrder(erp, r.case_id, { by: "Giulia", reason: "ok" });
    const r2 = await receiveOrder(erp, ediFor("ESS-NEXT", "8000000000001", 12000, 2.2));
    expect(r2.step).not.toBe("confirm"); // the first order took the released stock
  });

  it("short stock: operator split re-enters the stock check toward confirm", async () => {
    const erp = freshErp();
    recordEvent(erp, "quality_hold", { batch: "LOT-C-0418", qty: 1200 });
    const r = await receiveOrder(erp, ediFor("ESS-SPLIT", "8000000000001", 12000, 2.2));
    expect(r.step).toBe("qty_choice");
    const choice = erp.signoff(r.case_id)!;
    expect(choice.kind).toBe("qty_choice");
    expect((choice.proposal!.lines as { now_qty: number; later_qty: number }[])[0]).toMatchObject({
      now_qty: 10800,
      later_qty: 1200,
    });
    const again = await resolveQtyCase(erp, r.case_id, { by: "Giulia", reason: "ship what we have", action: "split" });
    expect("step" in again && again.step).toBe("confirm");
    const c = erp.signoff(again.case_id)!;
    expect(c.proposal!.backorders).toEqual([{ line_no: 1, gtin: "8000000000001", qty: 1200, date: "2026-11-09" }]);
    expect((c.proposal!.lines as { qty_confirmed: number }[])[0].qty_confirmed).toBe(10800);
    expect(c.reasons!.some((x) => x.includes("operator split to 10800"))).toBe(true);
  });

  it("short stock: operator mail parks with no ORDRSP", async () => {
    const erp = freshErp();
    recordEvent(erp, "quality_hold", { batch: "LOT-C-0418", qty: 1200 });
    const r = await receiveOrder(erp, ediFor("ESS-MAIL", "8000000000001", 12000, 2.2));
    expect(r.step).toBe("qty_choice");
    const parked = await resolveQtyCase(erp, r.case_id, { by: "Giulia", reason: "ask Esselunga first", action: "mail" });
    expect(parked.status).toBe("parked");
    expect(erp.order("ESS-MAIL")!.status).toBe("pending");
    expect(erp.documents({ ref: "ESS-MAIL", kind: "ORDRSP" })).toHaveLength(0);
    expect(String(erp.signoff(r.case_id)!.proposal!.draft_mail)).toContain("partial availability");
  });

  it("simulate feed keeps the 22 bench POs and never stops on the first human gate", async () => {
    const erp = freshErp();
    const { results } = await simulateOrderFeed(erp);
    // Labelled bench POs + golden + ESS feed items (wave-*)
    expect(results.length).toBeGreaterThanOrEqual(21 + 1 + 5);
    expect(results.filter((r) => r.id.startsWith("C")).length).toBeGreaterThanOrEqual(21);
    expect(results.every((r) => r.ok)).toBe(true);
    const steps = new Set(results.map((r) => r.result!.step));
    expect(steps.has("confirm") || steps.has("qty_choice") || steps.has("price_fix") || steps.has("manual_edi")).toBe(true);
    expect(results.filter((r) => r.result?.status === "awaiting_person").length).toBe(results.length);
    // A later ESS feed item still ran even though earlier ones needed a person.
    expect(results.at(-1)!.id).toBe("wave-5");
  });

  it("clearOrderDesk wipes prior orders and sign-offs so a second simulate starts fresh", async () => {
    const erp = freshErp();
    const productBefore = erp.product({ gtin: "8000000000001" }) ?? erp.product({ itemCode: "RISO-ARB" });
    await simulateOrderFeed(erp);
    expect(erp.signoffs().length).toBeGreaterThan(0);
    expect(erp.orders().length).toBeGreaterThan(0);
    erp.clearOrderDesk();
    expect(erp.signoffs()).toHaveLength(0);
    expect(erp.orders()).toHaveLength(0);
    expect(erp.documents()).toHaveLength(0);
    expect(erp.auditLog()).toHaveLength(0);
    // Master data remains.
    if (productBefore) expect(erp.product({ gtin: productBefore.gtin })?.name).toBe(productBefore.name);
    const { results } = await simulateOrderFeed(erp);
    expect(results.every((r) => r.ok)).toBe(true);
    // Counters restarted: first new case is SO-00001.
    const ids = erp.signoffs().map((c) => c.caseId).sort();
    expect(ids[0]).toBe("SO-00001");
  });

  it("wrong price goes to the price step, not the confirm step", async () => {
    const erp = freshErp();
    const r = await receiveOrder(erp, edi("ordine_ess_bad_price.edi"));
    expect(r.step).toBe("price_fix");
    expect(erp.order(r.order_ref!)!.status).toBe("pending_price");
    expect(erp.signoff(r.case_id)!.reasons![0]).toContain("€2.5");
    const parked = await resolvePriceCase(erp, r.case_id, { by: "Giulia", reason: "wait for Esselunga" });
    expect(parked.status).toBe("parked");
    expect(erp.order(r.order_ref!)!.status).toBe("pending");
  });

  it("manual EDI goes back to parse", async () => {
    const erp = freshErp();
    const r = await receiveOrder(erp, edi("ordine_ess_bad_price.edi"));
    const fixed = edi("ordine_ess_bad_price.edi").replace("PRI+AAA:2.50", "PRI+AAA:1.85");
    const again = await resolvePriceCase(erp, r.case_id, { by: "Giulia", reason: "retailer confirmed 1.85", manualEdi: fixed });
    expect("step" in again && again.step).toBe("confirm");
  });

  it("codeParseFix repairs DTM ISO dates and Italian thousands QTY", () => {
    const messy = edi("ordine_ess_messy.edi");
    const fix = codeParseFix(messy, [
      { code: "dtm_bad_format", message: "bad date", segment: "DTM" },
      { code: "qty_ambiguous_it_thousands", message: "IT thousands", segment: "QTY" },
    ]);
    expect(fix).not.toBeNull();
    expect(fix!.corrected_edi).toContain("20261104");
    expect(fix!.corrected_edi).toContain("QTY+21:20000");
    expect(fix!.corrected_edi).not.toContain("20.000");
  });

  it("messy EDI is auto-fixed by offline Grokbot (date + IT thousands) without a person", async () => {
    const erp = freshErp();
    const r = await receiveOrder(erp, edi("ordine_ess_messy.edi"));
    // No live key: codeParseFix applies the same safe repairs Grokbot would.
    expect(r.step).toBe("confirm");
    expect(r.status).toBe("awaiting_person");
    expect(erp.auditLog().some((a) => a.actor === "grok" && a.action === "order.parse_fix")).toBe(true);
  });

  it("Grok's parse fix is parsed again and shown to the person", async () => {
    const erp = freshErp();
    const messy = edi("ordine_ess_messy.edi");
    const fixed = messy.replace("2026-11-04", "20261104").replace("20.000", "20000").trim();
    const caller = () => ({
      corrected_edi: fixed,
      confidence: 0.8,
      changes: [{ segment: "QTY", before: "20.000", after: "20000", why: "IT thousands" }],
    });
    const r = await receiveOrder(erp, messy, { caller });
    expect(r.step).toBe("confirm");
    expect(erp.signoff(r.case_id)!.reasons!.some((x) => /Grokbot corrected the EDI:.*QTY: 20\.000/.test(x))).toBe(true);
  });

  it("Grok cannot put new figures in the qty message", async () => {
    const liar = () => ({ action: "split", message: "Vi mandiamo 9999 pezzi", confidence: 0.9 });
    const out = await grokbot.proposeQtyResolution({
      orderRef: "X",
      gtin: "1",
      product: "P",
      buyer: "B",
      ordered: 100,
      available: 60,
      nextDate: "2026-11-09",
      laterAvailable: 40,
      caller: liar,
    });
    expect(out!.source).toBe("code");
    expect(out!.now_qty).toBe(60);
    expect(out!.later_qty).toBe(40);
  });

  it("price mail keeps every figure", async () => {
    const draft = "Order ESS003: ordered €1.85, contract €1.7 (qty 50000)";
    let [mail, by] = await grokbot.polishPriceMail(draft, { caller: () => ({ mail: "Ordine ESS003: €1,85 contro €1,7, qty 50000" }) });
    expect(by).toBe("grok");
    [mail, by] = await grokbot.polishPriceMail(draft, { caller: () => ({ mail: "Ordine ESS003: prezzo €1.99" }) });
    expect(by).toBe("code");
    expect(mail).toBe(draft);
  });

  it("reject order", async () => {
    const erp = freshErp();
    const r = await receiveOrder(erp, GOLDEN);
    rejectOrder(erp, r.case_id, { by: "Giulia", reason: "duplicate of yesterday's order" });
    expect(erp.order("ESS-GOLD-001")!.status).toBe("rejected");
  });

  it("confirm checks stock again when two orders wait", async () => {
    const erp = freshErp();
    const first = await receiveOrder(erp, GOLDEN);
    const second = await receiveOrder(erp, ediFor("ESS-TWIN", "8000000000001", 12000, 2.2));
    expect(second.step).toBe("confirm"); // both passed the checks while neither was confirmed
    confirmOrder(erp, first.case_id, { by: "Giulia", reason: "ok" });
    expect(() => confirmOrder(erp, second.case_id, { by: "Giulia", reason: "ok" })).toThrow(/run the order again/);
    expect(erp.signoff(second.case_id)!.status).toBe("pending");
  });
});

describe("order sign-off decisions and read models", () => {
  beforeEach(() => {
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
  });

  it("decideSignoff confirms with ORDRSP and hand-over, and rejects", async () => {
    const erp = freshErp();
    const r = await receiveOrder(erp, GOLDEN);
    const out = await decideSignoff(erp, r.case_id, { approve: true, by: "Giulia", reason: "checks pass" });
    expect(out.status).toBe("confirmed");
    expect((out.handoff as { order_number: string }).order_number).toBe("ESS-GOLD-001");
    expect(erp.documents({ ref: "ESS-GOLD-001", kind: "ORDRSP" })).toHaveLength(1);

    const r2 = await receiveOrder(erp, edi("ordine_ess_001.edi"));
    const out2 = await decideSignoff(erp, r2.case_id, { approve: false, by: "Giulia", reason: "duplicate" });
    expect(out2.status).toBe("rejected");
    expect(erp.order("ESS001")!.status).toBe("rejected");
  });

  it("decideSignoff on a price case parks it or takes a manual EDI", async () => {
    const erp = freshErp();
    const r = await receiveOrder(erp, edi("ordine_ess_bad_price.edi"));
    const fixed = edi("ordine_ess_bad_price.edi").replace("PRI+AAA:2.50", "PRI+AAA:1.85");
    const out = await decideSignoff(erp, r.case_id, { approve: true, by: "Giulia", reason: "retailer fixed it", edits: { manual_edi: fixed } });
    expect((out.result as { step: string }).step).toBe("confirm");
    expect(erp.order("ESS004")!.status).toBe("awaiting_confirmation");
  });

  it("lists orders with the check that decided them", async () => {
    const erp = freshErp();
    const r = await receiveOrder(erp, GOLDEN);
    await receiveOrder(erp, edi("ordine_ess_bad_price.edi"));
    confirmOrder(erp, r.case_id, { by: "Giulia", reason: "ok" });
    const rows = listOrders(erp);
    const gold = rows.find((o) => o.orderRef === "ESS-GOLD-001")!;
    expect(gold.pill).toEqual({ tone: "ok", label: "Confirmed" });
    const bad = rows.find((o) => o.orderRef === "ESS004")!;
    expect(bad.pill.tone).toBe("attention");
    const d = orderDetail(erp, "ESS-GOLD-001")!;
    expect(d.ordrsp).toContain("BGM+231+ESS-GOLD-001");
    expect(d.checks.map((c) => c.name)).toEqual(["Parse EDI", "Stock", "Price vs contract", "Sign-off"]);
    expect(d.documents.map((x) => x.kind)).toEqual(["ORDERS", "ORDRSP"]);
    expect(d.audit.some((a) => a.action === "orders.received")).toBe(true);
  });
});
