/** Order pipeline: parse -> availability -> price -> next action (port of order/pipeline.py; see order-dec.md). */
import { readFileSync } from "node:fs";
import { type AvailabilityProvider, getAvailability, StubAvailabilityProvider } from "./availability";
import { checkPrices, draftPriceMismatchMail, loadContract, type PriceCheckDict, type PriceCheckResult, type SupplyContract } from "./contract";
import { buildOrdrsp, type OrdrspDocument, type OrdrspHandoff } from "./ordrsp";
import { type ParsedOrder, type ParseResult, type ParseResultDict, parseOrdersEdi } from "./parser";

export const PipelineStatus = {
  AWAIT_GROK_PARSE: "await_grok_parse",
  AWAIT_GROK_QTY: "await_grok_qty",
  AWAIT_PRICE_HUMAN: "await_price_human", // draft mail -> manual EDI / pending
  AWAIT_CONFIRM_SIGNOFF: "await_confirm_signoff",
  READY_ORDRSP: "ready_ordrsp",
  ERROR: "error",
} as const;
export type PipelineStatus = (typeof PipelineStatus)[keyof typeof PipelineStatus];

export type AvailabilityLineCheck = {
  gtin: string | null;
  ordered_qty: number | null;
  available_qty: number | null;
  ok: boolean;
  source: string;
};

export type PipelineResultDict = {
  status: PipelineStatus;
  parse: ParseResultDict | null;
  availability: AvailabilityLineCheck[];
  price_check: PriceCheckDict | null;
  draft_mail: string | null;
  ordrsp: string | null;
  handoff: OrdrspHandoff | null;
  notes: string[];
};

export class PipelineResult {
  status: PipelineStatus;
  parse: ParseResult | null;
  availability: AvailabilityLineCheck[];
  price_check: PriceCheckResult | null;
  draft_mail: string | null;
  ordrsp: OrdrspDocument | null;
  notes: string[];

  constructor(r: {
    status: PipelineStatus;
    parse?: ParseResult | null;
    availability?: AvailabilityLineCheck[];
    price_check?: PriceCheckResult | null;
    draft_mail?: string | null;
    ordrsp?: OrdrspDocument | null;
    notes?: string[];
  }) {
    this.status = r.status;
    this.parse = r.parse ?? null;
    this.availability = r.availability ?? [];
    this.price_check = r.price_check ?? null;
    this.draft_mail = r.draft_mail ?? null;
    this.ordrsp = r.ordrsp ?? null;
    this.notes = r.notes ?? [];
  }

  toDict(): PipelineResultDict {
    return {
      status: this.status,
      parse: this.parse ? this.parse.toDict() : null,
      availability: this.availability.map((a) => ({ ...a })),
      price_check: this.price_check ? this.price_check.toDict() : null,
      draft_mail: this.draft_mail,
      ordrsp: this.ordrsp ? this.ordrsp.body : null,
      handoff: this.ordrsp ? this.ordrsp.handoff : null,
      notes: this.notes,
    };
  }
}

function checkAvailability(order: ParsedOrder, provider: AvailabilityProvider): [boolean, AvailabilityLineCheck[]] {
  const checks: AvailabilityLineCheck[] = [];
  let ok = true;
  for (const line of order.lines) {
    if (!line.gtin || line.quantity == null) {
      ok = false;
      checks.push({ gtin: line.gtin, ordered_qty: line.quantity, available_qty: null, ok: false, source: "missing_gtin_or_qty" });
      continue;
    }
    const result = getAvailability(
      { gtin: line.gtin, buyer_gln: order.buyer_gln, supplier_gln: order.supplier_gln, requested_date: order.order_date },
      provider,
    );
    const lineOk = result.found && line.quantity <= result.available_qty;
    if (!lineOk) ok = false;
    checks.push({ gtin: line.gtin, ordered_qty: line.quantity, available_qty: result.available_qty, ok: lineOk, source: result.source });
  }
  return [ok, checks];
}

/**
 * Run checks up to the next human/Grok gate.
 *
 * `confirm: true` only applies when the path is already clear for the always-on confirm
 * sign-off: then ORDRSP is emitted (simulates human OK).
 */
export function runOrderPipeline(
  rawEdi: string,
  opts: { availability?: AvailabilityProvider | null; contract?: SupplyContract | null; confirm?: boolean } = {},
): PipelineResult {
  const provider = opts.availability ?? new StubAvailabilityProvider();
  const contract = opts.contract ?? loadContract();

  const parse = parseOrdersEdi(rawEdi);
  if (!parse.ok) {
    return new PipelineResult({
      status: PipelineStatus.AWAIT_GROK_PARSE,
      parse,
      notes: ["parse_flags present — Grokbot must correct and re-enter Parse EDI"],
    });
  }

  const [qtyOk, availChecks] = checkAvailability(parse.order, provider);
  if (!qtyOk) {
    return new PipelineResult({
      status: PipelineStatus.AWAIT_GROK_QTY,
      parse,
      availability: availChecks,
      notes: ["qty_short — Grokbot chooses split or mail, then availability check again"],
    });
  }

  const price = checkPrices({ lines: parse.order.lines, contract });
  if (!price.ok) {
    const mail = draftPriceMismatchMail({
      orderNumber: parse.order.order_number,
      buyerName: contract.buyer_name,
      supplierName: contract.supplier_name,
      contract,
      priceCheck: price,
    });
    return new PipelineResult({
      status: PipelineStatus.AWAIT_PRICE_HUMAN,
      parse,
      availability: availChecks,
      price_check: price,
      draft_mail: mail,
      notes: ["price_mismatch — draft mail ready; human: manual EDI or Pending (not confirm sign-off)"],
    });
  }

  if (!opts.confirm) {
    return new PipelineResult({
      status: PipelineStatus.AWAIT_CONFIRM_SIGNOFF,
      parse,
      availability: availChecks,
      price_check: price,
      notes: ["checks ok — always-on human confirm sign-off before ORDRSP"],
    });
  }

  return new PipelineResult({
    status: PipelineStatus.READY_ORDRSP,
    parse,
    availability: availChecks,
    price_check: price,
    ordrsp: buildOrdrsp(parse.order),
    notes: ["confirmed — ORDRSP built; handoff payload ready for shipping"],
  });
}

export function runOrderFile(
  path: string,
  opts: { confirm?: boolean; availability?: AvailabilityProvider | null; contract?: SupplyContract | null } = {},
): PipelineResult {
  return runOrderPipeline(readFileSync(path, "utf8"), opts);
}
