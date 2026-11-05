/**
 * Spoken question → one grounded sentence and the panel to open.
 * Does not write a chat message, buy paddy, confirm an order, or send anything.
 * Starts Grok's voice for the answer at once, and logs what was heard to
 * data/runtime/voice-log.jsonl, so a misheard question can be read back after a run.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { getReadyErp } from "@agent/lib/db/app";
import { speakText } from "@agent/lib/grok/voice";
import { dataPath } from "@agent/lib/paths";
import { answerQuestion } from "@agent/lib/voice/answer";

function logTurn(heard: string, answer: { text: string; href: string | null } | null) {
  try {
    mkdirSync(dataPath("runtime"), { recursive: true });
    appendFileSync(dataPath("runtime", "voice-log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), heard, answer })}\n`);
  } catch {
    /* the answer matters more than the log */
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ error: "Send JSON { text }." }, { status: 400 });
  if (text.length > 500) return Response.json({ error: "That question is too long." }, { status: 413 });

  try {
    const answer = await answerQuestion(await getReadyErp(), text);
    const said = answer.text.slice(0, 700);
    void speakText(said).catch(() => undefined);
    logTurn(text, { text: said, href: answer.href });
    return Response.json({ text: said, href: answer.href });
  } catch {
    logTurn(text, null);
    return Response.json({ error: "The records didn't answer." }, { status: 502 });
  }
}
