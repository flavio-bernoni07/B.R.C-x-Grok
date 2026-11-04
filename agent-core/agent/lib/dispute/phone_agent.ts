/**
 * Inbound Grok Voice SIP call handler.
 *
 * Joins wss://api.x.ai/v1/realtime?call_id=…, exposes lookup_order + submit_dispute tools,
 * and persists disputes through handleCustomerMessage (channel=phone). Never invents a DSP id.
 */
import WebSocket from "ws";
import type { Erp } from "../core/erp";
import { apiKey } from "../grok/client";
import { resolvePhoneSession } from "./phone_identity";
import {
  handleCustomerMessage,
  lookupAuthorizedOrder,
  type PortalTurnResult,
  type SimulatedRetailerSession,
} from "./portal";

export const PHONE_VOICE = process.env.XAI_SPEECH_VOICE?.trim() || "eve";

export const PHONE_INSTRUCTIONS = `
You are Riso Scotti's retailer support agent on a live phone call (Grok Voice).
Language: answer in the caller's language (Italian or English).
Collect: order reference (e.g. ORD-3001), what went wrong (shortage / pricing / damage / late), and claimed quantity or amount.
You may call lookup_order with the order reference to read Scotti records.
When you have enough detail, call submit_dispute with structured fields.
Never promise a refund, credit note, invoice change, or admit liability.
Only tell the caller a DSP- dispute reference after submit_dispute returns success with dispute_id.
If submit_dispute fails, say honestly that registration failed and no reference was assigned.
Keep turns short and natural for phone.
`.trim();

export const PHONE_TOOLS = [
  {
    type: "function",
    name: "lookup_order",
    description: "Look up an authorized retailer's order and Scotti dispatch/invoice evidence. Read-only.",
    parameters: {
      type: "object",
      properties: {
        order_ref: { type: "string", description: "Order reference such as ORD-3001" },
      },
      required: ["order_ref"],
    },
  },
  {
    type: "function",
    name: "submit_dispute",
    description:
      "Register a customer dispute in the Scotti Mini ERP / Actions desk. Returns dispute_id only on real success. Never invent ids.",
    parameters: {
      type: "object",
      properties: {
        order_ref: { type: "string" },
        category: {
          type: "string",
          enum: ["shortage", "pricing", "damage", "late_delivery", "other"],
        },
        claimed_quantity: { type: "number", description: "Quantity the customer claims (not verified)" },
        claimed_amount: { type: "number", description: "Amount the customer claims (not verified)" },
        customer_description: { type: "string" },
        language: { type: "string", enum: ["en", "it"] },
      },
      required: ["order_ref", "category", "customer_description"],
    },
  },
] as const;

export type PhoneToolArgs = {
  order_ref?: string;
  category?: string;
  claimed_quantity?: number;
  claimed_amount?: number;
  customer_description?: string;
  language?: string;
};

export function buildSubmitMessage(args: PhoneToolArgs): string {
  const parts: string[] = [];
  const lang = args.language === "it" ? "it" : "en";
  if (args.order_ref) parts.push(lang === "it" ? `Ordine ${args.order_ref}` : `Order ${args.order_ref}`);
  if (args.category) parts.push(args.category);
  if (args.claimed_quantity != null) {
    parts.push(
      lang === "it"
        ? `ricevuti solo ${args.claimed_quantity}`
        : `received only ${args.claimed_quantity}`,
    );
  }
  if (args.claimed_amount != null) parts.push(`€${args.claimed_amount}`);
  if (args.customer_description) parts.push(args.customer_description);
  return parts.join(". ").trim();
}

export async function runPhoneLookup(
  erp: Erp,
  session: SimulatedRetailerSession,
  args: PhoneToolArgs,
): Promise<Record<string, unknown>> {
  if (!args.order_ref?.trim()) return { ok: false, reason: "order_ref_required" };
  return lookupAuthorizedOrder(erp, session, args.order_ref);
}

export async function runPhoneSubmit(
  erp: Erp,
  session: SimulatedRetailerSession,
  args: PhoneToolArgs,
  opts: { conversationId?: string | null; callId?: string | null; caller?: string | null } = {},
): Promise<Record<string, unknown>> {
  const message = buildSubmitMessage(args);
  if (!message) return { ok: false, reason: "empty_dispute", submitted: false };

  const result: PortalTurnResult = await handleCustomerMessage(erp, session, {
    message,
    conversationId: opts.conversationId,
    idempotencyKey: opts.callId ? `phone:${opts.callId}` : null,
    channel: "phone",
  });

  // Stamp call metadata on the conversation transcript when we have a call id.
  if (result.conversation_id && (opts.callId || opts.caller)) {
    const docs = erp.documents({ kind: "customer conversation", ref: result.conversation_id });
    const doc = docs[0];
    if (doc?.body) {
      try {
        const state = JSON.parse(doc.body) as {
          messages: { role: string; content: string; at: string; meta?: Record<string, unknown> | null }[];
          updated_at: string;
          [k: string]: unknown;
        };
        state.messages.push({
          role: "system",
          content: `Phone call ${opts.callId ?? "—"} from ${opts.caller ?? "unknown"}`,
          at: new Date().toISOString(),
          meta: { channel: "phone", call_id: opts.callId, caller: opts.caller },
        });
        state.updated_at = new Date().toISOString();
        erp.updateDocument(doc.docId, { body: JSON.stringify(state) });
      } catch {
        /* ignore transcript stamp failures */
      }
    }
  }

  return {
    ok: result.submitted,
    submitted: result.submitted,
    dispute_id: result.dispute_id,
    case_id: result.case_id,
    status: result.status,
    conversation_id: result.conversation_id,
    needs_follow_up: result.needs_follow_up,
    missing_fields: result.missing_fields,
    reply: result.reply,
    error: result.error ?? null,
  };
}

