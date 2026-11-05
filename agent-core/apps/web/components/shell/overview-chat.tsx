"use client";

import { useSearchParams } from "next/navigation";
import { AgentChat } from "@/app/_components/agent-chat";
import { HomeIntro, useHomeSuggestions } from "@/components/home/home-intro";

/** Home: one thread. The desk is its first message; the chips ask about what the desk shows; answers continue below. */
export function OverviewChat(props: { readonly sessionId?: string; readonly sessionless?: boolean }) {
  const ask = useSearchParams().get("ask") ?? undefined;
  const suggestions = useHomeSuggestions();
  return <AgentChat {...props} initialPrompt={ask} intro={() => <HomeIntro />} suggestions={suggestions} />;
}

/** Link target for "Ask Grok" buttons on the other pages. */
export const askHref = (question: string) => `/s?ask=${encodeURIComponent(question)}`;
