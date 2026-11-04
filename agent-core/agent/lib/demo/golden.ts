/**
 * The golden order through every row, end to end (port of demo.py). Offline with recorded Grok
 * answers unless `live`. It seeds a new app database so every page opens on real cases.
 *
 * 1. Order:    Esselunga's ORDERS for 12,000 Carnaroli 1 kg → checks → a person confirms → ORDRSP
 * 2. Shipping: a quality hold blocks 1,200 packs → trucks, picking, scans (one wrong truck, fixed
 *              through an exception case) → dispatch 10,800 → TD01 + INVOIC 380 → reconcile
 * 3. Dispute:  the retailer reports a missing pallet, the signed DDT backs it → credit note with no
 *              person; then an unclear claim goes to a person
 * 4. Digest:   the weekly summary
 *
 * Unlike demo.py, the unclear claim is left waiting in the sign-off queue, so the app has a
 * case for a person to decide (pass `decideUnclear: true` to approve it as demo.py does).
 */
import { readFileSync } from "node:fs";
import { buildDigest } from "../core/digest";
import type { Erp } from "../core/erp";
import { pending } from "../core/signoff";
import { recordEvent } from "../core/stock";
import { hasKey } from "../grok/client";
import { approveVerdict, handleClaim, offlineCallers } from "../dispute/service";
import { confirmOrder, receiveOrder } from "../order/service";
import * as cases from "../shipping/cases";
import { exportForDispute, ingestConfirmedOrder, invoiceShipment, recordDelivery, reconcileAndSend } from "../shipping/service";
import * as wh from "../shipping/warehouse";
import { dataPath } from "../paths";

export type GoldenResult = {
  order: string | undefined;
  shipping: string;
  goldenClaim: string;
  unclearClaim: string;
  pendingSignoffs: number;
  auditEvents: number;
  disputeCatalogOrders: number;
  digest: string;
};

const golden = (f: string) => dataPath("world", "golden", f);
const disputes = (...f: string[]) => dataPath("disputes", ...f);
const read = (p: string) => readFileSync(p, "utf8");

