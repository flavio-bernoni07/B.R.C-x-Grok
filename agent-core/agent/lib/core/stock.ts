/**
 * Stock and production events (port of core/stock.py).
 *
 * Production enters as events: a batch is planned, finished, put on quality hold (all or
 * part), released, or a line stops. Events change `batches`; nothing edits stock directly.
 *
 *   available_to_promise = released + planned ready by the date − confirmed not shipped
 *
 * Batches on quality hold never count and never ship.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import * as s from "../db/schema";
import { type Batch, type Erp, nowIso } from "./erp";

export const EVENT_KINDS = ["batch_planned", "batch_finished", "quality_hold", "hold_released", "line_stopped"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const OPEN_ORDER_STATUSES = ["confirmed", "ready_to_ship"];
/** Orders waiting on Send-off also reserve ATP so the feed cannot oversell the same stock twice. */
export const RESERVED_ORDER_STATUSES = ["awaiting_confirmation", "confirmed", "ready_to_ship"];

/** Accept YYYYMMDD or YYYY-MM-DD; return YYYY-MM-DD. */
export function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}`;
  return v.slice(0, 10);
}

const getBatch = (erp: Erp, batch: string) => erp.db.select().from(s.batches).where(eq(s.batches.batch, batch)).get();

export function recordEvent(
  erp: Erp,
  kind: string,
  opts: { batch: string; gtin?: string | null; qty?: number | null; availableFrom?: string | null; note?: string | null },
): string {
  if (!(EVENT_KINDS as readonly string[]).includes(kind)) throw new Error(`unknown production event ${kind}`);
  const { batch, gtin = null, qty = null, availableFrom = null, note = null } = opts;
  const existing = getBatch(erp, batch);
  const eventId = erp.nextId("prod_event", "EVT-");

  erp.tx(() => {
    if (kind === "batch_planned") {
      if (existing) throw new Error(`batch ${batch} already exists`);
      if (!gtin || qty == null) throw new Error("batch_planned needs gtin and qty");
      erp.db.insert(s.batches).values({ batch, gtin, qty, status: "planned", availableFrom: isoDate(availableFrom), sourceDoc: eventId }).run();
    } else if (kind === "batch_finished") {
      if (existing) {
        erp.db
          .update(s.batches)
          .set({ status: "released", qty: qty ?? existing.qty, sourceDoc: eventId })
          .where(eq(s.batches.batch, batch))
          .run();
      } else {
        if (!gtin || qty == null) throw new Error("batch_finished for a new batch needs gtin and qty");
        erp.db.insert(s.batches).values({ batch, gtin, qty, status: "released", availableFrom: null, sourceDoc: eventId }).run();
      }
    } else if (kind === "quality_hold") {
      if (!existing) throw new Error(`no batch ${batch} to hold`);
      if (qty == null || qty >= existing.qty) {
        erp.db.update(s.batches).set({ status: "hold", sourceDoc: eventId }).where(eq(s.batches.batch, batch)).run();
      } else {
        // Part of the batch is held: split it so the rest can still ship.
        erp.db.update(s.batches).set({ qty: sql`${s.batches.qty} - ${qty}` }).where(eq(s.batches.batch, batch)).run();
        erp.db
          .insert(s.batches)
          .values({ batch: `${batch}-HOLD`, gtin: existing.gtin, qty, status: "hold", availableFrom: null, sourceDoc: eventId })
          .run();
      }
    } else if (kind === "hold_released") {
      const held = existing && existing.status === "hold" ? existing : getBatch(erp, `${batch}-HOLD`);
      if (!held) throw new Error(`no held stock for batch ${batch}`);
      erp.db.update(s.batches).set({ status: "released", sourceDoc: eventId }).where(eq(s.batches.batch, held.batch)).run();
    } else if (kind === "line_stopped") {
      if (!existing || existing.status !== "planned") throw new Error(`line_stopped needs a planned batch, got ${batch}`);
      erp.db.update(s.batches).set({ status: "cancelled", sourceDoc: eventId }).where(eq(s.batches.batch, batch)).run();
    }
    const gtinForLog = gtin ?? existing?.gtin ?? null;
    erp.db.insert(s.productionEvents).values({ eventId, kind, batch, gtin: gtinForLog, qty, at: nowIso(), note }).run();
    erp.log("code", `production.${kind}`, batch, { sourceDoc: eventId, detail: { gtin: gtinForLog, qty, note } });
  });
  return eventId;
}

export function batches(erp: Erp, gtin: string, status?: string): Batch[] {
  const conds = [eq(s.batches.gtin, gtin)];
  if (status) conds.push(eq(s.batches.status, status));
  return erp.db.select().from(s.batches).where(and(...conds)).orderBy(asc(s.batches.batch)).all();
}

export function allBatches(erp: Erp): Batch[] {
  return erp.db.select().from(s.batches).orderBy(asc(s.batches.batch)).all();
}

export function productionEvents(erp: Erp) {
  return erp.db.select().from(s.productionEvents).orderBy(asc(s.productionEvents.eventId)).all();
}

/**
 * Quantity reserved for this product that has not shipped yet.
 * Includes Send-off (`awaiting_confirmation`) so parallel confirms cannot oversell.
 */
export function committedQty(
  erp: Erp,
  gtin: string,
  opts: { exceptOrderRef?: string; includeAwaitingConfirm?: boolean } = {},
): number {
  const statuses =
    opts.includeAwaitingConfirm === false ? OPEN_ORDER_STATUSES : RESERVED_ORDER_STATUSES;
  let total = 0;
  for (const order of erp.orders()) {
    if (opts.exceptOrderRef && order.orderRef === opts.exceptOrderRef) continue;
    if (!statuses.includes(order.status)) continue;
    const shipped = erp
      .shipments(order.orderRef)
      .flatMap((sh) => sh.lines)
      .filter((l) => l.gtin === gtin)
      .reduce((a, l) => a + l.qty, 0);
    const confirmed = order.lines
      .filter((l) => l.gtin === gtin)
      .reduce((a, l) => a + (l.qtyConfirmed ?? l.qtyOrdered ?? 0), 0);
    total += Math.max(confirmed - shipped, 0);
  }
  return total;
}

export type Atp = { gtin: string; byDate: string | null; released: number; planned: number; held: number; committed: number; atp: number };

export function availableToPromise(
  erp: Erp,
  gtin: string,
  byDate?: string | null,
  opts: { exceptOrderRef?: string } = {},
): Atp {
  const by = isoDate(byDate);
  const sum = (bs: Batch[]) => bs.reduce((a, b) => a + b.qty, 0);
  const released = sum(batches(erp, gtin, "released"));
  const held = sum(batches(erp, gtin, "hold"));
  const planned = sum(batches(erp, gtin, "planned").filter((b) => by == null || (b.availableFrom ?? "9999-12-31") <= by));
  const committed = committedQty(erp, gtin, { exceptOrderRef: opts.exceptOrderRef });
  return { gtin, byDate: by, released, planned, held, committed, atp: Math.max(released + planned - committed, 0) };
}

/** Take released stock first-in first-out. Returns allocations and shortfall. Held batches are never touched. */
export function allocate(erp: Erp, gtin: string, qty: number): { taken: { batch: string; qty: number }[]; shortfall: number } {
  let remaining = qty;
  const taken: { batch: string; qty: number }[] = [];
  erp.tx(() => {
    for (const b of batches(erp, gtin, "released")) {
      if (remaining <= 0) break;
      const use = Math.min(b.qty, remaining);
      if (use <= 0) continue;
      erp.db.update(s.batches).set({ qty: sql`${s.batches.qty} - ${use}` }).where(eq(s.batches.batch, b.batch)).run();
      taken.push({ batch: b.batch, qty: use });
      remaining -= use;
    }
  });
  return { taken, shortfall: Math.max(remaining, 0) };
}

/** Earliest date a planned batch of this product becomes available. */
export function nextReadyDate(erp: Erp, gtin: string): string | null {
  const dates = batches(erp, gtin, "planned")
    .map((b) => b.availableFrom)
    .filter((d): d is string => !!d)
    .sort();
  return dates[0] ?? null;
}

export const todayIso = () => new Date().toISOString().slice(0, 10);
