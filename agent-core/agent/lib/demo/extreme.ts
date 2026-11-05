/**
 * The hard case, closed (demo data): one Coop order that hits every exception the back office
 * handles, each decided where the README says, and closed at the end. Run after the history seed,
 * so the stock it splits on is the stock the app shows.
 *
 * 1. Order:    Coop's ORDERS for Parboiled 1 kg is written by hand: the date as 02/11/2026 and the quantity as "4.500".
 *              The parser flags both; Grok corrects them (recorded answer). There are not 4,500
 *              packs free, so code computes the allowed answers and Grok picks the split:
 *              what is free now, the rest from the next planned run. Giulia (order desk) confirms;
 *              her reason is recorded as a Playbook lesson (1 of the 3 matching decisions after which
 *              Grok fixes this retailer's dates and quantities without asking).
 * 2. Loading:  one pallet is scanned onto the wrong truck, which has already left. Grok flags it and
 *              asks what to do: hold the Coop truck until the pallet is back and sorted (about 3 hours,
 *              misses the slot), or ship the rest now and book the pallet as a loss. Luca (warehouse
 *              lead) picks the loss: there is no time to wait. Booking it writes the write-off note
 *              for accounting; the DESADV, the DDT and the invoice tell Coop only what shipped, and
 *              Coop signs the DDT for that.
 * 3. Dispute:  Coop claims a penalty for the incomplete delivery. Grok's verdict: reject, under §7 of
 *              the contract the short shipment was notified in the DESADV and matched on the invoice,
 *              and no penalty amount is fixed. Rejecting a claim is a person's call: Marco (credit desk)
 *              confirms and the evidence reply goes out.
 * 4. Finance:  Coop pays the invoice in full (REMADV). Nothing waits for a person or for Grok.
 *
 * Every figure in the messages (packs free, the split, the pallet, the amounts) is read from the
 * Mini ERP while the seed runs, so the recorded answers pass the same number checks as live ones.
 */
import type { Erp } from "../core/erp";
import { availableToPromise, nextReadyDate } from "../core/stock";
import { approveVerdict, handleClaim } from "../dispute/service";
import type { Caller, Message } from "../grok/client";
import { confirmOrder, receiveOrder, resolveQtyCase } from "../order/service";
import * as cases from "../shipping/cases";
import { chooseResolution } from "../shipping/choose";
import { ingestConfirmedOrder, invoiceShipment, reconcileAndSend, recordDelivery } from "../shipping/service";
import * as wh from "../shipping/warehouse";
import { applyRemittance } from "./case-study";
import { SHOWCASE_ORDER } from "./showcase";

export { SHOWCASE_ORDER };

const REF = SHOWCASE_ORDER;
const PRODUCT = "8003660012415"; // Parboiled 1 kg: nothing else in the demo needs its free stock
const COOP = "8000000000124";
const PRICE = 2.15; // CTR-SCOTTI-COO-2026, under the 4,800-pack discount
const ORDERED = 4500;
const eur = (v: number) => v.toFixed(2);
const n = (v: number) => v.toLocaleString("en-US");

/** Coop's ORDERS as their buyer typed it: a dd/mm/yyyy date and an Italian thousands dot. */
const ordersEdi = () =>
  `UNH+1+ORDERS:D:96A:UN'BGM+220+${REF}+9'DTM+137:02/11/2026:102'NAD+BY+${COOP}::9'NAD+SU+SUPPLIER001::9'` +
  `LIN+1++${PRODUCT}:EN'QTY+21:4.500'PRI+AAA:${PRICE}:CT'UNS+S'UNT+10+1'`;

