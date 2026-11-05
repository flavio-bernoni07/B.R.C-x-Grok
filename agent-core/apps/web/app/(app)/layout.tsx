import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { getShellData } from "@/lib/shell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { readonly children: ReactNode }) {
  const initialShell = await getShellData();
  return <AppShell initial={initialShell}>{children}</AppShell>;
}
