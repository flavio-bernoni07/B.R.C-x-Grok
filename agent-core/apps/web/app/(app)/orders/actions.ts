"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getReadyErp } from "@agent/lib/db/app";
import { simulateOrderFeed } from "@agent/lib/order/service";

/** Wipe the desk and reload the labelled feed. Works without client JS (form action). */
export async function runOrderSimulation() {
  const erp = await getReadyErp();
  erp.clearOrderDesk();
  const { results } = await simulateOrderFeed(erp);
  const waiting = results.filter((r) => r.ok && r.result?.status === "awaiting_person").length;
  revalidatePath("/orders");
  revalidatePath("/actions");
  redirect(`/orders?sim=1&total=${results.length}&waiting=${waiting}`);
}
