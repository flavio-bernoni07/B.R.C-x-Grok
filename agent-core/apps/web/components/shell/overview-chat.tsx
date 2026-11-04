"use client";

import { useSearchParams } from "next/navigation";
import { AgentChat } from "@/app/_components/agent-chat";
import { OverviewIntro } from "@/components/core/overview";

/** Home: one thread. The title, example questions and the state of things are its first message; the conversation continues below. */
export function OverviewChat(props: { readonly sessionId?: string; readonly sessionless?: boolean }) {
  const ask = useSearchParams().get("ask") ?? undefined;
  return <AgentChat {...props} heroComposer initialPrompt={ask} intro={(send, hero) => <OverviewIntro onAsk={send} composer={hero.composer} />} />;
}

/** Link target for "Ask Grok" buttons on the other pages. */
export const askHref = (question: string) => `/s?ask=${encodeURIComponent(question)}`;
