"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Simple full-screen overlay dialog used by Sign-off case and mail compose. */
export function DeskModal({
  title,
  aside,
  onClose,
  children,
  wide = false,
}: {
  readonly title: ReactNode;
  readonly aside?: ReactNode;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgb(32_49_25/0.35)] p-3 sm:items-center sm:p-6">
      <button type="button" aria-label="Close" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative z-10 flex max-h-[min(880px,92vh)] w-full flex-col overflow-hidden rounded-[16px] bg-hh-seasalt shadow-[0_24px_60px_-24px_rgb(32_49_25/0.55)]",
          wide ? "max-w-[760px]" : "max-w-[560px]",
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-hairline border-b px-4 py-3.5">
          <div className="min-w-0">
            <div className="font-bold text-[16px] tracking-[-0.02em]">{title}</div>
            {aside ? <div className="mt-0.5 text-[12.5px] text-ink-68">{aside}</div> : null}
          </div>
          <button type="button" onClick={onClose} className="shrink-0 text-[13px] text-ink-68 hover:text-ink">
            Close
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  );
}
