import { readPolicy, policyLabel } from "@agent/lib/core/policy";
import { Suspense } from "react";
import { ActionsView } from "@/components/core/actions-view";

export const dynamic = "force-dynamic";

export default function ActionsPage() {
  return (
    <Suspense>
      <ActionsView policy={policyLabel(readPolicy())} />
    </Suspense>
  );
}
