/**
 * What happened to an order, one line per step, read from the audit log: who acted (Grok, a named
 * person, the retailer, or code) and what they did, in plain words. It follows the order into its
 * shipping cases and claims, so a closed order shows its whole history: the EDI Grok fixed, the
 * split, the pallet booked as a loss, the claim a person rejected, the payment.
 *
 * Every line is built from an audit entry or the sign-off case it points to; nothing is invented.
 */
import type { AuditEntry, Erp } from "../core/erp";
import { proposal as proposalOf } from "../shipping/cases";

export type StoryWho = "grok" | "person" | "retailer" | "code";
export type StoryStep = {
  who: StoryWho;
  /** The person's name, the retailer's name, "Grok" or "Code". */
  name: string;
  /** The person's desk ("order desk"), when the log names it. */
  role: string | null;
  text: string;
  /** A person's own words, when they gave a reason. */
  quote: string | null;
  /** The answers Grok offered, when it asked a person instead of proposing one. */
  options?: string[];
  at: string;
  /** Steps that matter most in a demo: a Grok fix or proposal, a person's decision, a loss, a claim. */
  key: boolean;
};

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : String(v ?? ""));
const money = (v: unknown) => (typeof v === "number" ? `€${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "");
/** The sentence that carries the reason: the one citing a clause, else the second, else the first. */
const reason = (s: unknown) => {
  const parts = String(s ?? "").split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.find((x) => x.includes("§")) ?? parts[1] ?? parts[0] ?? "";
};
const day = (iso: unknown) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : String(iso ?? "");
};
const ACTION_WORDS: Record<string, string> = {
  SHIP_WITHOUT_PALLET: "ship without the pallet and book it as a loss",
  RESCAN_PALLET: "hold the truck and scan the pallet again",
  BACKORDER: "send the rest with the next run",
  CONFIRM_SHORT_SHIPMENT: "confirm the short shipment",
  REPLACE_BATCH: "replace the batch",
};

function actor(a: AuditEntry, retailer: string): Pick<StoryStep, "who" | "name" | "role"> {
  if (a.actor.startsWith("person:")) {
    const [name, role] = a.actor.slice(7).split(/,\s*/);
    return { who: "person", name, role: role ?? null };
  }
  if (a.actor === "grok" || a.actor.startsWith("grok")) return { who: "grok", name: "Grok", role: null };
  if (a.actor === "retailer") return { who: "retailer", name: retailer, role: null };
  return { who: "code", name: "Code", role: null };
}

export function orderStory(erp: Erp, ref: string): StoryStep[] {
  const order = erp.order(ref);
  if (!order) return [];
  const retailer = erp.retailer(order.buyerGln)?.name ?? "The retailer";
  const all = erp.auditLog();
  // The order, its shipping cases and its claims.
  const ids = new Set<string>([ref]);
  for (const a of all) if (a.subjectRef === ref && a.action === "shipping.case_opened" && a.sourceDoc) ids.add(a.sourceDoc);
  for (const c of erp.claims()) if (c.orderRef === ref) ids.add(c.claimId);
  const mine = all.filter((a) => (a.subjectRef && ids.has(a.subjectRef)) || (!a.subjectRef && a.action === "orders.received" && a.sourceDoc === order.sourceDoc));

  const steps: StoryStep[] = [];
  const push = (a: AuditEntry, text: string, extra: Partial<StoryStep> = {}) =>
    steps.push({ ...actor(a, retailer), text, quote: null, at: a.at, key: false, ...extra });
  const actionWords = (p: J) =>
    Array.isArray(p.actions) ? (p.actions as J[]).map((x) => ACTION_WORDS[String(x.action)] ?? String(x.action).toLowerCase().replace(/_/g, " ")) : [];
  /** An exception case's proposal a person made themselves (they chose an option), not Grok's. */
  const personsOwn = (p: J) => proposalOf(erp, String(p.proposal_id ?? ""))?.by.startsWith("person:") ?? false;

  for (const a of mine) {
    const d = obj(a.detail);
    switch (a.action) {
      case "orders.received":
        push(a, `${retailer} sends the order (ORDERS)`);
        break;
      case "order.parse_fix": {
        const changes = Array.isArray(a.detail) ? (a.detail as J[]) : [];
        push(a, `Grok fixes the order it could not read: ${changes.map((c) => `${c.before} → ${c.after}`).join(", ")}`, { key: true });
        break;
      }
      case "order.qty_short":
        push(
          a,
          d.action === "split"
            ? `Not enough stock, so Grok splits the order: ${n(d.now_qty)} now, ${n(d.later_qty)} on ${day(d.later_date)}`
            : `Not enough stock: Grok proposes ${String(d.action ?? "a partial delivery").replace(/_/g, " ")}`,
          { key: true },
        );
        break;
      case "order.auto_confirmed":
        push(a, "Grok confirms the order: every check passed, no person needed", { key: true });
        break;
      case "signoff.requested": {
        const c = erp.signoff(a.sourceDoc ?? "");
        const p = obj(c?.proposal);
        if (c?.kind === "exception_case") {
          // A person's own choice is told once, on the line where they sign it.
          if (personsOwn(p)) break;
          const rationale = String(p.rationale ?? "").trim();
          steps.push({ who: "grok", name: "Grok", role: null, text: `Grok proposes: ${actionWords(p).join(", ") || "a fix"}`, quote: rationale || null, at: a.at, key: true });
        } else if (c?.kind === "verdict") {
          const v = obj(p.verdict);
          steps.push({ who: "grok", name: "Grok", role: null, text: `Grok's verdict: ${String(v.decision ?? "decide").replace(/_/g, " ")} the claim, a person checks`, quote: reason(v.summary) || null, at: a.at, key: true });
        }
        break;
      }
      case "signoff.approved":
      case "signoff.rejected": {
        const c = erp.signoff(a.sourceDoc ?? "");
        const ok = a.action === "signoff.approved";
        const own = c?.kind === "exception_case" && personsOwn(obj(c.proposal));
        const what =
          c?.kind === "confirm" ? (ok ? "confirms the order" : "holds the order") :
          own ? (ok ? `chooses: ${actionWords(obj(c?.proposal)).join(", ")}` : "withdraws their choice") :
          c?.kind === "exception_case" ? (ok ? "agrees with Grok" : "overrules Grok") :
          c?.kind === "verdict" ? (ok ? "confirms Grok's verdict" : "overrules Grok's verdict") :
          c?.kind === "dispatch_plan" ? (ok ? "approves the truck plan" : "rejects the truck plan") :
          ok ? "approves" : "rejects";
        // A warehouse decision's reason is quoted once, on the loss or rescan line that follows.
        push(a, `${actor(a, retailer).name} ${what}`, { quote: c?.kind !== "exception_case" && typeof d.reason === "string" ? d.reason : null, key: true });
        break;
      }
      case "playbook.lesson":
        push(a, `Lesson saved in the Playbook (${n(d.matching_decisions)} of ${n(d.needed)}): after ${n(d.needed)} matching decisions, ${String(d.then ?? "Grok does this alone")}`, { who: "code", name: "Code", role: null });
        break;
      case "order.ordrsp_sent":
        push(a, `Order confirmation (ORDRSP) sent to ${retailer}`);
        break;
      case "shipping.ingested": {
        const bo = Array.isArray(d.backorders) ? (d.backorders as J[]) : [];
        push(a, bo.length ? `Stock reserved; ${bo.map((b) => `${n(b.qty)} booked for ${day(b.date)}`).join(", ")}` : "Stock reserved for the order");
        break;
      }
      case "shipping.planned":
        push(a, `Truck ${String(d.truck ?? "").replace("TRUCK-", "")} booked${d.pallets ? `, ${n(d.pallets)} pallets` : ""}`);
        break;
      case "shipping.picking_list":
        push(a, `Picking list printed: ${n(d.pallets)} pallets`);
        break;
      case "shipping.options_asked": {
        // Grok flags the problem and asks, when every answer costs something.
        const opts = Array.isArray(d.options) ? (d.options as J[]) : [];
        const words = opts.map((o) => ACTION_WORDS[String(o.action)] ?? String(o.action).toLowerCase().replace(/_/g, " "));
        push(a, `Grok flags it and asks what to do: ${words.join(", or ")}?`, {
          quote: typeof d.problem === "string" ? d.problem : typeof d.question === "string" ? d.question : null,
          options: opts.map((o) => String(o.text ?? "")).filter(Boolean),
          key: true,
        });
        break;
      }
      case "shipping.loss_booked":
        push(a, `${actor(a, retailer).name} books ${n(d.qty)} packs (${money(d.eur)}) as a loss${d.loss_note ? `: write-off note ${String(d.loss_note)} for accounting` : ""}`, {
          quote: typeof d.reason === "string" ? d.reason : null,
          key: true,
        });
        break;
      case "shipping.loaded":
        push(a, `Truck loaded: ${Array.isArray(d.pallets) ? d.pallets.length : ""} pallets checked`);
        break;
      case "shipping.dispatched": {
        const short = Array.isArray(d.short) && d.short.length ? " (the DESADV says what was left behind)" : "";
        push(a, `Shipped on ${String(d.truck ?? "the truck").replace("TRUCK-", "")}: DESADV and DDT sent${short}`);
        break;
      }
      case "shipping.invoiced":
        push(a, `Invoice ${d.invoice} for ${money(d.net)} + VAT, only for what shipped (FatturaPA and EDI INVOIC)`);
        break;
      case "shipping.reconciled":
        push(a, d.status === "matched" ? "Order, DESADV and invoice checked: they agree" : `Order, DESADV and invoice checked: ${String(d.status ?? "").replace(/_/g, " ")}, explained`);
        break;
      case "shipping.delivered": {
        const got = Object.values(obj(d.received)).reduce<number>((x, y) => x + (Number(y) || 0), 0);
        push(a, `${retailer} signs the DDT: ${n(got)} packs received${d.note ? `, "${d.note}"` : ""}`);
        break;
      }
      case "dispute.claim_received":
        push(a, `${retailer} sends a claim`, { key: true });
        break;
      case "dispute.claim_read":
        push(a, `Grok reads it: ${d.claim_type === "other" ? "a claim the Playbook does not cover" : String(d.claim_type ?? "a claim").replace(/_/g, " ")}${typeof d.amount === "number" ? `, ${money(d.amount)}` : ""}`, { quote: typeof d.raw_notes === "string" ? d.raw_notes : null });
        break;
      case "dispute.reject_reply":
        push(a, `Evidence reply sent to ${retailer}: no credit`);
        break;
      case "dispute.credit_note":
        push(a, `Credit note sent to ${retailer}${typeof d.amount === "number" ? `: ${money(d.amount)}` : ""}`);
        break;
      case "finance.payment_posted":
        push(a, `${retailer} pays ${money(d.paid)}`, { key: true });
        break;
      default:
        break;
    }
  }
  return steps;
}
