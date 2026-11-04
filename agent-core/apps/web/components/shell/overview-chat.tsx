"use client";

import { useSearchParams } from "next/navigation";
import { AgentChat } from "@/app/_components/agent-chat";
import { OverviewIntro } from "@/components/core/overview";

/** Overview: one thread. The state of the back office is its first message; the conversation continues below. */
export function OverviewChat(props: { readonly sessionId?: string; readonly sessionless?: boolean }) {
  const ask = useSearchParams().get("ask") ?? undefined;
  return <AgentChat {...props} initialPrompt={ask} intro={(send) => <OverviewIntro onAsk={send} />} />;
}

/** Link target for "Ask Grok" buttons on the other pages. */
export const askHref = (question: string) => `/s?ask=${encodeURIComponent(question)}`;
