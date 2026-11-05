"use client";

import { ClientError, type MessagePart } from "eve/client";
import {
  activeTurn,
  activity,
  failure,
  interaction,
  interactions,
  turns,
  type Activity,
} from "eve/events";
import { useEveAgent } from "eve/react";
import { AlertCircleIcon, BrainIcon, PlusIcon, SquareIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationTopFade,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputButton,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { PageHeader } from "@/components/kit";
import { ChipRail } from "@/components/kit/chip-rail";
import { Button } from "@/components/ui/button";
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { cn } from "@/lib/utils";
import { VoiceButton } from "@/components/shell/voice-hold";
import { AgentMessage } from "./agent-message";
import { WEB_CHAT_AGENT } from "@/app/eve-agent";

const DEFAULT_AGENT_NAME = "Risolve";

/** Sends a message from inside the thread, e.g. a suggestion under the intro. */
export type AskAgent = (text: string, context?: Record<string, string | number | boolean>) => void;
const AGENT_NAME = WEB_CHAT_AGENT ?? DEFAULT_AGENT_NAME;

export function AgentChat({
  sessionId,
  sessionless = false,
  intro,
  initialPrompt,
  suggestions,
}: {
  readonly sessionId?: string;
  readonly sessionless?: boolean;
  /** First message of the thread, shown before anything is asked; the conversation continues below it. */
  readonly intro?: (ask: AskAgent) => ReactNode;
  /** Sent once when the chat opens, e.g. an "Ask Grok" link from another page. */
  readonly initialPrompt?: string;
  /** Example questions on one line just above the input, until the first message. */
  readonly suggestions?: string[];
}) {
  const [cancellationError, setCancellationError] = useState<string>();
  const [hasInputText, setHasInputText] = useState(false);
  const hasSubmittedMessage = useRef(false);
  // onSessionChange fires on every stream cursor advance, not only when the session id
  // appears. Calling replaceState each time hits Chromium's 100/10s history rate limit and
  // aborts the turn mid-reply. Write the URL once per new session id.
  const routedSessionId = useRef<string | undefined>(sessionId);
  const replaceSessionRoute = (nextSessionId: string) => {
    if (sessionId !== undefined) return;
    if (routedSessionId.current === nextSessionId) return;
    const nextPath = `/s/${encodeURIComponent(nextSessionId)}`;
    if (window.location.pathname === nextPath) {
      routedSessionId.current = nextSessionId;
      return;
    }
    // Framework routers (Next.js, TanStack Router) patch window.history; navigating
    // through them would remount this route and detach the active stream.
    History.prototype.replaceState.call(
      window.history,
      window.history.state,
      "",
      nextPath,
    );
    routedSessionId.current = nextSessionId;
  };
  const agent = useEveAgent({
    agent: WEB_CHAT_AGENT,
    prewarm: hasInputText,
    initialSession:
      sessionId === undefined
        ? undefined
        : {
            sessionId,
            streamIndex: 0,
          },
    resume: sessionId !== undefined,
    onSessionChange(session) {
      if (hasSubmittedMessage.current && session !== undefined) {
        replaceSessionRoute(session.sessionId);
      }
    },
  });

  const isBusy = agent.status === "busy";
  // A turn waiting on a person is open while the store is idle; it still takes steering and Stop.
  const turnOpen = activeTurn(agent.view) !== undefined;
  const isResuming = agent.status === "resuming";
  const isEmpty = agent.messages.length === 0;
  const lastMessage = agent.messages.at(-1);
  const lastUserId = [...agent.messages].reverse().find((m) => m.role === "user")?.id;
  const isPendingAssistantShell =
    lastMessage?.role === "assistant" && lastMessage.parts.length === 0;
  const now = activity(agent.view);
  // Show what the agent is doing until its message has something to show, unless it waits on you.
  const showPendingThinking =
    isBusy &&
    now.kind !== "waiting-on-interaction" &&
    (lastMessage?.role !== "assistant" || isPendingAssistantShell);
  const failed =
    isBusy || isResuming ? undefined : failure(agent.view, turns(agent.view).at(-1)?.turnId);
  const turnFailure =
    failed?.code === "MODEL_CALL_FAILED"
      ? "The model is temporarily unavailable. Please try again."
      : failed?.message;
  const errorMessage = cancellationError ?? agent.error?.message ?? turnFailure;
  const hasConversationContent =
    intro !== undefined || sessionless || !isEmpty || errorMessage !== undefined;
  const showConversationLayout = isResuming || hasConversationContent;
  const activeSessionId = sessionId ?? agent.session?.sessionId;
  // A session that ended outside eve never settles its requests, so they stay open, yet it
  // accepts no answer. Once the server says so, stop offering them.
  const sessionEnded =
    agent.error instanceof ClientError && agent.error.code === "session_not_active";
  // Answers are accepted while work runs; the server's settlement closes each request.
  const canRespond = (interactionId: string) =>
    !isResuming && !sessionEnded && interaction(agent.view, interactionId)?.status === "open";
  // A tool call can ask several questions at once, and its message part holds only the latest.
  const questionsFor = (callId: string) =>
    interactions(agent.view).filter(
      (input) => input.request.kind === "question" && input.call?.callId === callId,
    );

  const requestCancellation = () => {
    setCancellationError(undefined);
    void agent.cancel().catch((error: unknown) => {
      setCancellationError(toErrorMessage(error));
    });
  };

  const sendText = async (text: string, clientContext?: Record<string, string | number | boolean>) => {
    if (isResuming) return;
    setCancellationError(undefined);
    hasSubmittedMessage.current = true;
    if (agent.session !== undefined) replaceSessionRoute(agent.session.sessionId);
    await agent.send(text, {
      ...(turnOpen ? { turnPolicy: "steer" as const } : {}),
      ...(clientContext ? { clientContext } : {}),
    });
  };

  const sentInitial = useRef(false);
  useEffect(() => {
    if (!initialPrompt || sentInitial.current || isResuming) return;
    sentInitial.current = true;
    void sendText(initialPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send once
  }, [initialPrompt, isResuming]);

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if ((text.length === 0 && message.files.length === 0) || isResuming) return;

    setHasInputText(false);
    setCancellationError(undefined);
    hasSubmittedMessage.current = true;
    if (agent.session !== undefined) replaceSessionRoute(agent.session.sessionId);
    const options = turnOpen ? { turnPolicy: "steer" as const } : undefined;

    if (message.files.length === 0) {
      await agent.send(text, options);
      return;
    }

    const parts: MessagePart[] = [];
    if (text.length > 0) {
      parts.push({ text, type: "text" });
    }
    for (const file of message.files) {
      parts.push({
        data: file.url,
        filename: file.filename,
        mediaType: file.mediaType,
        type: "file",
      });
    }

    await agent.send(parts, options);
  };

  const composer = (
    // The same white one-line box as the Ask Grok input under an order. The app has no dark theme, so
    // the input group's dark-mode tint (on when the Mac is in dark mode) is turned off too.
    <PromptInput
      className="rounded-[18px] border-0 bg-white dark:bg-white shadow-[inset_0_0_0_1px_rgb(32_49_25/0.1),0_10px_30px_-20px_rgb(32_49_25/0.35)] backdrop-blur-none"
      onSubmit={handleSubmit}
    >
      <PromptInputTextarea
        className="min-h-[52px] py-3.5 pr-12 pl-4 text-[15px] md:text-[15px] placeholder:text-ink-68"
        disabled={isResuming}
        onChange={(event) => setHasInputText(event.currentTarget.value.trim().length > 0)}
        placeholder="Ask Grok about an order, a truck, stock or a claim…"
      />
      <ComposerAction
        hasInputText={hasInputText}
        canCancel={turnOpen}
        isResuming={isResuming}
        onCancel={requestCancellation}
      />
    </PromptInput>
  );

  // Home, before anyone has asked: the chips and the box sit under the desk, in the column,
  // so they cannot cover the cards. A started thread goes back to the overlay.
  const homeDock = showConversationLayout && !!intro && isEmpty;

  return (
    <main
      className={cn(
        "relative flex h-full flex-col overflow-hidden bg-hh-seasalt text-ink",
      )}
    >
      {homeDock ? (
        <div className="shrink-0 px-9 pt-8">
          <div className="mx-auto w-full max-w-[1280px]">
            <PageHeader title="Home" />
          </div>
        </div>
      ) : showConversationLayout && (!intro || !isEmpty) ? (
        <ChatHeader canStartNewChat={activeSessionId !== undefined} />
      ) : null}

      {showConversationLayout ? (
        <Conversation
          className="min-h-0 flex-1"
          // Home opens at the top (the desk); a reopened chat restores its own scroll.
          initial={(intro && isEmpty) || sessionId !== undefined ? false : undefined}
          resize={activeSessionId === undefined ? "smooth" : "instant"}
          scrollRestorationKey={
            // Only a chat reopened from its link restores its scroll; a chat started here keeps the
            // new question at the top (AnchorQuestion) instead of jumping to the end.
            isEmpty || sessionId === undefined ? undefined : `eve:web-chat-scroll:${sessionId}`
          }
        >
          {!intro || !isEmpty ? <ConversationTopFade className="top-14 from-hh-seasalt" /> : null}
          <ConversationContent className={cn("mx-auto w-full max-w-[980px] gap-6 px-4 sm:px-6", homeDock ? "min-h-full py-6" : "pt-12 pb-60")}>
            {intro ? (
              <Message className={cn("max-w-full", homeDock && "my-auto")} from="assistant">
                <MessageContent className="w-full">
                  {intro((text, context) => void sendText(text, context))}
                </MessageContent>
              </Message>
            ) : null}
            {agent.messages.map((message) =>
              showPendingThinking &&
              isPendingAssistantShell &&
              message.id === lastMessage.id ? null : (
                <div key={message.id} data-msg-id={message.id} className="hh-rise">
                  <AgentMessage
                    canRespond={canRespond}
                    message={message}
                    questionsFor={questionsFor}
                    view={agent.view}
                    onAnswers={async (answers) => {
                      setCancellationError(undefined);
                      await agent.respond(answers).catch((cause: unknown) => {
                        setCancellationError(
                          cause instanceof Error ? cause.message : "Unable to submit the answer.",
                        );
                      });
                    }}
                  />
                </div>
              ),
            )}
            {showPendingThinking ? (
              <div className="hh-rise">
                <PendingActivity activity={now} />
              </div>
            ) : null}
            {errorMessage ? <ErrorMessage message={errorMessage} /> : null}
            {hasSubmittedMessage.current ? <div aria-hidden className="h-[55vh] shrink-0" /> : null}
          </ConversationContent>
          <AnchorQuestion messageId={lastUserId} enabled={hasSubmittedMessage.current} />
          {isEmpty ? null : <ConversationScrollButton />}
        </Conversation>
      ) : null}

      <div
        className={cn(
          "mx-auto w-full",
          homeDock
            ? "max-w-[980px] shrink-0 px-4 pt-3 pb-6 sm:px-6"
            : showConversationLayout
              ? "absolute bottom-0 left-1/2 z-20 max-w-[980px] -translate-x-1/2 bg-gradient-to-t from-hh-seasalt from-70% to-transparent px-4 pt-14 pb-5 sm:px-6"
              : "flex max-w-xl flex-1 flex-col items-center justify-center gap-8 px-4 pb-[10vh]",
        )}
      >
        {showConversationLayout ? null : (
          <div className="flex flex-col items-center gap-3 text-center">
            <h1 className="font-medium text-5xl tracking-tighter">{AGENT_NAME}</h1>
          </div>
        )}
        {suggestions?.length && isEmpty ? <ChipRail items={suggestions} onPick={(t) => void sendText(t)} className="mb-3 w-full" /> : null}
        <div className="w-full">{composer}</div>
      </div>
    </main>
  );
}

/**
 * After a question is sent, keep it at the top of the thread and let the answer grow below it,
 * instead of following the end of the thread.
 */
function AnchorQuestion({ messageId, enabled }: { readonly messageId?: string; readonly enabled: boolean }) {
  const { scrollRef, stopScroll } = useStickToBottomContext();
  useEffect(() => {
    if (!enabled || !messageId) return;
    const box = scrollRef.current;
    if (!box) return;
    let held = true;
    const topOf = () => {
      const el = box.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(messageId)}"]`);
      return el ? Math.max(el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 72, 0) : null;
    };
    const first = requestAnimationFrame(() => {
      const top = topOf();
      if (top == null) return;
      stopScroll();
      box.scrollTo({ top, behavior: "smooth" });
    });
    // While the answer grows, keep the question where it is, until the person scrolls.
    const hold = () => {
      if (!held) return;
      const top = topOf();
      if (top == null) return;
      stopScroll();
      if (Math.abs(box.scrollTop - top) > 4) box.scrollTop = top;
    };
    const release = () => {
      held = false;
    };
    const content = box.firstElementChild;
    const ro = new ResizeObserver(() => requestAnimationFrame(hold));
    if (content) ro.observe(content);
    box.addEventListener("wheel", release, { passive: true });
    box.addEventListener("touchmove", release, { passive: true });
    box.addEventListener("keydown", release);
    const stop = setTimeout(release, 90_000);
    return () => {
      cancelAnimationFrame(first);
      ro.disconnect();
      clearTimeout(stop);
      box.removeEventListener("wheel", release);
      box.removeEventListener("touchmove", release);
      box.removeEventListener("keydown", release);
    };
  }, [messageId, enabled, scrollRef, stopScroll]);
  return null;
}

