"use client";

/**
 * Which tools the chat draws as a card, and with which component. Every row's components export a
 * `cards` map (tool name → component); they are merged here, so a tool's result in chat looks the
 * same as on the row's page.
 */
import type { Signoff } from "@agent/lib/core/erp";
import type { EveToolPart } from "eve/react";
import type { ReactNode } from "react";
import { AuditCard } from "@/components/core/audit";
import { ImpactCard, OverviewCard } from "@/components/core/overview";
import { SignoffCard, SignoffQueue } from "@/components/core/signoff";
import { StockCard } from "@/components/core/stock";
import { Panel } from "@/components/kit";
import { cards as disputeCards } from "@/components/dispute";
import { cards as operationsCards } from "@/components/operations";
import { cards as orderCards } from "@/components/order";
import { cards as riceCards } from "@/components/rice";
import { cards as shippingCards } from "@/components/shipping";

type Card = (props: { output: unknown }) => ReactNode;

const coreCards: Record<string, Card> = {
  overview_snapshot: OverviewCard,
  impact_summary: ImpactCard,
  stock_status: StockCard,
  audit_trail: AuditCard,
  signoff_queue: ({ output }) => (
    <Panel title="Waiting for a person">
      <SignoffQueue cases={(output as { pending: Signoff[] }).pending} />
    </Panel>
  ),
  signoff_get: ({ output }) => <SignoffCard signoff={(output as { case: Signoff }).case} />,
};

export const CARDS: Record<string, Card> = { ...coreCards, ...orderCards, ...shippingCards, ...disputeCards, ...riceCards, ...operationsCards };

export function isCardTool(part: EveToolPart): boolean {
  return part.name in CARDS && part.state === "completed" && part.output != null;
}

export function ToolCard({ part }: { readonly part: EveToolPart }) {
  const Card = CARDS[part.name];
  return Card ? <Card output={part.output} /> : null;
}
