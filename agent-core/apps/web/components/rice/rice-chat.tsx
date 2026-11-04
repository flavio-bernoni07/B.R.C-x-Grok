"use client";

import { AgentChat } from "@/app/_components/agent-chat";
import { Intro } from "./intro";

/** One thread: this week's price story first, then the conversation below it. */
export function RiceChat(props: { readonly sessionId?: string; readonly sessionless?: boolean }) {
  return <AgentChat {...props} intro={(ask) => <Intro onAsk={ask} />} />;
}
