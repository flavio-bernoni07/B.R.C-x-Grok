import { Suspense } from "react";
import { OverviewChat } from "@/components/shell/overview-chat";

export default function NewSessionPage() {
  return (
    <Suspense>
      <OverviewChat sessionless />
    </Suspense>
  );
}
