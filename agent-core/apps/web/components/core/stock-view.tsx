"use client";

import type { StockStatus } from "@agent/lib/core/overview";
import { useEffect, useState } from "react";
import { PageHeader, Panel } from "@/components/kit";
import { Page } from "@/components/shell/app-shell";
import { askHref } from "@/components/shell/overview-chat";
import { AtpTable, BatchTable } from "./stock";

/** Stock we can promise: the number the Order row checks against, built only from production events. */
export function StockView() {
  const [stock, setStock] = useState<StockStatus>();
  useEffect(() => {
    fetch("/api/stock")
      .then((r) => r.json())
      .then(setStock)
      .catch(() => {});
  }, []);
  return (
    <Page>
      <PageHeader title="Stock">
        <a href={askHref("Which products are short or on hold, and which orders does that affect?")} className="rounded-full bg-hh-dark px-4 py-1.5 font-bold text-[13px] text-hh-window">
          Ask Grok
        </a>
      </PageHeader>
      {stock ? (
        <>
          <Panel title="Can promise, per product">
            <AtpTable stock={stock} />
          </Panel>
          <Panel title="Batches" aside="every unit comes from a production event">
            <BatchTable stock={stock} />
          </Panel>
        </>
      ) : (
        <div className="h-64 animate-pulse rounded-[14px] bg-hh-honeydew" />
      )}
    </Page>
  );
}