function ComposerAction({
  hasInputText,
  canCancel,
  isResuming,
  onCancel,
}: {
  readonly hasInputText: boolean;
  readonly canCancel: boolean;
  readonly isResuming: boolean;
  readonly onCancel: () => void;
}) {
  const attachments = usePromptInputAttachments();
  const canSubmit = hasInputText || attachments.files.length > 0;

  if (!canCancel || canSubmit) {
    return <PromptInputSubmit disabled={isResuming} />;
  }

  return (
    <PromptInputButton
      aria-label="Stop"
      className="absolute right-2.5 bottom-2.5"
      onClick={onCancel}
      variant="outline"
    >
      <SquareIcon className="size-3 fill-current" />
    </PromptInputButton>
  );
}

function ErrorMessage({ message }: { readonly message: string }) {
  return (
    <Message className="max-w-full" from="assistant">
      <MessageContent>
        <div
          className="flex w-full items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm"
          role="alert"
        >
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium">Request failed</p>
            <p className="mt-0.5 text-muted-foreground">{message}</p>
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}

function ChatHeader({ canStartNewChat }: { readonly canStartNewChat: boolean }) {
  return (
    <header className="pointer-events-none absolute top-0 right-0 left-0 z-20 h-14">
      <div className="relative mx-auto flex h-full w-full max-w-[980px] items-center justify-between bg-hh-seasalt px-6">
        <span />
        <div className="pointer-events-auto flex items-center gap-2">
          {canStartNewChat ? (
            <Button
              aria-label="Start a new chat"
              onClick={() => window.location.assign("/s")}
              size="sm"
              type="button"
              variant="ghost"
            >
              <PlusIcon className="size-4" />
              <span className="hidden font-normal text-sm sm:inline">New chat</span>
            </Button>
          ) : null}
          <VoiceButton />
        </div>
      </div>
    </header>
  );
}

function PendingActivity({ activity }: { readonly activity: Activity }) {
  return (
    <Message aria-live="polite" from="assistant">
      <MessageContent>
        <Trace>
          <TraceLine status="running">
            <TraceIcon>
              <BrainIcon />
            </TraceIcon>
            <TraceTitle>{activityLabel(activity)}</TraceTitle>
          </TraceLine>
        </Trace>
      </MessageContent>
    </Message>
  );
}

function activityLabel(activity: Activity): string {
  switch (activity.kind) {
    case "calling":
      return activity.names.join(", ");
    case "waiting-on-tasks":
      return `Waiting on ${activity.tasks.map((task) => task.name).join(", ")}`;
    case "compacting":
      return "Compacting the conversation";
    default:
      return "Thinking";
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to cancel the response.";
}
