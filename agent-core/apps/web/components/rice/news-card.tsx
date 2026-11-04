"use client";

import type { NewsResult } from "@agent/lib/rice";
import { NewspaperIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";

/** Chat card for the rice_market_news tool: Grok's search summary with its sources. */
export function NewsCard({ news }: { readonly news: NewsResult }) {
  return (
    <section className="w-full space-y-2 rounded-xl border bg-card p-4">
      <header className="flex items-center gap-2 text-sm">
        <NewspaperIcon className="size-4 text-muted-foreground" />
        <span className="font-medium">News search</span>
        <span className="truncate text-muted-foreground">“{news.query}”</span>
      </header>
      <div className="text-sm">
        <MessageResponse>{news.summary}</MessageResponse>
      </div>
      {news.sources.length > 0 ? (
        <ol className="list-decimal space-y-0.5 pl-5 text-muted-foreground text-xs">
          {news.sources.map((s) => (
            <li key={s.url} className="truncate">
              <a className="underline underline-offset-2" href={s.url} target="_blank" rel="noreferrer">
                {s.title || new URL(s.url).hostname}
              </a>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
