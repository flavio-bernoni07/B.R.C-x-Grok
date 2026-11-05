import { beforeAll, describe, expect, it } from "vitest";
import type { Erp } from "../agent/lib/core/erp";
import { freshErp } from "../agent/lib/core/world";
import { runGolden } from "../agent/lib/demo/golden";
import type { Message } from "../agent/lib/grok/client";
import { answerQuestion } from "../agent/lib/voice/answer";

let erp: Erp;

// Offline: every Grok answer here is recorded.
delete process.env.XAI_API_KEY;
delete process.env.GROK_API_KEY;

beforeAll(async () => {
  process.env.BRC_PLAYBOOK = "/tmp/brc-voice-playbook.md";
  erp = freshErp();
  await runGolden(erp); // the whole demo seed, with the split order
});

/** A recorded Grok: replies in turn, and keeps what it was sent. */
function recorded(...replies: unknown[]) {
  const seen: Message[][] = [];
  const caller = (messages: Message[]) => {
    seen.push(messages);
    return replies[Math.min(seen.length - 1, replies.length - 1)];
  };
  return { caller, seen };
}

describe("voice answers", () => {
  it("answers an order ref from the records, with no Grok call", async () => {
    const grok = recorded({ text: "unused", href: null });
    const a = await answerQuestion(erp, "Where is order ESS-GOLD-001?", { caller: grok.caller });
    // orderAnswer speaks workspace statusText: "<ref>, <retailer>: <status>."
    expect(a.text).toMatch(/^ESS-GOLD-001, Esselunga: /);
    expect(a.href).toBe("/orders?ref=ESS-GOLD-001");
    expect(grok.seen).toHaveLength(0);
  });

  it("answers the demo question however Grok Voice spells it, with no Grok call", async () => {
    const grok = recorded({ text: "unused", href: null });
    const asked = await answerQuestion(erp, "Should I buy Carnaroli?", { caller: grok.caller });
    expect(asked.href).toBe("/stock?view=buying&variety=Carnaroli");
    expect(asked.text).toMatch(/^Carnaroli: the plan says /);
    for (const heard of ["should i buy carnaroli", "Should I by Carnaroli?", "Should I buy car na roli?", "Should I buy Karnaroli?", "Should I buy carnaroly", "Should I buy Carnarolli?"]) {
      expect(await answerQuestion(erp, heard, { caller: grok.caller }), heard).toEqual(asked);
    }
    expect(grok.seen).toHaveLength(0);
  });

  it("answers why an order was split from its record, found by the retailer's name", async () => {
    const split = erp.orders().find((o) => ((o.notes ?? {}) as { backorders?: unknown[] }).backorders?.length);
    expect(split).toBeDefined();
    const retailer = erp.retailers().find((r) => r.gln === split!.buyerGln)!;
    const first = retailer.name.split(" ")[0]!.toLowerCase();
    const grok = recorded({ text: "unused", href: null });
    const a = await answerQuestion(erp, `why ${first}'s order is splitted by grok`, { caller: grok.caller });
    expect(a.text).toMatch(new RegExp(`^${split!.orderRef}: .*split it, .* now and .*`));
    expect(a.href).toBe(`/orders?ref=${encodeURIComponent(split!.orderRef)}`);
    expect(a.text).not.toMatch(/There are \d+ orders/);
    expect(grok.seen).toHaveLength(0);
  });

  it("sends a why about one order to Grok with that order's record", async () => {
    const grok = recorded({ text: "It waits for the warehouse lead to choose.", href: "/orders?ref=ESS-GOLD-001" });
    const a = await answerQuestion(erp, "Why is ESS-GOLD-001 waiting?", { caller: grok.caller });
    expect(a).toEqual({ text: "It waits for the warehouse lead to choose.", href: "/orders?ref=ESS-GOLD-001" });
    expect(grok.seen[0]?.at(-1)?.content).toContain('"order_asked_about":{"ref":"ESS-GOLD-001"');
  });

  it("doesn't answer a why with a count", async () => {
    const grok = recorded({ text: "Grok can't tell from the facts.", href: "/orders" });
    const a = await answerQuestion(erp, "Why are orders late this week?", { caller: grok.caller });
    expect(a.text).toBe("Grok can't tell from the facts.");
    expect(grok.seen).toHaveLength(1);
  });

  it("sends what the rules can't place to Grok with the facts, and opens its page", async () => {
    const waiting = erp.signoffs({ status: "pending" }).length;
    const grok = recorded({ text: `${waiting} cases are waiting for a person.`, href: "/signoff" });
    const a = await answerQuestion(erp, "What needs my attention today?", { caller: grok.caller });
    expect(a).toEqual({ text: `${waiting} cases are waiting for a person.`, href: "/signoff" });
    expect(grok.seen).toHaveLength(1);
    expect(grok.seen[0]?.at(-1)?.content).toContain('"signoffs_waiting"');
  });

  it("sends a number that isn't in the facts back to Grok once", async () => {
    const grok = recorded({ text: "You have 987654 euros overdue.", href: "/disputes" }, { text: "The facts don't say what is overdue.", href: "/disputes" });
    const a = await answerQuestion(erp, "How much is overdue right now?", { caller: grok.caller });
    expect(a.text).toBe("The facts don't say what is overdue.");
    expect(grok.seen).toHaveLength(2);
    expect(grok.seen[1]?.at(-1)?.content).toMatch(/987654 is not in the facts/);
  });

  it("falls back to the plain answer when Grok keeps opening a page we don't have", async () => {
    const grok = recorded({ text: "Opening the CEO dashboard.", href: "/ceo" });
    const a = await answerQuestion(erp, "How are we doing this month?", { caller: grok.caller });
    expect(a).toEqual({ text: "I couldn't find that in the records.", href: null });
    expect(grok.seen).toHaveLength(2);
  });
});
