import { Suspense } from "react";
import { SignoffView } from "@/components/core/signoff-view";

export const dynamic = "force-dynamic";

/** Actions = Sign-off Pending desk with Send-off / Price / Quantity schede. */
export default function ActionsPage() {
  return (
    <Suspense>
      <SignoffView />
    </Suspense>
  );
}