export async function runGolden(
  erp: Erp,
  opts: { live?: boolean; say?: (line: string) => void; decideUnclear?: boolean } = {},
): Promise<GoldenResult> {
  const say = opts.say ?? (() => {});
  const live = !!opts.live;
  if (live && !hasKey()) throw new Error("live needs XAI_API_KEY or GROK_API_KEY");

  // 1. Order
  say("== 1. Order");
  const r = await receiveOrder(erp, read(golden("ORDERS_ESS-GOLD-001.edi")), { sourceName: "ORDERS_ESS-GOLD-001.edi" });
  const c = erp.signoff(r.case_id)!;
  say(`ORDERS ${r.order_ref} checked; sign-off ${c.caseId} waits: ${(c.reasons ?? []).join("; ")}`);
  const handoff = confirmOrder(erp, r.case_id, { by: "Giulia, order desk", reason: "Stock and contract price check out" });
  say(`Giulia confirms. ORDRSP ${handoff.ordrsp_ref} goes to Esselunga; hand-over to Shipping`);
  const orderStatus = erp.order("ESS-GOLD-001")?.status;

  // 2. Shipping and invoicing
  say("== 2. Shipping and invoicing");
  ingestConfirmedOrder(erp, handoff);
  recordEvent(erp, "quality_hold", { batch: "LOT-C-0418", qty: 1200, note: "lab sample: 9% chalky grains" });
  say("Production event: quality hold on 1,200 packs of batch LOT-C-0418");
  wh.registerTrucks(erp, [
    { truck_id: "TRUCK-PV-01", plate: "FX482KL", destination: "CeDi Melzo", pallet_capacity: 33, max_payload_kg: 24000, window: ["2026-11-05", "2026-11-06"] },
    { truck_id: "TRUCK-PV-02", plate: "GB117RT", destination: "CeDi Melzo", pallet_capacity: 33, max_payload_kg: 24000, window: ["2026-11-05", "2026-11-06"] },
  ] as Parameters<typeof wh.registerTrucks>[1]);
  const plan = wh.planTruckLoads(erp, ["ESS-GOLD-001"]);
  say(`Planned on ${plan.planned[0]?.truck_id} (${plan.planned[0]?.manifest_id})`);
  const picks = wh.createPickingList(erp, "ESS-GOLD-001");
  say(`Picking list: ${picks.length} pallets from released batches only`);
  const scans = picks.map((p) => ({ pallet_id: p.pallet_id, gtin: p.gtin, batch: p.batch, qty: p.qty, truck_id: "TRUCK-PV-01" }));
  scans[3] = { ...scans[3], truck_id: "TRUCK-PV-02" }; // one pallet scanned onto the wrong truck
  const checked = wh.verifyScans(erp, "ESS-GOLD-001", scans);
  const wrong = checked.exceptions.filter((e) => e.type === "WRONG_TRUCK");
  say(`Scans: ${checked.results.filter((s) => s.result === "OK").length} OK, ${wrong[0]?.explanation}`);
  const caseId = cases.openExceptionCases(erp, wrong)[0];
  let proposal = live ? await cases.proposeWithGrok(erp, caseId) : null;
  if (!proposal || proposal.status !== "validated") {
    proposal = cases.submitResolutionProposal(
      erp,
      caseId,
      { actions: [{ action: "RESCAN_PALLET" }], rationale: "scan it again on the planned truck" },
      { by: "grok (recorded)" },
    );
  }
  say(`${caseId}: proposal ${proposal.proposal_id} ${proposal.status}`);
  cases.decideResolution(erp, caseId, {
    employeeId: "Marco, warehouse lead",
    role: "warehouse_lead",
    decision: "approve",
    reason: "Driver loaded it on the next truck by mistake",
  });
  cases.executeResolution(erp, caseId);
  wh.verifyScans(erp, "ESS-GOLD-001", [{ ...scans[3], truck_id: "TRUCK-PV-01" }]);
  say(`Marco approves, the pallet is scanned again: ${cases.recheckExceptionCase(erp, caseId).resolution}`);
  const loading = wh.confirmLoading(erp, "ESS-GOLD-001");
  const sent = wh.authorizeDispatch(erp, "ESS-GOLD-001", { shipDate: "2026-11-05" });
  say(`Dispatched ${sent.desadv_ref} on ${sent.truck_id}: ${loading.pallets.length} pallets. Short: ${JSON.stringify(sent.short ?? [])}`);
  const inv = invoiceShipment(erp, sent.desadv_ref!, { invoiceDate: "2026-11-05" });
  say(`Invoice ${inv.invoice_ref}: net €${inv.net.toFixed(2)} + VAT €${inv.vat.toFixed(2)} (FatturaPA TD01)`);
  const rec = await reconcileAndSend(erp, "ESS-GOLD-001");
  say(`Reconcile: ${JSON.stringify(rec.report.status)}. Invoice ${rec.status}. threeway would call this line matched.`);
  recordDelivery(erp, sent.desadv_ref!, {
    signedBy: "Esselunga CeDi Melzo",
    received: { "8000000000001": 10560 },
    note: "1 pallet mancante (240 pz)",
    when: "2026-11-06",
  });
  say("Delivery: the retailer signs the DDT with a reservation, 10,560 received");

  // 3. Dispute
  say("== 3. Dispute");
  const [readC, verdictC] = live ? [null, null] : offlineCallers(golden("grok_offline.json"));
  const claim = await handleClaim(erp, read(golden("claim_email.txt")), {
    sourceName: "claim_email.txt",
    readCaller: readC,
    verdictCaller: verdictC,
    issueDate: "2026-11-07",
  });
  say(`Claim ${claim.claim_id}: ${claim.status}`);

  const unclear = JSON.parse(read(disputes("extractions", "05_ambiguous.json")));
  const unclearVerdict = JSON.parse(read(disputes("verdicts", "05_ambiguous_reject.json")));
  for (const k of ["claim", "playbook_path", "contract_path", "amount_notes", "known_amounts"]) delete unclearVerdict[k];
  const claim2 = await handleClaim(erp, read(disputes("claims", "05_ambiguous_otif_or_shortage.txt")), {
    sourceName: "05_ambiguous_otif_or_shortage.txt",
    readCaller: live ? null : () => ({ ...unclear }),
    verdictCaller: live ? null : () => JSON.parse(JSON.stringify(unclearVerdict)),
  });
  if (claim2.status === "awaiting_person") {
    const so = erp.signoff(claim2.case_id)!;
    say(`Claim ${claim2.claim_id} is unclear, sign-off ${so.caseId}: ${(so.reasons ?? []).join("; ")}`);
    if (opts.decideUnclear) {
      approveVerdict(erp, so.caseId, { by: "Sara, credit desk", reason: "Late gate-in, quantities agree: reply with the evidence", issueDate: "2026-11-07" });
      say("Sara approves; the reply is written and the case is added to the Playbook's past cases");
    }
  }

  // 4. Digest
  const digest = buildDigest(erp, "Weekly digest, week of 2 Nov 2026").markdown;
  say("== 4. Weekly digest");
  say(digest);
  return {
    order: orderStatus,
    shipping: rec.status,
    goldenClaim: claim.status,
    unclearClaim: claim2.status,
    pendingSignoffs: pending(erp).length,
    auditEvents: erp.auditLog().length,
    disputeCatalogOrders: exportForDispute(erp).orders.length,
    digest,
  };
}
