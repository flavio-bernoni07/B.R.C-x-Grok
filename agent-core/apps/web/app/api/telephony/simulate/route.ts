/**
 * Offline / rehearsal phone dispute (no live SIP). Creates a real DSP- via the same tools.
 * POST { retailer?, order_ref, category, claimed_quantity?, claimed_amount?, customer_description, caller?, language? }
 */
import { getReadyErp } from "@agent/lib/db/app";
import { simulatePhoneDispute } from "@agent/lib/dispute/phone_agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    retailer?: string;
    order_ref?: string;
    category?: string;
    claimed_quantity?: number;
    claimed_amount?: number;
    customer_description?: string;
    caller?: string;
    language?: "en" | "it";
  };

  if (!body.order_ref?.trim() || !body.customer_description?.trim() || !body.category?.trim()) {
    return Response.json(
      { error: "order_ref, category, and customer_description are required" },
      { status: 400 },
    );
  }
  if (!body.retailer?.trim()) {
    return Response.json(
      {
        error: "retailer is required",
        ask: "Ask which retailer they call for (Esselunga, Carrefour, Conad, Coop, Auchan).",
      },
      { status: 400 },
    );
  }

  const erp = await getReadyErp();
  const result = await simulatePhoneDispute(erp, {
    retailer: body.retailer,
    order_ref: body.order_ref,
    category: body.category,
    claimed_quantity: body.claimed_quantity ?? null,
    claimed_amount: body.claimed_amount ?? null,
    customer_description: body.customer_description,
    caller: body.caller ?? null,
    language: body.language,
  });

  return Response.json(result, { status: result.ok ? 200 : 422 });
}
