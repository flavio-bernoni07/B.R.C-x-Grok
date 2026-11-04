import { type OpsTab, OperationsView } from "@/components/operations/operations-view";

const TABS: OpsTab[] = ["inventory", "warehouse", "finance"];

export default async function OperationsPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const tab = (await searchParams).tab;
  const initial = TABS.find((t) => t === tab) ?? "inventory";
  return <OperationsView key={initial} initialTab={initial} />;
}
