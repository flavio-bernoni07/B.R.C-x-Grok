import { Suspense } from "react";
import { OverviewChat } from "@/components/shell/overview-chat";

export default function Page() {
  return (
    <Suspense>
      <OverviewChat />
    </Suspense>
  );
}
