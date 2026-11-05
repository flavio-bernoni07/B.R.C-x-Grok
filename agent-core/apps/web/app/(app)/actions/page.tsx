import { redirect } from "next/navigation";

/** Actions is Sign-off again; keep the path so old links still land. */
export default async function Page({ searchParams }: { searchParams: Promise<{ case?: string }> }) {
  const c = (await searchParams).case;
  redirect(c ? `/signoff?case=${encodeURIComponent(c)}` : "/signoff");
}
