/**
 * Spoken question → one grounded sentence and the panel to open.
 * Does not write a chat message, buy paddy, confirm an order, or send anything.
 */
import { getReadyErp } from "@agent/lib/db/app";
import { answerQuestion } from "@agent/lib/voice/answer";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ error: "Send JSON { text }." }, { status: 400 });
  if (text.length > 500) return Response.json({ error: "That question is too long." }, { status: 413 });

  try {
    const answer = await answerQuestion(await getReadyErp(), text);
    return Response.json({ text: answer.text.slice(0, 700), href: answer.href });
  } catch {
    return Response.json({ error: "The records didn't answer." }, { status: 502 });
  }
}
