import { redirect } from "next/navigation";

/** Operations was split into Shipping and Stock; keep the path so old links still land. */
export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const tab = (await searchParams).tab;
  redirect(tab === "warehouse" ? "/shipping" : tab === "finance" ? "/disputes" : "/stock");
}
