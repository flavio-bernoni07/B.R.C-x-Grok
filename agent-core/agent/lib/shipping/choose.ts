/**
 * A person picks one of an exception case's options from the order panel: Grok's suggestion, or
 * another allowed action. Code still checks the action (`submitResolutionProposal`) and the person
 * still signs it (`decideSignoff`), so the audit log reads: Grok proposed X, a person chose Y, why.
 *
 * Then the follow-up the warehouse would do, so the truck can go:
 * - RESCAN_PALLET on a wrong-truck case: the pallet is scanned again onto its planned truck.
 * - SHIP_WITHOUT_PALLET: the pallet stays behind and its value is booked as a loss, with a
 *   write-off note (document kind "write-off note") for accounting.
 * - Once no case is open on the order and nothing is left to scan, the truck is loaded.
 */
import type { Erp } from "../core/erp";
import { pending } from "../core/signoff";
import { proposal as proposalOf, recheckExceptionCase, submitResolutionProposal, viewExceptionCase } from "./cases";
import { decideSignoff } from "./decide";
import * as wh from "./warehouse";

export type ChooseResult = { case_id: string; action: string; resolution: string | null; truck: string | null; truck_released: boolean; loss_eur: number | null };

export async function chooseResolution(
  erp: Erp,
  caseId: string,
  choice: { action: string; params?: Record<string, unknown> | null; by: string; reason?: string | null },
): Promise<ChooseResult> {
  const c = viewExceptionCase(erp, caseId);
  if (!c) throw new Error(`no exception case ${caseId}`);
  if (c.status === "executed") throw new Error(`${caseId} is already done`);
  if (!c.possible_actions.some((a) => a.action === choice.action)) throw new Error(`${choice.action} is not an option for a ${c.type} case`);
  const by = choice.by.trim();
  const waiting = pending(erp).find((s) => s.kind === "exception_case" && s.subjectRef === caseId);
  const proposed = waiting ? proposalOf(erp, String((waiting.proposal ?? {}).proposal_id ?? "")) : undefined;
  const isGroks = !!proposed && proposed.actions.some((a) => a.action === choice.action);
  const reason = choice.reason?.trim() || (isGroks ? "Grok's suggestion, confirmed" : `Chose ${choice.action.toLowerCase().replace(/_/g, " ")} instead`);

  let signoff = waiting?.caseId ?? null;
  if (waiting && !isGroks) {
    // Grok's proposal is turned down with the person's reason; the person's own choice goes through the same checks.
    await decideSignoff(erp, waiting.caseId, { approve: false, by, reason: `${reason} (instead of Grok's proposal)` });
    signoff = null;
  }
  if (!signoff) {
    const p = submitResolutionProposal(erp, caseId, { actions: [{ action: choice.action, params: choice.params ?? {} }], rationale: reason }, { by: `person:${by}` });
    if (p.status !== "validated") throw new Error(`${choice.action} was refused: ${p.problems.join("; ")}`);
    signoff = viewExceptionCase(erp, caseId)?.signoff_case ?? null;
    if (!signoff) throw new Error(`${caseId}: no sign-off was opened for ${choice.action}`);
  }
  const decided = (await decideSignoff(erp, signoff, { approve: true, by, reason })) as { resolution?: string };

  // The warehouse follow-up.
  const after = viewExceptionCase(erp, caseId)!;
  const orderRef = after.order_ref!;
  const pallet = wh.pallet(erp, after.pallet_id);
  const manifest = wh.manifestForOrder(erp, orderRef);
  let lossEur: number | null = null;
  let resolution = decided.resolution ?? null;
  if (choice.action === "RESCAN_PALLET" && pallet && manifest) {
    wh.verifyScans(erp, orderRef, [{ pallet_id: pallet.pallet_id, gtin: pallet.gtin, batch: pallet.batch, qty: pallet.qty, truck_id: manifest.truck_id }]);
  }
  if (choice.action === "SHIP_WITHOUT_PALLET" && pallet) {
    const price = erp.order(orderRef)?.lines.find((l) => l.gtin === pallet.gtin)?.unitPrice ?? 0;
    lossEur = Math.round(pallet.qty * price * 100) / 100;
    // The write-off note accounting books the loss from; the DESADV, DDT and invoice tell the retailer what shipped.
    const note = erp.addDocument(
      "write-off note",
      orderRef,
      JSON.stringify({ order: orderRef, case: caseId, pallet: pallet.pallet_id, gtin: pallet.gtin, batch: pallet.batch, qty: pallet.qty, unit_price: price, eur: lossEur, booked_by: by, reason }),
    );
    erp.log(`person:${by}`, "shipping.loss_booked", orderRef, { sourceDoc: caseId, detail: { pallet: pallet.pallet_id, qty: pallet.qty, eur: lossEur, reason, loss_note: note } });
  }
  if (after.type === "WRONG_TRUCK" || after.type === "MISSING_PALLET") {
    resolution = recheckExceptionCase(erp, caseId).resolution;
  }

  // The truck goes once nothing on this order is open or left unscanned.
  const stillOpen = wh
    .all<{ data: string }>(erp, "SELECT data FROM si_exception_cases")
    .map((r) => JSON.parse(r.data) as { order_ref: string | null; status: string; type: string })
    .some((x) => x.order_ref === orderRef && x.status !== "executed" && ["WRONG_TRUCK", "MISSING_PALLET", "WRONG_PRODUCT", "WRONG_BATCH", "BAD_QUANTITY"].includes(x.type));
  const unscanned = wh.pallets(erp, orderRef).some((p) => p.status === "picked" || p.status === "rejected");
  let released = false;
  if (!stillOpen && !unscanned && manifest && !wh.loadingFor(erp, orderRef)) {
    const loaded = wh.confirmLoading(erp, orderRef);
    released = loaded.exceptions.length === 0;
  }
  return { case_id: caseId, action: choice.action, resolution, truck: manifest?.truck_id ?? null, truck_released: released, loss_eur: lossEur };
}
