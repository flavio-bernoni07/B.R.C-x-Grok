/**
 * Gets the demo answer ready: "Should I buy Carnaroli?" answered from the records and spoken
 * once in Grok's voice, so the first time it is asked out loud it plays at once.
 * Writes nothing but the voice cache in data/runtime.
 */
import { getReadyErp } from "@agent/lib/db/app";
import { speakText, voiceCapabilities } from "@agent/lib/grok/voice";
import { answerQuestion } from "@agent/lib/voice/answer";

const DEMO_QUESTION = "Should I buy Carnaroli?";

export async function POST() {
  try {
    const answer = await answerQuestion(await getReadyErp(), DEMO_QUESTION);
    const ready = voiceCapabilities().key_configured
      ? await speakText(answer.text.slice(0, 700)).then(() => true, () => false)
      : false;
    return Response.json({ question: DEMO_QUESTION, text: answer.text, href: answer.href, voice_ready: ready });
  } catch {
    return Response.json({ error: "The records didn't answer." }, { status: 502 });
  }
}
