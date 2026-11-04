import type { LogisticsPlan } from "@agent/lib/logistics/plan";
import type { PaddyPlan } from "@agent/lib/purchasing/paddy";
import { createElement, type ReactNode } from "react";
import { LogisticsPlanCard } from "./logistics";
import { PaddyToBuy } from "./paddy";

export { LogisticsPlanCard, LogisticsPlanPanel } from "./logistics";
export { OperationsView } from "./operations-view";
export { PaddyToBuy } from "./paddy";

/** Chat cards for the Purchasing and Logistics tools (tool name → component). */
export const cards: Record<string, (props: { output: unknown }) => ReactNode> = {
  purchasing_paddy_to_buy: ({ output }) => createElement(PaddyToBuy, { plan: output as PaddyPlan, interactive: true }),
  logistics_plan: ({ output }) => createElement(LogisticsPlanCard, { plan: output as LogisticsPlan }),
};
