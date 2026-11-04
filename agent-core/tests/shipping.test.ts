/**
 * Shipping and invoicing (port of tests/test_shipping.py): hand-over in, dispatch, invoice,
 * reconcile, hand-over to Dispute, and the v0.5.0 rules (trucks, scans, exception cases).
 *
 * The Python tests build the order with Order's receive_order + confirm_order. The Order port
 * lives in another folder, so `ready()` writes the same confirmed order and hand-over directly
 * (Python `confirm_order` shape), then ingests it.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Erp } from "../agent/lib/core/erp";
import { availableToPromise, recordEvent } from "../agent/lib/core/stock";
import { freshErp } from "../agent/lib/core/world";
import { dataPath } from "../agent/lib/paths";
import * as cases from "../agent/lib/shipping/cases";
import { decideSignoff } from "../agent/lib/shipping/decide";
import { reconcileDocuments } from "../agent/lib/shipping/reconcile";
import {
  type ConfirmedOrderHandoff,
  explainFlags,
  exportForDispute,
  ingestConfirmedOrder,
  invoiceShipment,
  recordDelivery,
  reconcileAndSend,
  reconcileView,
  ShippingError,
  shipOrder,
  shippingFile,
  shippingList,
} from "../agent/lib/shipping/service";
import * as wh from "../agent/lib/shipping/warehouse";
import { reconcile } from "../agent/lib/threeway/core";

const CAR = "8000000000001";

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

/** What Order's receive_order + confirm_order leave behind: a confirmed order and its hand-over. */
function confirmed(erp: Erp, ref = "ESS-GOLD-001", qty = 12000, price = 2.2): ConfirmedOrderHandoff {
  const edi = `UNH+1+ORDERS:D:96A:UN'BGM+220+${ref}+9'DTM+137:20261104:102'NAD+BY+BUYER001::9'NAD+SU+SUPPLIER001::9'LIN+1++${CAR}:EN'QTY+21:${qty}'PRI+AAA:${price}:CT'UNS+S'UNT+10+1'`;
  const src = erp.addDocument("ORDERS", ref, edi);
  erp.saveOrder({
    orderRef: ref,
    buyerGln: "BUYER001",
    supplierGln: "SUPPLIER001",
    orderDate: "20261104",
    lines: [{ lineNo: 1, gtin: CAR, quantity: qty, qtyConfirmed: qty, unitPrice: price }],
    status: "awaiting_confirmation",
    sourceDoc: src,
    notes: { backorders: [], grokbot: [] },
  });
  const ordrsp = `UNH+1+ORDRSP:D:96A:UN'BGM+231+${ref}+29'DTM+137:20261104:102'RFF+ON:${ref}'NAD+BY+BUYER001::9'NAD+SU+SUPPLIER001::9'LIN+1++${CAR}:EN'QTY+21:${qty}'PRI+AAA:${price}:CT'UNS+S'UNT+11+1'`;
  const docId = erp.addDocument("ORDRSP", ref, ordrsp);
  erp.setOrder(ref, { status: "confirmed", ordrspRef: docId });
  return {
    order_number: ref,
    buyer_gln: "BUYER001",
    supplier_gln: "SUPPLIER001",
    order_date: "20261104",
    lines: [{ line_no: 1, gtin: CAR, quantity: qty, unit_price: price }],
    ordrsp,
    ordrsp_ref: docId,
    backorders: [],
    signoff_case: "SO-00001",
  };
}

function ready(erp: Erp, ref = "ESS-GOLD-001", qty = 12000, price = 2.2) {
  const handoff = confirmed(erp, ref, qty, price);
  ingestConfirmedOrder(erp, handoff);
  return handoff;
}

const trucksOf = (erp: Erp, ...items: [string, number, number][]) =>
  wh.registerTrucks(
    erp,
    items.map(([t, cap, kg], i) => ({ truck_id: t, plate: `PL${i}`, destination: "CeDi Melzo", pallet_capacity: cap, max_payload_kg: kg })),
  );

