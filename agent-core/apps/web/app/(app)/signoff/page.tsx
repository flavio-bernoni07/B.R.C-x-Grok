import { Suspense } from "react";
import { SignoffDesk } from "@/components/core/signoff-desk";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense>
      <SignoffDesk />
    </Suspense>
  );
}
