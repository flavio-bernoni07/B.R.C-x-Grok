import { beforeAll, describe, expect, it } from "vitest";
import type { Erp } from "../agent/lib/core/erp";
import { freshErp } from "../agent/lib/core/world";
import { runGolden } from "../agent/lib/demo/golden";
import type { Message } from "../agent/lib/grok/client";
import { answerQuestion } from "../agent/lib/voice/answer";

let erp: Erp;

beforeAll(async () => {
  process.env.BRC_PLAYBOOK = "/tmp/brc-voice-playbook.md";
  erp = freshErp();
  await runGolden(erp, { dispatchDay: false, caseStudy: false });
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
    expect(a.text).toMatch(/^ESS-GOLD-001 is /);
    expect(a.href).toBe("/orders?ref=ESS-GOLD-001");
    expect(grok.seen).toHaveLength(0);
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
