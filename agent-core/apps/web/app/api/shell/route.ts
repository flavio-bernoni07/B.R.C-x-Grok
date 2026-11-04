import { getShellData } from "@/lib/shell";

export async function GET() {
  return Response.json(await getShellData());
}
