import { RiceChat } from "@/components/rice/rice-chat";

export default async function SessionPage({
  params,
}: {
  readonly params: Promise<{ readonly sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <RiceChat sessionId={sessionId} />;
}
