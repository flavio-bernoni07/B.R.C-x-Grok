"""Stock and production events.

Production enters as events, as the brief asks: a batch is planned, a batch is
finished, a quality hold blocks a batch (or part of it), a hold is released, a
line stops. Events change the `batches` table; nothing edits stock directly.

available_to_promise = released stock
                     + planned batches ready by the date
                     - confirmed order lines not shipped yet
Batches on quality hold never count and never ship.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from core.erp import Erp, now_iso

EVENT_KINDS = {"batch_planned", "batch_finished", "quality_hold", "hold_released", "line_stopped"}
OPEN_ORDER_STATUSES = ("confirmed", "ready_to_ship")


def _iso(value: str | None) -> str | None:
    """Accept YYYYMMDD or YYYY-MM-DD; return YYYY-MM-DD."""
    if not value:
        return None
    value = value.strip()
    if len(value) == 8 and value.isdigit():
        return f"{value[:4]}-{value[4:6]}-{value[6:]}"
    return value[:10]


def record_event(
    erp: Erp,
    kind: str,
    *,
    batch: str,
    gtin: str | None = None,
    qty: float | None = None,
    available_from: str | None = None,
    note: str | None = None,
) -> str:
    """Apply one production event to the batches table and log it."""
    if kind not in EVENT_KINDS:
        raise ValueError(f"unknown production event {kind!r}")
    existing = erp._one("SELECT * FROM batches WHERE batch = ?", (batch,))
    event_id = erp.next_id("prod_event", "EVT-")

    if kind == "batch_planned":
        if existing:
            raise ValueError(f"batch {batch} already exists")
        if not gtin or qty is None:
            raise ValueError("batch_planned needs gtin and qty")
        erp.db.execute(
            "INSERT INTO batches(batch, gtin, qty, status, available_from, source_doc) VALUES(?,?,?,?,?,?)",
            (batch, gtin, float(qty), "planned", _iso(available_from), event_id),
        )
    elif kind == "batch_finished":
        if existing:
            erp.db.execute(
                "UPDATE batches SET status = 'released', qty = COALESCE(?, qty), source_doc = ? WHERE batch = ?",
                (qty, event_id, batch),
            )
        else:
            if not gtin or qty is None:
                raise ValueError("batch_finished for a new batch needs gtin and qty")
            erp.db.execute(
                "INSERT INTO batches(batch, gtin, qty, status, available_from, source_doc) VALUES(?,?,?,?,?,?)",
                (batch, gtin, float(qty), "released", None, event_id),
            )
    elif kind == "quality_hold":
        if not existing:
            raise ValueError(f"no batch {batch} to hold")
        if qty is None or qty >= existing["qty"]:
            erp.db.execute("UPDATE batches SET status = 'hold', source_doc = ? WHERE batch = ?", (event_id, batch))
        else:
            # Part of the batch is held: split it so the rest can still ship.
            erp.db.execute("UPDATE batches SET qty = qty - ? WHERE batch = ?", (float(qty), batch))
            erp.db.execute(
                "INSERT INTO batches(batch, gtin, qty, status, available_from, source_doc) VALUES(?,?,?,?,?,?)",
                (f"{batch}-HOLD", existing["gtin"], float(qty), "hold", None, event_id),
            )
    elif kind == "hold_released":
        held = existing if existing and existing["status"] == "hold" else erp._one(
            "SELECT * FROM batches WHERE batch = ?", (f"{batch}-HOLD",)
        )
        if not held:
            raise ValueError(f"no held stock for batch {batch}")
        erp.db.execute("UPDATE batches SET status = 'released', source_doc = ? WHERE batch = ?",
                       (event_id, held["batch"]))
    elif kind == "line_stopped":
        if not existing or existing["status"] != "planned":
            raise ValueError(f"line_stopped needs a planned batch, got {batch}")
        erp.db.execute("UPDATE batches SET status = 'cancelled', source_doc = ? WHERE batch = ?", (event_id, batch))

    gtin_for_log = gtin or (existing or {}).get("gtin")
    erp.db.execute(
        "INSERT INTO production_events(event_id, kind, batch, gtin, qty, at, note) VALUES(?,?,?,?,?,?,?)",
        (event_id, kind, batch, gtin_for_log, qty, now_iso(), note),
    )
    erp.db.commit()
    erp.log("code", f"production.{kind}", batch, source_doc=event_id, detail={"gtin": gtin_for_log, "qty": qty, "note": note})
    return event_id


def batches(erp: Erp, gtin: str, status: str | None = None) -> list[dict[str, Any]]:
    sql = "SELECT * FROM batches WHERE gtin = ?"
    args: list[Any] = [gtin]
    if status:
        sql += " AND status = ?"
        args.append(status)
    return erp._all(sql + " ORDER BY batch", args)


def committed_qty(erp: Erp, gtin: str) -> float:
    """Confirmed order quantity for this product that has not shipped yet."""
    total = 0.0
    for order in erp.orders():
        if order["status"] not in OPEN_ORDER_STATUSES:
            continue
        shipped = sum(
            line["qty"]
            for shipment in erp.shipments(order["order_ref"])
            for line in shipment["lines"]
            if line["gtin"] == gtin
        )
        confirmed = sum(
            (line["qty_confirmed"] if line["qty_confirmed"] is not None else line["qty_ordered"] or 0)
            for line in order["lines"]
            if line["gtin"] == gtin
        )
        total += max(confirmed - shipped, 0.0)
    return total


def available_to_promise(erp: Erp, gtin: str, by_date: str | None = None) -> dict[str, Any]:
    by = _iso(by_date)
    released = sum(b["qty"] for b in batches(erp, gtin, "released"))
    held = sum(b["qty"] for b in batches(erp, gtin, "hold"))
    planned = sum(
        b["qty"]
        for b in batches(erp, gtin, "planned")
        if by is None or (b["available_from"] or "9999-12-31") <= by
    )
    committed = committed_qty(erp, gtin)
    return {
        "gtin": gtin,
        "by_date": by,
        "released": released,
        "planned": planned,
        "held": held,
        "committed": committed,
        "atp": max(released + planned - committed, 0.0),
    }


def allocate(erp: Erp, gtin: str, qty: float) -> tuple[list[dict[str, Any]], float]:
    """Take released stock first-in first-out. Returns (allocations, shortfall).

    Held batches are never touched. The caller writes the shipment; this only
    decrements the batches it takes from.
    """
    remaining = float(qty)
    taken: list[dict[str, Any]] = []
    for batch in batches(erp, gtin, "released"):
        if remaining <= 0:
            break
        use = min(batch["qty"], remaining)
        if use <= 0:
            continue
        erp.db.execute("UPDATE batches SET qty = qty - ? WHERE batch = ?", (use, batch["batch"]))
        taken.append({"batch": batch["batch"], "qty": use})
        remaining -= use
    erp.db.commit()
    return taken, max(remaining, 0.0)


def next_ready_date(erp: Erp, gtin: str) -> str | None:
    """Earliest date a planned batch of this product becomes available."""
    dates = sorted(b["available_from"] for b in batches(erp, gtin, "planned") if b["available_from"])
    return dates[0] if dates else None


def today_iso() -> str:
    return date.today().isoformat()
