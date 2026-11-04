import type { ReactNode } from "react";
import { ClaimCard, ClaimReadCard } from "./claim-card";
import { ClaimsTableCard } from "./claims-table";

export { ClaimCard, ClaimReadCard } from "./claim-card";
export { ClaimsTable, ClaimsTableCard } from "./claims-table";
export { DisputesView } from "./disputes-view";

/** Chat cards: tool name → the component that draws its result. */
export const cards: Record<string, (props: { output: unknown }) => ReactNode> = {
  dispute_list: ClaimsTableCard,
  dispute_get: ClaimCard,
  dispute_handle_claim: ClaimCard,
  dispute_read_claim: ClaimReadCard,
};
