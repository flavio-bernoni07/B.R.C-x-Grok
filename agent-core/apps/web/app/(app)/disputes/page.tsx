import { Suspense } from "react";
import { DisputesView } from "@/components/dispute/disputes-view";

export default function Page() {
  return (
    <Suspense>
      <DisputesView />
    </Suspense>
  );
}
