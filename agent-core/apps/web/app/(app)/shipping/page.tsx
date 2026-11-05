import { Suspense } from "react";
import { ShippingPage } from "@/components/shipping/shipping-page";

export default function Page() {
  return (
    <Suspense>
      <ShippingPage />
    </Suspense>
  );
}
