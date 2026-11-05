import { getReadyErp } from "@agent/lib/db/app";
import { closeTruck, dockView, pickTruck, scanPallet } from "@agent/lib/shipping/dock";

/** The loading dock: trucks with a manifest, their orders, pallets, scans and flags. */
export async function GET() {
  return Response.json(dockView(await getReadyErp()));
}

/** Warehouse actions at the dock: print the picking list, scan one pallet, close the truck. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { action?: string; truck_id?: string; pallet_id?: string };
  const erp = await getReadyErp();
  try {
    if (body.action === "pick" && body.truck_id) return Response.json({ pick: pickTruck(erp, body.truck_id), ...dockView(erp) });
    if (body.action === "scan" && body.truck_id && body.pallet_id) return Response.json({ scan: scanPallet(erp, body.pallet_id, body.truck_id), ...dockView(erp) });
    if (body.action === "close" && body.truck_id) return Response.json({ close: closeTruck(erp, body.truck_id), ...dockView(erp) });
    return Response.json({ error: "Say pick, scan or close, with a truck (and a pallet to scan)." }, { status: 400 });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 422 });
  }
}