/** Grok's recorded answers for the order row, picked by the step that asks (same checks as live). */
function orderCaller(now: number, later: number, laterDate: string, product: string): Caller {
  return (messages: Message[]) => {
    const text = messages.map((m) => String(m.content)).join("\n");
    if (text.includes("corrected_edi")) {
      return {
        corrected_edi: ordersEdi().replace("DTM+137:02/11/2026:102", "DTM+137:20261102:102").replace("QTY+21:4.500", `QTY+21:${ORDERED}`),
        confidence: 0.88,
        changes: [
          { segment: "DTM", before: "02/11/2026", after: "20261102", why: "dd/mm/yyyy written instead of CCYYMMDD" },
          { segment: "QTY", before: "4.500", after: String(ORDERED), why: "Italian thousands separator: four thousand five hundred packs, not four and a half" },
        ],
      };
    }
    return {
      action: "split",
      message:
        `Gentile Coop Italia, per l'ordine ${REF} possiamo consegnare subito ${now} confezioni di ${product} ` +
        `e le restanti ${later} dal ${laterDate}, con il prossimo lotto. Vi confermiamo le due consegne con l'ORDRSP. Cordiali saluti, Riso Scotti.`,
      why: "The free stock covers most of the order now and the next planned run covers the rest, so Coop's shelf stays stocked instead of cutting the order.",
      confidence: 0.84,
    };
  };
}

