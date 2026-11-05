/** The open thread listens for this. If nothing handles it, the shell opens /s?ask=. */
export const VOICE_ASK_EVENT = "brc:voice-ask";

export function dispatchVoiceAsk(text: string): boolean {
  const event = new CustomEvent(VOICE_ASK_EVENT, { cancelable: true, detail: { text } });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