export async function dispatchPhoneTool(
  erp: Erp,
  session: SimulatedRetailerSession,
  name: string,
  args: PhoneToolArgs,
  ctx: { conversationId?: string | null; callId?: string | null; caller?: string | null },
): Promise<Record<string, unknown>> {
  if (name === "lookup_order") return runPhoneLookup(erp, session, args);
  if (name === "submit_dispute") return runPhoneSubmit(erp, session, args, ctx);
  return { ok: false, reason: "unknown_tool", name };
}

function realtimeUrl(callId: string): string {
  const base = (process.env.XAI_REALTIME_URL?.trim() || "wss://api.x.ai/v1/realtime").replace(/\/$/, "");
  return `${base}?call_id=${encodeURIComponent(callId)}`;
}

async function hangupCall(callId: string): Promise<void> {
  const key = apiKey();
  if (!key) return;
  try {
    await fetch(`https://api.x.ai/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Join an inbound SIP call and drive the dispute tools until the socket closes.
 * Safe to fire-and-forget from the webhook (do not invent DSP ids on failure).
 */
export async function handleIncomingPhoneCall(
  erp: Erp,
  opts: { callId: string; caller: string | null },
): Promise<{ ok: boolean; reason?: string; dispute_id?: string | null }> {
  const key = apiKey();
  if (!key) return { ok: false, reason: "missing_api_key" };

  const identity = resolvePhoneSession(erp, opts.caller);
  if (!identity.ok) return { ok: false, reason: identity.reason };

  const session = identity.session;
  let conversationId: string | null = null;
  let lastDisputeId: string | null = null;

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; reason?: string; dispute_id?: string | null }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(realtimeUrl(opts.callId), {
        headers: { Authorization: `Bearer ${key}` },
      });
    } catch (err) {
      finish({ ok: false, reason: (err as Error).message });
      return;
    }

    const send = (payload: unknown) => {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
      } catch {
        /* closed */
      }
    };

    ws.on("open", () => {
      send({
        type: "session.update",
        session: {
          voice: PHONE_VOICE,
          instructions: PHONE_INSTRUCTIONS,
          turn_detection: { type: "server_vad" },
          tools: PHONE_TOOLS,
        },
      });
      send({ type: "response.create" });
    });

    ws.on("message", (data) => {
      void (async () => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = String(event.type ?? "");

        if (type === "response.function_call_arguments.done") {
          const name = String(event.name ?? "");
          const toolCallId = String(event.call_id ?? "");
          let args: PhoneToolArgs = {};
          try {
            args = JSON.parse(String(event.arguments ?? "{}")) as PhoneToolArgs;
          } catch {
            args = {};
          }
          const output = await dispatchPhoneTool(erp, session, name, args, {
            conversationId,
            callId: opts.callId,
            caller: opts.caller,
          });
          if (typeof output.conversation_id === "string") conversationId = output.conversation_id;
          if (typeof output.dispute_id === "string") lastDisputeId = output.dispute_id;

          send({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: toolCallId,
              output: JSON.stringify(output),
            },
          });
          send({ type: "response.create" });

          if (name === "submit_dispute" && output.ok && output.dispute_id) {
            setTimeout(() => {
              void hangupCall(opts.callId);
              try {
                ws.close();
              } catch {
                /* ignore */
              }
            }, 12_000);
          }
        }

        if (type === "error") {
          console.error("[phone_agent]", event);
        }
      })();
    });

    ws.on("error", () => finish({ ok: false, reason: "websocket_error", dispute_id: lastDisputeId }));
    ws.on("close", () => finish({ ok: true, dispute_id: lastDisputeId }));

    setTimeout(
      () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        finish({
          ok: Boolean(lastDisputeId),
          reason: lastDisputeId ? undefined : "timeout",
          dispute_id: lastDisputeId,
        });
      },
      15 * 60 * 1000,
    );
  });
}

/**
 * Offline / CI path: run the same tools without joining a live SIP socket.
 * Useful for demos when the free number / tunnel is not up yet.
 */
export async function simulatePhoneDispute(
  erp: Erp,
  opts: {
    caller?: string | null;
    order_ref: string;
    category: string;
    claimed_quantity?: number | null;
    claimed_amount?: number | null;
    customer_description: string;
    language?: "en" | "it";
  },
): Promise<Record<string, unknown>> {
  const identity = resolvePhoneSession(erp, opts.caller ?? null);
  if (!identity.ok) return { ok: false, reason: identity.reason };

  const lookup = await runPhoneLookup(erp, identity.session, { order_ref: opts.order_ref });
  if (!lookup.ok) return { ok: false, stage: "lookup", ...lookup };

  const submit = await runPhoneSubmit(
    erp,
    identity.session,
    {
      order_ref: opts.order_ref,
      category: opts.category,
      claimed_quantity: opts.claimed_quantity ?? undefined,
      claimed_amount: opts.claimed_amount ?? undefined,
      customer_description: opts.customer_description,
      language: opts.language,
    },
    { callId: `sim-${Date.now()}`, caller: identity.caller },
  );
  return { ok: Boolean(submit.submitted), lookup, submit };
}
