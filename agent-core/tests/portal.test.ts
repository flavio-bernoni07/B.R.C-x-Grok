/**
 * Customer dispute chat: intake, auth, idempotency, Actions inbox, voice→confirm→persist path.
 */
import { describe, expect, it } from "vitest";
import { freshErp } from "../agent/lib/core/world";
import { seedPortalDemoOrders } from "../agent/lib/demo/portal_orders";
import {
  claimToPortalRecord,
  CUSTOMER_CONV_KIND,
  DEMO_RETAILER_GLN,
  employeeDisputeWorkspace,
  handleCustomerMessage,
  listCustomerDisputes,
  listEmployeePortalDisputes,
  simulatedSession,
} from "../agent/lib/dispute/portal";
import { voiceCapabilities } from "../agent/lib/dispute/voice";

function erpWithPortal() {
  const erp = freshErp();
  seedPortalDemoOrders(erp);
  return erp;
}

describe("customer dispute portal", () => {
  it("1+2. valid retailer creates a shortage dispute on ORD-3001", async () => {
    const erp = erpWithPortal();
    const session = simulatedSession(erp);
    const ask = await handleCustomerMessage(erp, session, {
      message: "We ordered 1,200 packages of Carnaroli but received only 1,100. The invoice is for 1,200.",
    });
    expect(ask.needs_follow_up).toBe(true);
    expect(ask.dispute_id).toBeNull();
    expect(ask.reply.toLowerCase()).toMatch(/order|reference|riferimento/);

    const done = await handleCustomerMessage(erp, session, {
      message: "ORD-3001",
      conversationId: ask.conversation_id,
    });
    expect(done.submitted).toBe(true);
    expect(done.dispute_id).toMatch(/^DSP-/);
    // Clear shortage vs matching DESADV/invoice → settled without a person.
    expect(done.status).toBe("CLOSED");
    expect(done.case_id).toBeNull();
    expect(done.reply).toContain(done.dispute_id!);
    expect(done.reply.toLowerCase()).toMatch(/reject/);

    const rec = claimToPortalRecord(erp, done.dispute_id!)!;
    expect(rec.claimed_quantity).toBe(1100);
    expect(rec.verified_quantities?.claimed_is_verified).toBe(false);
    expect(rec.supporting_internal_records).toMatchObject({ dispatched_qty: 1200, invoiced_qty: 1200 });
    expect(rec.reconciliation?.invoice_matches_dispatch).toBe(true);
    expect(erp.claim(done.dispute_id!)?.verdict).toMatchObject({ decision: "reject" });
  });

  it("3. customer reports an incorrect invoice on ORD-3002", async () => {
    const erp = erpWithPortal();
    const session = simulatedSession(erp);
    const a = await handleCustomerMessage(erp, session, {
      message: "The invoice amount is incorrect for ORD-3002 — we were charged €2.50 instead of €2.20.",
    });
    expect(a.submitted).toBe(true);
    expect(a.dispute_id).toMatch(/^DSP-/);
    const rec = claimToPortalRecord(erp, a.dispute_id!)!;
    expect(rec.category).toBe("pricing");
    expect(rec.order_id).toBe("ORD-3002");
  });

  it("4. customer reports damaged products", async () => {
    const erp = erpWithPortal();
    const session = simulatedSession(erp);
    const a = await handleCustomerMessage(erp, session, {
      message: "Some products arrived damaged on ORD-3001 — crushed packs.",
    });
    expect(a.submitted).toBe(true);
    expect(claimToPortalRecord(erp, a.dispute_id!)!.category).toBe("damage");
  });

  it("5. missing details through follow-up messages", async () => {
    const erp = erpWithPortal();
    const session = simulatedSession(erp);
    const a = await handleCustomerMessage(erp, session, { message: "We received fewer products than ordered." });
    expect(a.needs_follow_up).toBe(true);
    const b = await handleCustomerMessage(erp, session, {
      message: "Order ORD-3001, only 1100 packages received.",
      conversationId: a.conversation_id,
    });
    expect(b.submitted).toBe(true);
    expect(claimToPortalRecord(erp, b.dispute_id!)!.claimed_quantity).toBe(1100);
  });

  it("6. unauthorized customer cannot access another retailer's orders", async () => {
    const erp = erpWithPortal();
    // Carrefour session trying Esselunga's ORD-3001
    const foreign = simulatedSession(erp, "8000000000100");
    const r = await handleCustomerMessage(erp, foreign, {
      message: "Shortage on ORD-3001 — received only 1100.",
    });
    expect(r.submitted).toBe(false);
    expect(r.error).toBe("unauthorized");
    expect(erp.claims().filter((c) => c.orderRef === "ORD-3001")).toHaveLength(0);
  });

  it("7. missing order reference is handled safely", async () => {
    const erp = erpWithPortal();
    const session = simulatedSession(erp);
    const r = await handleCustomerMessage(erp, session, { message: "Our delivery hasn't arrived." });
    expect(r.submitted).toBe(false);
    expect(r.missing_fields).toContain("order_ref");
    expect(r.dispute_id).toBeNull();
  });

  it("8. duplicate message submission does not create duplicate cases", async () => {
    const erp = erpWithPortal();
    const session = simulatedSession(erp);
    const key = "idem-shortage-1";
    const a = await handleCustomerMessage(erp, session, {
      message: "Shortage ORD-3001 received only 1100",
      idempotencyKey: key,
    });
    expect(a.submitted).toBe(true);
    const b = await handleCustomerMessage(erp, session, {
      message: "Shortage ORD-3001 received only 1100",
      conversationId: a.conversation_id,
      idempotencyKey: key,
    });
    expect(b.dispute_id).toBe(a.dispute_id);
    expect(erp.claims().filter((c) => c.orderRef === "ORD-3001")).toHaveLength(1);
  });

  it("9. separate disputes on one order remain distinct", async () => {
    const erp = erpWithPortal();
    const session = simulatedSession(erp);
    const short = await handleCustomerMessage(erp, session, {
      message: "Shortage on ORD-3001 — received only 1100 packs.",
    });
    const dmg = await handleCustomerMessage(erp, session, {
      message: "Also on ORD-3001 some products arrived damaged.",
    });
    expect(short.dispute_id).not.toBe(dmg.dispute_id);
    expect(erp.claims().filter((c) => c.orderRef === "ORD-3001")).toHaveLength(2);
  });

  it("10. customer claim is not automatically treated as verified evidence", async () => {
    const erp = erpWithPortal();
    const session = simulatedSession(erp);
    const a = await handleCustomerMessage(erp, session, {
      message: "ORD-3001 received only 1100 — please refund.",
    });
    // unauthorized refund ask may block submit; send clean report
    const b =
      a.submitted
        ? a
        : await handleCustomerMessage(erp, session, {
            message: "ORD-3001 received only 1100 packages.",
            conversationId: a.conversation_id,
          });
    expect(b.submitted).toBe(true);
    const rec = claimToPortalRecord(erp, b.dispute_id!)!;
    expect(rec.verified_quantities?.claimed_is_verified).toBe(false);
    expect(erp.documents({ kind: "FatturaPA TD04" })).toHaveLength(0);
  });

  it("11+12. damage claim hands off to Sign-off; notification fires", async () => {
    const erp = erpWithPortal();
    const session = simulatedSession(erp, "8000000000100");
    const a = await handleCustomerMessage(erp, session, {
      message: "ORD-3003 — 60 Arborio packs crushed on arrival at our warehouse.",
    });
    expect(a.submitted).toBe(true);
    expect(a.status).toBe("ACTION_REQUIRED");
    expect(a.case_id).toMatch(/^SO-/);
    expect(erp.notifications().some((n) => n.subjectRef === a.dispute_id)).toBe(true);
    const inbox = listEmployeePortalDisputes(erp);
    expect(inbox.some((r) => r.dispute_id === a.dispute_id && r.signoff_status === "pending")).toBe(true);
    const ws = employeeDisputeWorkspace(erp, a.case_id!);
    expect(ws.customer_reported.category).toBe("damage");
    expect(ws.case.kind).toBe("verdict");
    expect(ws.next_action.requires_approval).toBe(true);
  });

  it("13. customer can retrieve its actual status", async () => {
    const erp = erpWithPortal();
    const session = simulatedSession(erp);
    const a = await handleCustomerMessage(erp, session, {
      message: "ORD-3001 received only 1100 packages.",
    });
    const st = await handleCustomerMessage(erp, session, {
      message: `What is the status of ${a.dispute_id}?`,
      conversationId: a.conversation_id,
    });
    expect(st.reply).toContain(a.dispute_id!);
    expect(st.reply).toContain("CLOSED");
    expect(listCustomerDisputes(erp, session).map((d) => d.dispute_id)).toContain(a.dispute_id);
  });

  it("16. customer cannot request unauthorized refunds or invoice changes", async () => {
    const erp = erpWithPortal();
    const session = simulatedSession(erp);
    const r = await handleCustomerMessage(erp, session, {
      message: "Please issue a credit note and refund us immediately for ORD-3001.",
    });
    expect(r.submitted).toBe(false);
    expect(r.reply.toLowerCase()).toMatch(/can't authorize|non posso autorizzare/);
    expect(erp.claims()).toHaveLength(0);
  });

  it("17. reconciliation distinguishes invoice matching dispatch from delivery shortage claim", async () => {
    const erp = erpWithPortal();
    const session = simulatedSession(erp);
    const a = await handleCustomerMessage(erp, session, {
      message: "ORD-3001 — we received only 1100 but invoice is 1200.",
    });
    const rec = claimToPortalRecord(erp, a.dispute_id!)!;
    expect(rec.reconciliation?.invoice_matches_dispatch).toBe(true);
    expect(rec.claimed_quantity).toBe(1100);
    expect(Number(rec.supporting_internal_records.dispatched_qty)).toBe(1200);
  });

  it("employee can approve an ambiguous phone/chat verdict (normal dispute path)", async () => {
    const erp = erpWithPortal();
    const session = simulatedSession(erp, "8000000000100");
    const a = await handleCustomerMessage(erp, session, {
      message: "ORD-3003 — 60 Arborio packs crushed on arrival.",
    });
    expect(a.status).toBe("ACTION_REQUIRED");
    expect(a.case_id).toMatch(/^SO-/);
    const { approveVerdict } = await import("../agent/lib/dispute/service");
    const out = approveVerdict(erp, a.case_id!, {
      by: "Sara, credit desk",
      reason: "Reject: no photo evidence of damage at gate-in",
    });
    expect(out.status).toBe("closed");
    expect(out.claim_id).toBe(a.dispute_id);
    const rec = claimToPortalRecord(erp, a.dispute_id!)!;
    expect(["CLOSED", "RESOLVED"]).toContain(rec.status);
  });

  it("simulated session is clearly labeled", () => {
    const erp = erpWithPortal();
    const s = simulatedSession(erp, DEMO_RETAILER_GLN);
    expect(s.simulated).toBe(true);
    expect(s.label).toMatch(/SIMULATED/);
    expect(s.retailer_name).toBe("Esselunga");
  });

  it("stores conversation as a document, not portal_* tables", async () => {
    const erp = erpWithPortal();
    const session = simulatedSession(erp);
    const a = await handleCustomerMessage(erp, session, {
      message: "ORD-3001 received only 1100 packages.",
    });
    expect(erp.documents({ kind: CUSTOMER_CONV_KIND, ref: a.conversation_id }).length).toBe(1);
    const body = JSON.parse(erp.documents({ kind: CUSTOMER_CONV_KIND, ref: a.conversation_id })[0].body!);
    expect(body.messages.some((m: { role: string }) => m.role === "customer")).toBe(true);
    expect(body.messages.some((m: { role: string }) => m.role === "assistant")).toBe(true);
  });

  it("spoken complaint path: confirmed transcript text creates employee dispute", async () => {
    // Voice STT only produces draft text; confirmed text uses the same chat workflow.
    const caps = voiceCapabilities();
    expect(caps.browser_speech_fallback).toBe(true);
    expect(typeof caps.transcription).toBe("boolean");

    const erp = erpWithPortal();
    const session = simulatedSession(erp);
    const transcript = "We ordered 1200 Carnaroli on ORD-3001 but received only 1100.";
    const result = await handleCustomerMessage(erp, session, {
      message: transcript,
      idempotencyKey: "voice-draft-confirmed-1",
    });
    expect(result.submitted).toBe(true);
    expect(result.dispute_id).toMatch(/^DSP-/);
    expect(result.status).toBe("CLOSED");
    expect(erp.notifications().some((n) => n.subjectRef === result.dispute_id)).toBe(true);
    expect(erp.claim(result.dispute_id!)?.verdict).toMatchObject({ decision: "reject" });
  });
});
