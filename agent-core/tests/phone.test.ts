/**
 * Phone webhook signature + tool path into Actions disputes (no live SIP).
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { freshErp } from "../agent/lib/core/world";
import { seedPortalDemoOrders } from "../agent/lib/demo/portal_orders";
import {
  buildSubmitMessage,
  dispatchPhoneTool,
  simulatePhoneDispute,
} from "../agent/lib/dispute/phone_agent";
import { resolvePhoneSession } from "../agent/lib/dispute/phone_identity";
import {
  extractCallerFrom,
  extractCallId,
  signWebhookBody,
  verifyWebhookSignature,
} from "../agent/lib/dispute/phone_webhook";
import { claimToPortalRecord, listEmployeePortalDisputes } from "../agent/lib/dispute/portal";

function secret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

describe("phone webhook signature", () => {
  it("accepts a valid Standard Webhooks signature", () => {
    const sec = secret();
    const body = JSON.stringify({
      type: "realtime.call.incoming",
      data: { call_id: "call-1", sip_headers: [{ name: "From", value: "+393331112233" }] },
    });
    const id = "msg_1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signWebhookBody(body, sec, { id, timestamp });
    expect(verifyWebhookSignature(body, { id, timestamp, signature }, sec)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sec = secret();
    const body = '{"type":"realtime.call.incoming","data":{"call_id":"x"}}';
    const id = "msg_2";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signWebhookBody(body, sec, { id, timestamp });
    expect(verifyWebhookSignature(body + " ", { id, timestamp, signature }, sec)).toBe(false);
  });

  it("rejects stale timestamps", () => {
    const sec = secret();
    const body = "{}";
    const id = "msg_3";
    const timestamp = String(Math.floor(Date.now() / 1000) - 600);
    const signature = signWebhookBody(body, sec, { id, timestamp });
    expect(verifyWebhookSignature(body, { id, timestamp, signature }, sec)).toBe(false);
  });

  it("extracts call_id and E.164 from SIP From", () => {
    const event = {
      type: "realtime.call.incoming",
      data: {
        call_id: "00000000-0000-0000-0000-000000000001",
        sip_headers: [{ name: "From", value: '"Buyer" <sip:+14155550100@sip.example;transport=tls>;tag=abc' }],
      },
    };
    expect(extractCallId(event)).toBe("00000000-0000-0000-0000-000000000001");
    expect(extractCallerFrom(event)).toBe("+14155550100");
  });
});

describe("phone dispute tools", () => {
  it("lookup_order denies unauthorized refs and returns evidence for ORD-3001", async () => {
    const erp = freshErp();
    seedPortalDemoOrders(erp);
    const identity = resolvePhoneSession(erp, "+393331112233");
    expect(identity.ok).toBe(true);
    if (!identity.ok) return;

    const bad = await dispatchPhoneTool(erp, identity.session, "lookup_order", { order_ref: "ORD-9999" }, {});
    expect(bad.ok).toBe(false);

    const good = await dispatchPhoneTool(erp, identity.session, "lookup_order", { order_ref: "ORD-3001" }, {});
    expect(good.ok).toBe(true);
    expect(good.order_ref).toBe("ORD-3001");
  });

  it("submit_dispute creates a DSP- with channel=phone in Actions", async () => {
    const erp = freshErp();
    seedPortalDemoOrders(erp);
    const identity = resolvePhoneSession(erp, "+393331112233");
    expect(identity.ok).toBe(true);
    if (!identity.ok) return;

    const msg = buildSubmitMessage({
      order_ref: "ORD-3001",
      category: "shortage",
      claimed_quantity: 1100,
      customer_description: "Received only 1100 packages of Carnaroli",
      language: "en",
    });
    expect(msg).toMatch(/ORD-3001/);

    const callId = `test-${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 8)}`;
    const out = await dispatchPhoneTool(
      erp,
      identity.session,
      "submit_dispute",
      {
        order_ref: "ORD-3001",
        category: "shortage",
        claimed_quantity: 1100,
        customer_description: "Received only 1100 packages of Carnaroli on the phone",
        language: "en",
      },
      { callId, caller: "+393331112233" },
    );

    expect(out.ok).toBe(true);
    expect(out.submitted).toBe(true);
    expect(String(out.dispute_id)).toMatch(/^DSP-/);
    expect(String(out.case_id)).toMatch(/^SO-/);

    const rec = claimToPortalRecord(erp, String(out.dispute_id))!;
    expect(rec.channel).toBe("phone");
    expect(rec.claimed_quantity).toBe(1100);

    const inbox = listEmployeePortalDisputes(erp);
    expect(inbox.some((r) => r.dispute_id === out.dispute_id && r.channel === "phone")).toBe(true);
  });

  it("simulatePhoneDispute end-to-end", async () => {
    const erp = freshErp();
    seedPortalDemoOrders(erp);
    const result = await simulatePhoneDispute(erp, {
      order_ref: "ORD-3001",
      category: "shortage",
      claimed_quantity: 1100,
      customer_description: "Phone sim: only 1100 received",
      language: "en",
      caller: "+14155550100",
    });
    expect(result.ok).toBe(true);
    const submit = result.submit as { dispute_id?: string };
    expect(submit.dispute_id).toMatch(/^DSP-/);
  });
});
