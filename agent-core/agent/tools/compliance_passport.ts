import { defineTool } from "eve/tools";
import { z } from "zod";
import { orderCompliance, passport } from "../lib/compliance/passport";
import { getReadyErp } from "../lib/db/app";

export default defineTool({
  description:
    "Lot compliance passport for a milled batch or an order: Italian/import origin label, MRL lab result " +
    "(Reg 396/2005), GMO declaration or Decision 2011/884 papers when relevant, plant IFS/BRC/ISO 22000, " +
    "optional BIO/Fairtrade badges, and Art. 18 one-step-back / one-step-forward (who supplied the paddy, " +
    "which orders received the lot). Every figure cites a Mini ERP document. Demo fixtures only; rice is not " +
    "an EUDR commodity. A person must release a held lot — this tool never ships or buys.",
  inputSchema: z.object({
    batch: z.string().optional().describe("Milled batch id, e.g. LOT-C-0418"),
    orderRef: z.string().optional().describe("Order ref to list passports for every lot on it"),
  }),
  label: {
    start: ({ batch, orderRef }) =>
      batch ? `Open passport for ${batch}` : orderRef ? `Compliance for ${orderRef}` : "Open lot passport",
  },
  async execute({ batch, orderRef }) {
    const erp = await getReadyErp();
    if (batch) {
      const p = passport(erp, batch);
      if (!p) return { error: `No compliance passport for batch ${batch}` };
      return { passport: p };
    }
    if (orderRef) return orderCompliance(erp, orderRef);
    return { error: "Pass a batch or an orderRef" };
  },
});
