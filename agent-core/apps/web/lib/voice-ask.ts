/** The open thread listens for this. If nothing handles it, the shell opens /s?ask=. */
export const VOICE_ASK_EVENT = "brc:voice-ask";

/** The thread emits this when a voice question has a grounded answer. */
export const VOICE_REPLY_EVENT = "brc:voice-reply";

/** Set when the ask has to move to /s, so that page still speaks and opens the record. */
export const VOICE_PENDING_KEY = "brc-voice-pending";

export function dispatchVoiceAsk(text: string): boolean {
  const event = new CustomEvent(VOICE_ASK_EVENT, { cancelable: true, detail: { text } });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
