import { Suspense } from "react";
import { OverviewChat } from "@/components/shell/overview-chat";

export default async function SessionPage({ params }: { readonly params: Promise<{ readonly sessionId: string }> }) {
  const { sessionId } = await params;
  return (
    <Suspense>
      <OverviewChat sessionId={sessionId} />
    </Suspense>
  );
}
