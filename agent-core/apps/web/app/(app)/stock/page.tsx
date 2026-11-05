import { Suspense } from "react";
import { StockPage } from "@/components/stock/stock-page";

export default function Page() {
  return (
    <Suspense>
      <StockPage />
    </Suspense>
  );
}
