"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageHeader, Segmented } from "@/components/kit";
import { Page } from "@/components/shell/app-shell";
import { ShippingView } from "@/components/shipping/shipping-view";
import { FinanceTab } from "./finance";
import { InventoryTab } from "./inventory";

export type OpsTab = "inventory" | "warehouse" | "finance";
export const OPS_TABS: { value: OpsTab; label: string }[] = [
  { value: "inventory", label: "Inventory & Forecast" },
  { value: "warehouse", label: "Warehouse & Shipping" },
  { value: "finance", label: "Finance & Documents" },
];

const SUB: Record<OpsTab, string> = {
  inventory: "Stock by product and batch, the demand forecast (an estimate) and the Purchasing agent's paddy to buy.",
  warehouse: "The Logistics agent's shared trucks and routes, then every shipment with its checks.",
  finance: "Invoices with their order and shipment, and every document the app wrote.",
};

/** Operations: three tabs, kept in the URL as ?tab=inventory|warehouse|finance. */
export function OperationsView({ initialTab }: { readonly initialTab: OpsTab }) {
  const router = useRouter();
  const [tab, setTab] = useState<OpsTab>(initialTab);
  const change = (t: OpsTab) => {
    setTab(t);
    router.replace(`/operations?tab=${t}`, { scroll: false });
  };
  return (
    <Page>
      <PageHeader title="Operations">
        <Segmented options={OPS_TABS} value={tab} onChange={change} />
      </PageHeader>
      {tab === "inventory" ? <InventoryTab /> : null}
      {tab === "warehouse" ? (
        // The Logistics agent's plan, with the transport planner's sign-off, is the first section of ShippingView.
        <ShippingView embedded />
      ) : null}
      {tab === "finance" ? <FinanceTab /> : null}
    </Page>
  );
}