export async function seedExtremeCase(erp: Erp, opts: { say?: (line: string) => void } = {}): Promise<string> {
  const say = opts.say ?? (() => {});

  // 1. Order. Less is free than Coop asks, and the next run is on the plan: a split is possible.
  const now = Math.trunc(availableToPromise(erp, PRODUCT, "2026-11-02").atp);
  const later = ORDERED - now;
  const laterDate = nextReadyDate(erp, PRODUCT);
  const product = erp.product({ gtin: PRODUCT })?.name ?? "Riso Scotti Parboiled 1 kg";
  if (now <= 0 || later <= 0 || !laterDate) throw new Error(`${REF}: expected a split, free ${product} is ${now}, next run ${laterDate}`);
  const caller = orderCaller(now, later, laterDate, product);
  let r = await receiveOrder(erp, ordersEdi(), { sourceName: `ORDERS_${REF}.edi`, caller });
  if (r.step === "qty_choice") {
    const chosen = await resolveQtyCase(erp, r.case_id, {
      by: "Giulia Ferri, order desk",
      reason: "Coop types dates as dd/mm/yyyy and thousands with a dot: Grok's fix is right, and the split keeps their shelf full",
      action: "split",
      caller,
    });
    if (chosen.status !== "awaiting_person" && chosen.status !== "confirmed") {
      throw new Error(`${REF}: split did not return an order to confirm (${chosen.status})`);
    }
    r = chosen;
  }
  if (r.step !== "confirm") throw new Error(`${REF}: expected the fix and the split to confirm, got ${r.step} (${r.case_id})`);
  const lesson = "Coop types dates as dd/mm/yyyy and thousands with a dot: Grok's fix is right, and the split keeps their shelf full";
  const handoff = confirmOrder(erp, r.case_id, { by: "Giulia Ferri, order desk", reason: lesson });
  erp.log("person:Giulia Ferri, order desk", "playbook.lesson", REF, {
    sourceDoc: r.case_id,
    detail: { lesson, retailer: "Coop Italia", matching_decisions: 1, needed: 3, then: "Grok fixes Coop's dates and quantities with no person" },
  });
  ingestConfirmedOrder(erp, handoff);
  say(`${REF}: Grok fixed the EDI and split ${n(now)} now + ${n(later)} on ${laterDate}; Giulia confirms`);

  // 2. Loading on 3 Nov: the last pallet goes onto the Ancona truck, which leaves with it.
  wh.registerTrucks(erp, [
    { truck_id: "TRUCK-PV-11", plate: "GH318NB", destination: "CeDi Coop Nord", pallet_capacity: 33, max_payload_kg: 24000, window: ["2026-11-03", "2026-11-03"] },
    { truck_id: "TRUCK-PV-12", plate: "GH402NB", destination: "CeDi Ancona", pallet_capacity: 33, max_payload_kg: 24000, window: ["2026-11-03", "2026-11-03"] },
  ] as Parameters<typeof wh.registerTrucks>[1]);
  const planned = wh.planTruckLoads(erp, [REF], { onlyTruckId: "TRUCK-PV-11" });
  if (!planned.planned.length) throw new Error(`${REF}: no truck planned (${JSON.stringify(planned)})`);
  const picks = wh.createPickingList(erp, REF);
  const scans = picks.map((p) => ({ pallet_id: p.pallet_id, gtin: p.gtin, batch: p.batch, qty: p.qty, truck_id: "TRUCK-PV-11" }));
  const lost = scans.reduce((best, s) => (s.qty > best.qty ? s : best), scans[0]);
  lost.truck_id = "TRUCK-PV-12";
  const checked = wh.verifyScans(erp, REF, scans);
  const wrong = checked.exceptions.filter((e) => e.type === "WRONG_TRUCK");
  const [caseId] = cases.openExceptionCases(erp, wrong);
  if (!caseId) throw new Error(`${REF}: the wrong-truck case did not open`);
  const lossEur = Math.round(lost.qty * PRICE * 100) / 100;
  const lossText = `€${lossEur.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  // Grok does not pick here: both answers cost something, so it flags the pallet and asks (recorded answer).
  erp.log("grok", "shipping.options_asked", caseId, {
    sourceDoc: caseId,
    detail: {
      problem: `Pallet ${lost.pallet_id} (${n(lost.qty)} packs) left on TRUCK-PV-12 for Ancona.`,
      question: "Hold TRUCK-PV-11 until it is back and sorted, or ship now and book the loss?",
      options: [
        { action: "RESCAN_PALLET", text: "Hold TRUCK-PV-11 until the pallet is back and sorted: about 3 hours, and Coop's slot is missed" },
        { action: "SHIP_WITHOUT_PALLET", text: `Ship the other pallets now and book the ${n(lost.qty)} packs (${lossText}) as a loss, with the documents for Coop and for accounting` },
      ],
      pallet: lost.pallet_id,
      qty: lost.qty,
      eur: lossEur,
    },
  });
  await chooseResolution(erp, caseId, {
    action: "SHIP_WITHOUT_PALLET",
    by: "Luca Galli, warehouse lead",
    reason: "No time to wait: holding the truck 3 hours misses Coop's slot. Ship now and book the loss",
  });
  if (!wh.loadingFor(erp, REF)) wh.confirmLoading(erp, REF);
  const sent = wh.authorizeDispatch(erp, REF, { shipDate: "2026-11-03" });
  const shipped = erp.shipments(REF).flatMap((s) => s.lines).reduce((a, l) => a + l.qty, 0);
  const inv = invoiceShipment(erp, sent.desadv_ref!, { invoiceDate: "2026-11-03" });
  await reconcileAndSend(erp, REF);
  recordDelivery(erp, sent.desadv_ref!, { signedBy: "Coop Italia, CeDi Coop Nord", received: { [PRODUCT]: shipped }, when: "2026-11-04" });
  say(`${REF}: shipped ${n(shipped)} on ${sent.truck_id}, ${n(lost.qty)} packs booked as a loss (€${eur(lossEur)}); invoice ${inv.invoice_ref}`);

  // 3. Coop claims a 5% penalty on the order value for the incomplete delivery.
  const penalty = Math.round(ORDERED * PRICE * 0.05 * 100) / 100;
  const email =
    `Da: ufficio.amministrazione@coop.example\nOggetto: Penale consegna incompleta ${REF}\n\n` +
    `Buongiorno, l'ordine ${REF} di ${n(ORDERED)} confezioni di ${product.replace(/^Riso Scotti /, "")} e' arrivato incompleto il 04/11/2026: ` +
    `abbiamo ricevuto ${n(shipped)} confezioni. Come da accordi applichiamo una penale del 5% sul valore dell'ordine, ` +
    `pari a EUR ${eur(penalty)}, che tratterremo sulla prossima rimessa.\nCordiali saluti, Coop Italia`;
  const extraction = {
    order_ref: REF,
    invoice_ref: inv.invoice_ref,
    product: product.replace(/^Riso Scotti /, ""),
    quantity: ORDERED - shipped,
    amount: penalty,
    claim_type: "other",
    confidence: 0.9,
    raw_notes: `Penalty of 5% of the order value for an incomplete delivery: ${n(shipped)} of ${n(ORDERED)} packs received`,
  };
  const verdict = {
    decision: "reject",
    amount: null,
    confidence: 0.86,
    needs_sign_off: false,
    summary:
      `Coop asks a 5% penalty for an incomplete delivery. Under §7 of the contract a short shipment notified in the DESADV and matched on the invoice is not a penalty case, and no penalty amount is fixed: ` +
      `the ORDRSP confirmed ${n(now)} now and ${n(later)} from ${laterDate}, the DESADV notified the pallet left behind, and invoice ${inv.invoice_ref} bills only the ${n(shipped)} packs shipped. Reject and send the evidence.`,
    points: [
      { text: `ORDRSP confirmed ${n(now)} now and ${n(later)} from the next run`, amount: null, source: { kind: "order", ref: REF, detail: "split agreed before shipping" } },
      { text: `DESADV notified ${n(shipped)} packs shipped`, amount: null, source: { kind: "desadv", ref: sent.desadv_ref, detail: "the pallet left behind is not on it" } },
      { text: `Invoice bills only what shipped`, amount: null, source: { kind: "invoice", ref: inv.invoice_ref, detail: `${n(shipped)} packs at €${PRICE}` } },
      { text: "DDT signed by Coop for the same quantity", amount: null, source: { kind: "ddt", ref: sent.ddt_ref, detail: `received ${n(shipped)}, no reservation` } },
    ],
  };
  const claim = await handleClaim(erp, email, {
    sourceName: `claim_${REF}.txt`,
    readCaller: () => ({ ...extraction }),
    verdictCaller: () => JSON.parse(JSON.stringify(verdict)),
    issueDate: "2026-11-05",
  });
  if (claim.status !== "awaiting_person" || !("case_id" in claim)) throw new Error(`${REF}: the penalty claim should wait for a person, got ${claim.status}`);
  approveVerdict(erp, claim.case_id, {
    by: "Marco Bellini, credit desk",
    reason: "§7: the short shipment was notified and not billed, and no penalty is fixed. Reject with the evidence",
    issueDate: "2026-11-05",
  });
  say(`${REF}: claim ${claim.claim_id} rejected by Marco under §7; evidence reply sent`);

  // 4. Coop pays the invoice in full: no deduction, the order is closed.
  const total = inv.total ?? erp.invoices(REF).at(-1)?.total ?? 0;
  const remadv = [
    "UNH+1+REMADV:D:96A:UN:EAN002'",
    "BGM+481+RA-COO-2026-11-05+9'",
    "DTM+137:20261105:102'",
    "DTM+209:20261105:102'",
    "NAD+PE+SUPPLIER001::9'",
    `NAD+PR+${COOP}::9'`,
    "CUX+2:EUR:11'",
    `MOA+9:${eur(total)}'`,
    `DOC+380+${inv.invoice_ref}'`,
    `MOA+12:${eur(total)}'`,
    `MOA+9:${eur(total)}'`,
  ];
  remadv.push(`UNT+${remadv.length}+1'`);
  await applyRemittance(erp, `${remadv.join("\n")}\n`, { sourceName: "REMADV RA-COO-2026-11-05" });
  say(`${REF}: Coop paid €${eur(total)} in full. Closed.`);
  return REF;
}