describe("threeway core", () => {
  it("matches, sums split deliveries and names one reason per line", () => {
    const po = [{ poNumber: "PO1", itemCode: "A", quantity: 40, price: 15.5 }];
    const grn = [
      { poNumber: "po1 ", itemCode: "a", quantity: 28 },
      { poNumber: "PO1", itemCode: "A", quantity: 0 },
    ];
    const inv = [{ poNumber: "PO1", itemCode: "A", quantity: 28, price: 15.5 }];
    const r = reconcile(po, grn, inv);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].status).toBe("matched"); // blind spot 1: short delivery invoiced correctly
    const orphan = reconcile(po, [], [{ poNumber: "PO2", itemCode: "A", quantity: 1, price: 1 }]);
    expect(orphan.lines.map((l) => l.status)).toEqual(["not_started", "exception"]);
    const dup = reconcile([...po, ...po], [], []);
    expect(dup.warnings[0]).toContain("Duplicate PO line for PO1/A");
  });
});

describe("shipping", () => {
  it("hand-over needs a confirmed order with its ORDRSP", () => {
    const erp = freshErp();
    // the order exists but is not confirmed yet
    const handoff = confirmed(erp);
    erp.setOrder("ESS-GOLD-001", { status: "awaiting_confirmation" });
    expect(() => ingestConfirmedOrder(erp, { order_number: "ESS-GOLD-001", ordrsp_ref: "x", lines: [] })).toThrow(ShippingError);
    erp.setOrder("ESS-GOLD-001", { status: "confirmed" });
    const bad = { ...handoff, lines: [{ ...handoff.lines[0], quantity: 99 }] };
    expect(() => ingestConfirmedOrder(erp, bad)).toThrow(ShippingError);
    expect(ingestConfirmedOrder(erp, handoff)).toBe("ESS-GOLD-001");
  });

  it("held stock never ships and the invoice bills what shipped", () => {
    const erp = freshErp();
    ready(erp);
    recordEvent(erp, "quality_hold", { batch: "LOT-C-0418", qty: 1200 });
    const s = shipOrder(erp, "ESS-GOLD-001", { shipDate: "2026-11-05" });
    expect(s.lines.reduce((a, l) => a + l.qty, 0)).toBe(10800);
    expect(s.short[0]).toContain("quality hold on LOT-C-0418-HOLD");
    const inv = invoiceShipment(erp, s.desadv_ref, { invoiceDate: "2026-11-05" });
    expect([inv.net, inv.vat, inv.total]).toEqual([23760.0, 950.4, 24710.4]);
    const xml = erp.document(inv.td01_doc)!.body!;
    expect(xml).toContain("<TipoDocumento>TD01</TipoDocumento>");
    expect(xml).toContain("DEMO FatturaPA TD01");
    expect(erp.document(inv.invoic_doc)!.body).toContain("BGM+380+FT-2026/0001");
    expect(() => invoiceShipment(erp, s.desadv_ref, { invoiceDate: "2026-11-05" })).toThrow(ShippingError);
  });

  it("writes the same documents as the Python row", () => {
    const erp = freshErp();
    ready(erp);
    recordEvent(erp, "quality_hold", { batch: "LOT-C-0418", qty: 1200 });
    const s = shipOrder(erp, "ESS-GOLD-001", { shipDate: "2026-11-05" });
    const inv = invoiceShipment(erp, s.desadv_ref, { invoiceDate: "2026-11-05" });
    const body = (kind: string) => erp.documents({ kind })[0].body;
    expect(body("DESADV")).toBe(
      [
        "UNH+1+DESADV:D:96A:UN:EAN005'",
        "BGM+351+DESADV-ESS-GOLD-001-1+9'",
        "DTM+11:20261105:102'",
        "RFF+ON:ESS-GOLD-001'",
        "NAD+SU+SUPPLIER001::9'",
        "NAD+BY+BUYER001::9'",
        "NAD+DP+++CeDi Melzo'",
        "CPS+1'",
        "LIN+1++8000000000001:SRV'",
        "QTY+12:6000'",
        "PCI+36E'GIN+BX+LOT-C-0417'",
        "LIN+2++8000000000001:SRV'",
        "QTY+12:4800'",
        "PCI+36E'GIN+BX+LOT-C-0418'",
        "CNT+2:2'",
        "UNT+16+1'",
        "",
      ].join("\n"),
    );
    expect(body("DDT")).toContain("  CAR-1KG          Riso Scotti Carnaroli 1 kg               batch LOT-C-0417   qty 6000 EA\n");
    expect(body("INVOIC 380")).toBe(
      [
        "UNH+1+INVOIC:D:96A:UN:EAN008'",
        "BGM+380+FT-2026/0001+9'",
        "DTM+137:20261105:102'",
        "RFF+ON:ESS-GOLD-001'",
        "RFF+DQ:DESADV-ESS-GOLD-001-1'",
        "NAD+SU+SUPPLIER001::9'",
        "NAD+BY+BUYER001::9'",
        "CUX+2:EUR:4'",
        "LIN+1++8000000000001:SRV'",
        "QTY+47:10800'",
        "MOA+203:23760.00'",
        "PRI+AAA:2.2'",
        "TAX+7+VAT+++:::4'",
        "UNS+S'",
        "MOA+79:23760.00'",
        "MOA+124:950.40'",
        "MOA+77:24710.40'",
        "UNT+18+1'",
        "",
      ].join("\n"),
    );
    // The a38 output, with ProgressivoInvio (time-based) blanked out.
    const xml = erp.document(inv.td01_doc)!.body!.replace(/<ProgressivoInvio>[^<]*<\/ProgressivoInvio>/, "<ProgressivoInvio/>");
    expect(xml).toBe(
      "<?xml version='1.0' encoding='utf-8'?>\n<!-- DEMO FatturaPA TD01 generated by shipping.documents (a38); not for SDI transmission -->\n" +
        '<ns0:FatturaElettronica xmlns:ns0="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" versione="FPR12"><FatturaElettronicaHeader><DatiTrasmissione><IdTrasmittente><IdPaese>IT</IdPaese><IdCodice>01652220180</IdCodice></IdTrasmittente><ProgressivoInvio/><FormatoTrasmissione>FPR12</FormatoTrasmissione><CodiceDestinatario>XXXXXXX</CodiceDestinatario></DatiTrasmissione><CedentePrestatore><DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>01652220180</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>Riso Scotti S.p.A.</Denominazione></Anagrafica><RegimeFiscale>RF01</RegimeFiscale></DatiAnagrafici><Sede><Indirizzo>Via Angelo Scotti 2</Indirizzo><CAP>27100</CAP><Comune>Pavia</Comune><Provincia>PV</Provincia><Nazione>IT</Nazione></Sede></CedentePrestatore><CessionarioCommittente><DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>00000000001</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>Esselunga</Denominazione></Anagrafica></DatiAnagrafici><Sede><Indirizzo>Via Giambologna 1</Indirizzo><CAP>20096</CAP><Comune>Pioltello</Comune><Provincia>MI</Provincia><Nazione>IT</Nazione></Sede></CessionarioCommittente></FatturaElettronicaHeader><FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Divisa>EUR</Divisa><Data>2026-11-05</Data><Numero>FT-2026/0001</Numero><ImportoTotaleDocumento>24710.40</ImportoTotaleDocumento><Causale>Ordine ESS-GOLD-001, DDT DDT-ESS-GOLD-001-1</Causale></DatiGeneraliDocumento><DatiOrdineAcquisto><IdDocumento>ESS-GOLD-001</IdDocumento></DatiOrdineAcquisto><DatiDDT><NumeroDDT>DDT-ESS-GOLD-001-1</NumeroDDT><DataDDT>2026-11-05</DataDDT></DatiDDT></DatiGenerali><DatiBeniServizi><DettaglioLinee><NumeroLinea>1</NumeroLinea><Descrizione>Riso Scotti Carnaroli 1 kg (GTIN 8000000000001)</Descrizione><Quantita>10800.00</Quantita><UnitaMisura>EA</UnitaMisura><PrezzoUnitario>2.20</PrezzoUnitario><PrezzoTotale>23760.0000</PrezzoTotale><AliquotaIVA>4.00</AliquotaIVA></DettaglioLinee><DatiRiepilogo><AliquotaIVA>4.00</AliquotaIVA><ImponibileImporto>23760.00</ImponibileImporto><Imposta>950.40</Imposta><EsigibilitaIVA>I</EsigibilitaIVA></DatiRiepilogo></DatiBeniServizi></FatturaElettronicaBody></ns0:FatturaElettronica>',
    );
  });

  it("short delivery with a cause goes out and is followed up", async () => {
    const erp = freshErp();
    ready(erp);
    recordEvent(erp, "quality_hold", { batch: "LOT-C-0418", qty: 1200 });
    const s = shipOrder(erp, "ESS-GOLD-001", { shipDate: "2026-11-05" });
    invoiceShipment(erp, s.desadv_ref, { invoiceDate: "2026-11-05" });
    const rec = await reconcileAndSend(erp, "ESS-GOLD-001");
    expect(rec.status).toBe("sent");
    expect(rec.report.causes).toEqual(["short_delivery"]);
    expect(rec.explanation).toBe("ESS-GOLD-001 CAR-1KG: delivered 10800 of 12000 ordered (€2640.00).");
    expect(erp.invoices("ESS-GOLD-001")[0].status).toBe("sent");
    expect(String(rec.follow_up)).toContain("1200 of 12000");
    // threeway calls the same documents matched
    const view = reconcileView(erp, "ESS-GOLD-001");
    expect(view.threeway).toEqual({ attention: false, causes: [] });
    expect(view.ours).toEqual({ attention: true, causes: ["short_delivery"] });
    expect(view.threeway_wrong).toBe(true);
  });

  it("a billing error holds the invoice for a person", async () => {
    const erp = freshErp();
    ready(erp, "ESS-GOLD-001", 1000, 2.4);
    const s = shipOrder(erp, "ESS-GOLD-001", { shipDate: "2026-11-05" });
    const inv = invoiceShipment(erp, s.desadv_ref, { invoiceDate: "2026-11-05" });
    erp.sqlite.prepare("UPDATE invoice_lines SET unit_price = 2.60 WHERE invoice_ref = ?").run(inv.invoice_ref);
    const rec = await reconcileAndSend(erp, "ESS-GOLD-001");
    expect(rec.status).toBe("awaiting_person");
    const c = erp.signoff(rec.case_id!)!;
    expect(c.row).toBe("shipping");
    expect(c.reasons).toEqual(["billing error found: price_difference"]);
    expect(erp.invoices("ESS-GOLD-001")[0].status).toBe("draft");
    // the person decides in the UI: send as is
    const out = await decideSignoff(erp, rec.case_id!, { approve: true, by: "Giulia", reason: "price agreed by phone" });
    expect(out.status).toBe("sent");
    expect(erp.invoices("ESS-GOLD-001")[0].status).toBe("sent");
  });

  it("Grok's explanation cannot add figures", async () => {
    let [, by] = await explainFlags("price €2.60 against €2.40 (€200.00)", "notes: none", {
      caller: () => ({ explanation: "Gap of €999", confidence: 0.9 }),
    });
    expect(by).toBe("code");
    [, by] = await explainFlags("price €2.60 against €2.40 (€200.00)", "notes: none", {
      caller: () => ({ explanation: "Invoice at €2.60 instead of €2.40: €200.00 too much" }),
    });
    expect(by).toBe("grok");
  });

  it("export feeds Dispute in the catalog shape", () => {
    const erp = freshErp();
    ready(erp);
    const s = shipOrder(erp, "ESS-GOLD-001", { shipDate: "2026-11-05" });
    invoiceShipment(erp, s.desadv_ref, { invoiceDate: "2026-11-05" });
    recordDelivery(erp, s.desadv_ref, { signedBy: "CeDi Melzo", received: { [CAR]: 11760 }, note: "1 pallet missing" });
    const out = exportForDispute(erp);
    const catalog = JSON.parse(readFileSync(dataPath("disputes", "erp", "catalog.json"), "utf8")) as Record<string, unknown>;
    for (const k of ["orders", "desadv", "invoices", "proofs"]) expect(k in catalog).toBe(true);
    expect(Object.keys(out).sort()).toEqual(["desadv", "invoices", "orders", "proofs"]);
    expect(out.orders[0]).toMatchObject({ order_ref: "ESS-GOLD-001", order_date: "2026-11-04", customer: "Esselunga" });
    expect(out.invoices[0]).toMatchObject({ invoice_ref: "FT-2026/0001", aliases: ["FT-2026-0001", "FT20260001"], total: 26400 });
    expect(out.desadv[0]).toMatchObject({ desadv_ref: "DESADV-ESS-GOLD-001-1", lines: [{ item_code: "CAR-1KG", quantity: 12000, uom: "EA" }] });
    expect(out.proofs.some((p) => p.kind === "pod" && String(p.summary).includes("with reservation"))).toBe(true);
    expect(out.proofs.find((p) => p.kind === "pod")!.summary).toBe(
      "Signed DDT DDT-ESS-GOLD-001-1 by CeDi Melzo: CAR-1KG 11760 received of 12000 shipped, with reservation: 1 pallet missing",
    );
    // threeway (as Dispute's pullFacts runs it: DESADV lines are the goods received) says matched
    const tw = reconcile(
      out.orders[0].lines.map((l: any) => ({ poNumber: "ESS-GOLD-001", itemCode: l.item_code, quantity: l.quantity, price: l.unit_price })),
      out.desadv[0].lines.map((l: any) => ({ poNumber: "ESS-GOLD-001", itemCode: l.item_code, quantity: l.quantity })),
      out.invoices[0].lines.map((l: any) => ({ poNumber: "ESS-GOLD-001", itemCode: l.item_code, quantity: l.quantity, price: l.unit_price })),
    );
    expect(tw.lines.map((l) => l.status)).toEqual(["matched"]);
    expect(exportForDispute(erp, "NOPE").orders).toEqual([]);
  });

  it("reconcile links a one-character typo but not an ambiguous one", () => {
    const po = [
      { order_ref: "RS-26-1100", item_code: "ARB-1KG-CTN12", quantity: 40, unit_price: 15.5 },
      { order_ref: "RS-26-1101", item_code: "ARB-1KG-CTN12", quantity: 40, unit_price: 15.5 },
    ];
    const rec = [
      { order_ref: "RS-26-1100", item_code: "ARB-1KG-CTN12", quantity: 40 },
      { order_ref: "RS-26-1101", item_code: "ARB-1KG-CTN12", quantity: 40 },
    ];
    const inv = [
      { order_ref: "RS-26-1100", item_code: "ARB-1KG-CTN12", quantity: 40, unit_price: 15.5 },
      { order_ref: "RS-26-110", item_code: "ARB-1KG-CTN12", quantity: 40, unit_price: 15.5 },
    ];
    const report = reconcileDocuments(po, rec, inv);
    expect(report.causes.has("orphan_invoice")).toBe(true);
    expect(report.notes.some((n) => n.includes("several orders"))).toBe(true);
  });

  // ----- v0.5.0: trucks, scans, exception cases --------------------------------

  it("capacity case end to end, like section 9", async () => {
    const erp = freshErp();
    ready(erp, "ORD-1081", 1920, 2.4); // 2 pallets of 960
    trucksOf(erp, ["TRUCK-SMALL", 1, 24000]);
    const plan = wh.planTruckLoads(erp, ["ORD-1081"]);
    expect(plan.planned).toEqual([]);
    expect(plan.exceptions[0].type).toBe("TRUCK_CAPACITY_EXCEEDED");
    const caseId = cases.openExceptionCases(erp, plan.exceptions)[0];
    const c = cases.viewExceptionCase(erp, caseId)!;
    expect(c.role).toBe("transport_planner");
    expect(c.possible_actions.map((a) => a.action)).toEqual(["PLAN_ON_TRUCK", "REQUEST_CLARIFICATION"]);
    expect(c.possible_actions.some((a) => a.selected)).toBe(false);
    expect(cases.submitResolutionProposal(erp, caseId, { actions: [{ action: "PLAN_ON_TRUCK", params: { truck_id: "TRUCK-SMALL" } }] }).status).toBe("rejected");
    trucksOf(erp, ["TRUCK-WIDE", 2, 24000]);
    const good = cases.submitResolutionProposal(erp, caseId, { actions: [{ action: "PLAN_ON_TRUCK", params: { truck_id: "TRUCK-WIDE" } }] });
    expect(good.status).toBe("validated");
    expect(() => cases.executeResolution(erp, caseId)).toThrow();
    expect(() => cases.decideResolution(erp, caseId, { employeeId: "E1", role: "warehouse_lead", decision: "approve", reason: "x" })).toThrow();
    cases.decideResolution(erp, caseId, { employeeId: "EMP-PLANNER-01", role: "transport_planner", decision: "approve", reason: "TRUCK-WIDE has room" });
    expect(cases.executeResolution(erp, caseId).status).toBe("EXECUTED");
    expect(cases.executeResolution(erp, caseId).status).toBe("DUPLICATE_EXECUTION");
    expect(cases.recheckExceptionCase(erp, caseId).resolution).toBe("resolved");
    const m = wh.manifestForOrder(erp, "ORD-1081")!;
    expect(m.truck_id).toBe("TRUCK-WIDE");
    expect(m.dispatched).toBe(false);
    expect(erp.shipments("ORD-1081")).toEqual([]); // planning writes no shipment
    expect(erp.signoffs({ row: "shipping" })[0].status).toBe("approved");
  });

  it("the UI decision on an exception case decides, executes and rechecks", async () => {
    const erp = freshErp();
    ready(erp, "ORD-1081", 1920, 2.4);
    trucksOf(erp, ["TRUCK-SMALL", 1, 24000]);
    const plan = wh.planTruckLoads(erp, ["ORD-1081"]);
    const caseId = cases.openExceptionCases(erp, plan.exceptions)[0];
    trucksOf(erp, ["TRUCK-WIDE", 2, 24000]);
    const proposal = await cases.proposeWithGrok(erp, caseId, {
      caller: () => ({ actions: [{ action: "PLAN_ON_TRUCK", params: { truck_id: "TRUCK-WIDE" } }], rationale: "two pallet spaces", confidence: 0.8 }),
    });
    expect(proposal!.status).toBe("validated");
    const signoffId = cases.viewExceptionCase(erp, caseId)!.signoff_case!;
    const out = await decideSignoff(erp, signoffId, { approve: true, by: "EMP-PLANNER-01", reason: "TRUCK-WIDE has room" });
    expect(out).toMatchObject({ status: "executed", resolution: "resolved" });
    expect(erp.signoff(signoffId)!.status).toBe("approved");
    expect(wh.manifestForOrder(erp, "ORD-1081")!.truck_id).toBe("TRUCK-WIDE");
    const file = shippingFile(erp, "ORD-1081");
    expect(file.exception_cases[0].proposal_records).toHaveLength(1);
    expect(shippingList(erp).find((r) => r.order_ref === "ORD-1081")!.truck_id).toBe("TRUCK-WIDE");
  });

  it("forbidden actions are rejected whatever the template", () => {
    const erp = freshErp();
    ready(erp, "ORD-1", 960, 2.4);
    const exc = wh.recordException(erp, { type: "QUALITY_HOLD", severity: "high", orderRef: "ORD-1", explanation: "hold" });
    const caseId = cases.openExceptionCases(erp, [exc])[0];
    for (const bad of ["RELEASE_QUALITY_HOLD", "ISSUE_CREDIT_NOTE", "EDIT_AMOUNT", "UNBLOCK_DISPATCH"]) {
      const result = cases.submitResolutionProposal(erp, caseId, { actions: [{ action: bad }] });
      expect(result.status).toBe("rejected");
      expect(result.problems[0]).toContain("never allowed");
    }
  });

  it("missing product data stops the plan", () => {
    const erp = freshErp();
    ready(erp, "ORD-2", 960, 2.4);
    erp.sqlite.prepare("UPDATE products SET unit_weight_kg = NULL WHERE gtin = ?").run(CAR);
    trucksOf(erp, ["T1", 33, 24000]);
    const plan = wh.planTruckLoads(erp, ["ORD-2"]);
    expect(plan.exceptions[0].type).toBe("PLAN_MISSING_PRODUCT_DATA");
  });

  it("scans catch wrong truck, duplicate, batch and hold", () => {
    const erp = freshErp();
    ready(erp, "ORD-3", 6960, 2.4); // 8 pallets: 7 from LOT-C-0417, the last from LOT-C-0418
    trucksOf(erp, ["T1", 33, 24000], ["T2", 33, 24000]);
    wh.planTruckLoads(erp, ["ORD-3"]);
    const picked = wh.createPickingList(erp, "ORD-3");
    const [p1, p2, p3] = [picked[0], picked[1], picked[picked.length - 1]];
    expect(p1.batch).toBe("LOT-C-0417");
    expect(p3.batch).toBe("LOT-C-0418");
    expect(availableToPromise(erp, CAR).released).toBe(12000); // picking moves no stock
    const scan = (p: wh.Pallet, extra: Partial<wh.Scan> = {}): wh.Scan => ({ pallet_id: p.pallet_id, gtin: p.gtin, batch: p.batch, qty: p.qty, truck_id: "T1", ...extra });
    recordEvent(erp, "quality_hold", { batch: p3.batch! });
    const res = wh.verifyScans(erp, "ORD-3", [scan(p1, { truck_id: "T2" }), scan(p2), scan(p2), scan(p3)]);
    expect(res.results.map((r) => r.result)).toEqual(["WRONG_TRUCK", "OK", "DUPLICATE_SCAN", "QUALITY_HOLD"]);
    const loading = wh.confirmLoading(erp, "ORD-3");
    expect(loading.pallets).toEqual([p2.pallet_id]);
    expect(new Set(loading.exceptions.map((e) => e.type))).toEqual(new Set(["MISSING_PALLET"]));
    const missing = loading.exceptions.filter((e) => e.pallet_id === p1.pallet_id);
    const caseId = cases.openExceptionCases(erp, missing)[0];
    cases.submitResolutionProposal(erp, caseId, { actions: [{ action: "REQUEST_CLARIFICATION", params: { question: "where is it?" } }] });
    cases.decideResolution(erp, caseId, { employeeId: "E", role: "warehouse_lead", decision: "approve", reason: "ask" });
    cases.executeResolution(erp, caseId);
    expect(cases.recheckExceptionCase(erp, caseId).resolution).toBe("unresolved"); // only recorded
    expect(() => wh.cancelTruckPlan(erp, "ORD-3")).toThrow(); // locked once a loading record exists
  });

  it("dispatch needs the planned truck and checks holds again", () => {
    const erp = freshErp();
    ready(erp, "ORD-4", 1920, 2.4);
    trucksOf(erp, ["T1", 33, 24000], ["T2", 33, 24000]);
    wh.planTruckLoads(erp, ["ORD-4"]);
    const pallets = wh.createPickingList(erp, "ORD-4");
    wh.verifyScans(
      erp,
      "ORD-4",
      pallets.map((p) => ({ pallet_id: p.pallet_id, gtin: p.gtin, batch: p.batch, qty: p.qty, truck_id: "T1" })),
    );
    wh.confirmLoading(erp, "ORD-4");
    const wrong = wh.authorizeDispatch(erp, "ORD-4", { shipDate: "2026-11-05", truckId: "T2" });
    expect(wrong.dispatched).toBe(false);
    expect(wrong.exceptions[0].type).toBe("WRONG_TRUCK");
    recordEvent(erp, "quality_hold", { batch: pallets[1].batch!, qty: 500 }); // partial hold after loading
    const ok = wh.authorizeDispatch(erp, "ORD-4", { shipDate: "2026-11-05" });
    expect(ok.dispatched).toBe(true);
    expect(ok.truck_id).toBe("T1");
    expect(ok.manifest_id).toBeTruthy();
    expect(erp.order("ORD-4")!.notes!.truck_id).toBe("T1");
  });

  it("a quality hold case replaces the batch", async () => {
    const erp = freshErp();
    ready(erp, "ORD-5", 960, 2.4);
    trucksOf(erp, ["T1", 33, 24000]);
    wh.planTruckLoads(erp, ["ORD-5"]);
    const [p] = wh.createPickingList(erp, "ORD-5");
    recordEvent(erp, "quality_hold", { batch: p.batch! });
    const res = wh.verifyScans(erp, "ORD-5", [{ pallet_id: p.pallet_id, gtin: p.gtin, batch: p.batch, qty: p.qty, truck_id: "T1" }]);
    const caseId = cases.openExceptionCases(erp, res.exceptions)[0];
    const pkg = cases.grokCasePackage(erp, caseId) as { never_allowed: string[]; facts: { released_batches: { batch: string }[] } };
    expect(pkg.never_allowed).toContain("RELEASE_QUALITY_HOLD");
    expect(pkg.facts.released_batches.length).toBeGreaterThan(0);
    const other = pkg.facts.released_batches[0].batch;
    const proposal = await cases.proposeWithGrok(erp, caseId, {
      caller: () => ({ actions: [{ action: "REPLACE_BATCH", params: { batch: other } }], rationale: "same product, released", confidence: 0.8 }),
    });
    expect(proposal!.status).toBe("validated");
    expect(proposal!.by).toBe("grok");
    cases.decideResolution(erp, caseId, { employeeId: "Q1", role: "quality_manager", decision: "approve", reason: "ok" });
    cases.executeResolution(erp, caseId);
    expect(cases.recheckExceptionCase(erp, caseId).resolution).toBe("resolved");
  });

  it("without a key, Grok proposes nothing and the case waits for a person", async () => {
    const erp = freshErp();
    ready(erp, "ORD-6", 960, 2.4);
    const exc = wh.recordException(erp, { type: "QUALITY_HOLD", severity: "high", orderRef: "ORD-6", explanation: "hold" });
    const caseId = cases.openExceptionCases(erp, [exc])[0];
    expect(await cases.proposeWithGrok(erp, caseId)).toBeNull();
    expect(cases.viewExceptionCase(erp, caseId)!.status).toBe("open");
  });
});
