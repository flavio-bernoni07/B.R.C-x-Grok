import { Suspense } from "react";
import { DisputesView } from "@/components/dispute";

export default function DisputesPage() {
  return (
    <Suspense fallback={null}>
      <DisputesView />
    </Suspense>
  );
}
