"""Trucks, picking, pallet scans, loading and dispatch.

Rebuilt from Nicola's v0.5.0 write-up in DECISIONS.md (his code is not in this
repo), on the shared Mini ERP. Same rules:

- planning assigns whole orders to the first truck that fits: available, same
  destination (or an explicit compatible route), overlapping delivery window,
  pallet space, payload weight. A missing weight or pallet size stops the plan.
  Planning writes no shipment and moves no stock.
- picking proposes pallets (batch first in, first out) and moves no stock.
- every pallet is scanned: wrong product, wrong batch, bad quantity, duplicate,
  quality hold or WRONG_TRUCK keeps it off the shipment.
- dispatch needs a loading record on the planned truck and manifest; holds are
  checked again; only then does stock leave and the DESADV and DDT get written.

Every failed check is stored as an exception that `shipping.cases` can open as a case.
"""

from __future__ import annotations

import json
import math
from datetime import date, timedelta
from typing import Any

from core.erp import Erp, now_iso
from core.stock import batches
from shipping.documents import build_ddt, build_desadv

SCHEMA = """
CREATE TABLE IF NOT EXISTS si_trucks (truck_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS si_manifests (manifest_id TEXT PRIMARY KEY, truck_id TEXT NOT NULL, status TEXT NOT NULL,
    data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS si_pallets (pallet_id TEXT PRIMARY KEY, order_ref TEXT NOT NULL, gtin TEXT NOT NULL,
    batch TEXT, qty REAL NOT NULL, status TEXT NOT NULL, manifest_id TEXT, truck_id TEXT);
CREATE TABLE IF NOT EXISTS si_scans (id INTEGER PRIMARY KEY AUTOINCREMENT, pallet_id TEXT, order_ref TEXT,
    data TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS si_loadings (loading_id TEXT PRIMARY KEY, order_ref TEXT NOT NULL, truck_id TEXT,
    manifest_id TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS si_exceptions (exception_id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL);
"""


def ensure_schema(erp: Erp) -> None:
    erp.db.executescript(SCHEMA)
    erp.db.commit()


def _j(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    out = dict(row)
    if "data" in out:
        out.update(json.loads(out.pop("data")))
    return out


def record_exception(erp: Erp, *, type: str, severity: str, order_ref: str | None, explanation: str,
                     evidence: dict[str, Any] | None = None, truck_id: str | None = None,
                     pallet_id: str | None = None, shipment_ref: str | None = None, invoice_ref: str | None = None,
                     financial_impact_eur: float | None = None) -> dict[str, Any]:
    ensure_schema(erp)
    exc = {
        "exception_id": erp.next_id("si_exception", "EXC-"), "type": type, "severity": severity,
        "order_ref": order_ref, "truck_id": truck_id, "pallet_id": pallet_id, "shipment_ref": shipment_ref,
        "invoice_ref": invoice_ref, "explanation": explanation, "evidence": evidence or {},
        "financial_impact_eur": financial_impact_eur, "at": now_iso(),
    }
    erp.db.execute("INSERT INTO si_exceptions(exception_id, status, data) VALUES(?,?,?)",
                   (exc["exception_id"], "open", json.dumps(exc, default=str)))
    erp.db.commit()
    erp.log("code", f"shipping.exception.{type}", order_ref, source_doc=exc["exception_id"], detail=explanation)
    return exc


def exception(erp: Erp, exception_id: str) -> dict[str, Any] | None:
    ensure_schema(erp)
    row = erp._one("SELECT * FROM si_exceptions WHERE exception_id = ?", (exception_id,))
    return _j(row)


# ----- trucks and planning --------------------------------------------------

def register_trucks(erp: Erp, trucks: list[dict[str, Any]]) -> list[str]:
    """Each truck: truck_id, plate, destination, pallet_capacity, max_payload_kg,
    optional window [from, to] (YYYY-MM-DD), compatible_routes [destinations], available."""
    ensure_schema(erp)
    ids = []
    for truck in trucks:
        data = {"available": True, "compatible_routes": [], **truck}
        erp.db.execute("INSERT OR REPLACE INTO si_trucks(truck_id, data) VALUES(?, ?)",
                       (truck["truck_id"], json.dumps(data)))
        ids.append(truck["truck_id"])
        erp.log("code", "shipping.truck_registered", truck["truck_id"], detail=data)
    erp.db.commit()
    return ids


def truck(erp: Erp, truck_id: str) -> dict[str, Any] | None:
    ensure_schema(erp)
    row = erp._one("SELECT * FROM si_trucks WHERE truck_id = ?", (truck_id,))
    return json.loads(row["data"]) if row else None


def trucks(erp: Erp) -> list[dict[str, Any]]:
    ensure_schema(erp)
    return [json.loads(r["data"]) for r in erp._all("SELECT data FROM si_trucks ORDER BY truck_id")]


def manifests(erp: Erp, status: str | None = None) -> list[dict[str, Any]]:
    ensure_schema(erp)
    rows = erp._all("SELECT * FROM si_manifests" + (" WHERE status = ?" if status else "") + " ORDER BY manifest_id",
                    (status,) if status else ())
    return [_j(r) for r in rows]  # type: ignore[misc]


def manifest_for_order(erp: Erp, order_ref: str) -> dict[str, Any] | None:
    for m in manifests(erp):
        if m["status"] != "cancelled" and order_ref in m["orders"]:
            return m
    return None


def order_load(erp: Erp, order_ref: str) -> dict[str, Any]:
    """Pallets and weight of an order, from product data. Missing data stops the plan."""
    order = erp.order(order_ref)
    retailer = erp.retailer(order["buyer_gln"]) or {}
    pallets, weight, missing = 0, 0.0, []
    for line in order["lines"]:
        product = erp.product(gtin=line["gtin"]) or {}
        qty = float(line["qty_confirmed"] if line["qty_confirmed"] is not None else line["qty_ordered"] or 0)
        if not product.get("units_per_pallet") or not product.get("unit_weight_kg"):
            missing.append(product.get("item_code") or line["gtin"])
            continue
        pallets += math.ceil(qty / product["units_per_pallet"])
        weight += qty * product["unit_weight_kg"]
    notes = order.get("notes") or {}
    window = notes.get("delivery_window")
    return {"order_ref": order_ref, "pallets": pallets, "weight_kg": round(weight, 1), "missing_data": missing,
            "destination": retailer.get("delivery_point"), "window": window}


def _overlap(a: list[str] | None, b: list[str] | None) -> bool:
    if not a or not b:
        return True
    return a[0] <= b[1] and b[0] <= a[1]


def _used(erp: Erp, truck_id: str) -> tuple[int, float, list[str]]:
    pallets, weight, dests = 0, 0.0, []
    for m in manifests(erp):
        if m["truck_id"] == truck_id and m["status"] in {"planned", "loaded"}:
            pallets += m["pallets"]
            weight += m["weight_kg"]
            dests += m["destinations"]
    return pallets, weight, dests


def truck_fits(erp: Erp, truck_data: dict[str, Any], load: dict[str, Any]) -> list[str]:
    """Why this truck cannot take this order, in the planner's order of checks. Empty = fits."""
    problems = []
    if not truck_data.get("available", True):
        problems.append("TRUCK_UNAVAILABLE")
    used_p, used_w, dests = _used(erp, truck_data["truck_id"])
    routes = {truck_data.get("destination")} | set(truck_data.get("compatible_routes") or [])
    if load["destination"] not in routes or any(d not in routes for d in dests):
        problems.append("DESTINATION_MISMATCH")
    if not _overlap(truck_data.get("window"), load.get("window")):
        problems.append("DELIVERY_WINDOW")
    if used_p + load["pallets"] > truck_data["pallet_capacity"]:
        problems.append("TRUCK_CAPACITY_EXCEEDED")
    if used_w + load["weight_kg"] > truck_data["max_payload_kg"]:
        problems.append("TRUCK_WEIGHT_EXCEEDED")
    return problems


def plan_truck_loads(erp: Erp, order_refs: list[str], *, only_truck_id: str | None = None) -> dict[str, Any]:
    """Assign each whole order to the first truck that fits. Writes manifests, never stock."""
    ensure_schema(erp)
    planned, failures = [], []
    for ref in order_refs:
        order = erp.order(ref)
        if not order or order["status"] != "ready_to_ship":
            failures.append(record_exception(erp, type="ORDER_NOT_READY", severity="medium", order_ref=ref,
                                             explanation=f"order {ref} is not ready to ship"))
            continue
        if manifest_for_order(erp, ref):
            continue
        load = order_load(erp, ref)
        if load["missing_data"]:
            failures.append(record_exception(
                erp, type="PLAN_MISSING_PRODUCT_DATA", severity="high", order_ref=ref,
                explanation=f"no pallet size or unit weight for {', '.join(load['missing_data'])}: the plan stops",
                evidence=load))
            continue
        candidates = [t for t in trucks(erp) if not only_truck_id or t["truck_id"] == only_truck_id]
        chosen, why = None, {}
        for t in candidates:
            problems = truck_fits(erp, t, load)
            if not problems:
                chosen = t
                break
            why[t["truck_id"]] = problems
        if not chosen:
            first = next(iter(why.values()), ["NO_TRUCK"])[0] if why else "NO_TRUCK"
            failures.append(record_exception(
                erp, type=first, severity="high", order_ref=ref, truck_id=next(iter(why), None),
                explanation=f"order {ref} ({load['pallets']} pallets, {load['weight_kg']:g} kg) fits no truck",
                evidence={"load": load, "trucks": why}))
            continue
        manifest_id = erp.next_id("si_manifest", "MAN-")
        data = {"orders": [ref], "pallets": load["pallets"], "weight_kg": load["weight_kg"],
                "destinations": [load["destination"]], "physically_loaded": False, "dispatched": False}
        erp.db.execute("INSERT INTO si_manifests(manifest_id, truck_id, status, data) VALUES(?,?,?,?)",
                       (manifest_id, chosen["truck_id"], "planned", json.dumps(data)))
        erp.db.commit()
        erp.log("code", "shipping.planned", ref, source_doc=manifest_id, detail={"truck": chosen["truck_id"], **load})
        planned.append({"order_ref": ref, "truck_id": chosen["truck_id"], "manifest_id": manifest_id})
    return {"planned": planned, "exceptions": failures}


def _set_manifest(erp: Erp, manifest_id: str, status: str, **data: Any) -> None:
    current = _j(erp._one("SELECT * FROM si_manifests WHERE manifest_id = ?", (manifest_id,)))
    payload = {k: current[k] for k in ("orders", "pallets", "weight_kg", "destinations", "physically_loaded", "dispatched")}
    payload.update(data)
    erp.db.execute("UPDATE si_manifests SET status = ?, data = ? WHERE manifest_id = ?",
                   (status, json.dumps(payload), manifest_id))
    erp.db.commit()


def cancel_truck_plan(erp: Erp, order_ref: str) -> bool:
    """Release a plan before loading. After a loading record or dispatch it stays locked."""
    m = manifest_for_order(erp, order_ref)
    if not m:
        return False
    if m["status"] != "planned" or _loading(erp, order_ref):
        raise ValueError(f"{m['manifest_id']} is {m['status']}: a loaded or dispatched plan stays locked")
    _set_manifest(erp, m["manifest_id"], "cancelled")
    erp.log("code", "shipping.plan_cancelled", order_ref, source_doc=m["manifest_id"])
    return True


def revise_truck_plan(erp: Erp, order_ref: str, *, truck_id: str) -> dict[str, Any]:
    cancel_truck_plan(erp, order_ref)
    return plan_truck_loads(erp, [order_ref], only_truck_id=truck_id)


# ----- picking, scans, loading ----------------------------------------------

def create_picking_list(erp: Erp, order_ref: str) -> list[dict[str, Any]]:
    """Pallets to pick, batch first in first out. Copies the truck from the manifest. No stock moves."""
    ensure_schema(erp)
    existing = erp._all("SELECT * FROM si_pallets WHERE order_ref = ? ORDER BY pallet_id", (order_ref,))
    if existing:
        return existing
    order = erp.order(order_ref)
    m = manifest_for_order(erp, order_ref)
    n = 0
    for line in order["lines"]:
        product = erp.product(gtin=line["gtin"]) or {}
        per = product.get("units_per_pallet") or 10**9
        want = float(line["qty_confirmed"] if line["qty_confirmed"] is not None else line["qty_ordered"] or 0)
        for b in batches(erp, line["gtin"], "released"):
            free = b["qty"] - _reserved(erp, b["batch"])
            while want > 0 and free > 0:
                qty = min(per, want, free)
                n += 1
                erp.db.execute(
                    "INSERT INTO si_pallets(pallet_id, order_ref, gtin, batch, qty, status, manifest_id, truck_id) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (f"PAL-{order_ref}-{n:02d}", order_ref, line["gtin"], b["batch"], qty, "picked",
                     m["manifest_id"] if m else None, m["truck_id"] if m else None))
                want -= qty
                free -= qty
    erp.db.commit()
    erp.log("code", "shipping.picking_list", order_ref, detail={"pallets": n})
    return erp._all("SELECT * FROM si_pallets WHERE order_ref = ? ORDER BY pallet_id", (order_ref,))


def _reserved(erp: Erp, batch: str) -> float:
    row = erp._one("SELECT COALESCE(SUM(qty), 0) AS q FROM si_pallets WHERE batch = ? AND status IN "
                   "('picked','verified','loaded')", (batch,))
    return float(row["q"]) if row else 0.0


def pallets(erp: Erp, order_ref: str) -> list[dict[str, Any]]:
    ensure_schema(erp)
    return erp._all("SELECT * FROM si_pallets WHERE order_ref = ? ORDER BY pallet_id", (order_ref,))


def _batch_status(erp: Erp, batch: str) -> str | None:
    row = erp._one("SELECT status FROM batches WHERE batch = ?", (batch,))
    return row["status"] if row else None


def verify_scans(erp: Erp, order_ref: str, scans: list[dict[str, Any]], *, truck_id: str | None = None) -> dict[str, Any]:
    """Check each simulated scan {pallet_id, gtin, batch, qty, truck_id?} against the picking list."""
    ensure_schema(erp)
    expected = {p["pallet_id"]: p for p in pallets(erp, order_ref)}
    seen: set[str] = {p for p, row in expected.items() if row["status"] == "verified"}
    results, failures = [], []
    for scan in scans:
        pid = scan.get("pallet_id")
        p = expected.get(pid)
        scan_truck = scan.get("truck_id") or truck_id
        code = "OK"
        if not p:
            code = "UNKNOWN_PALLET"
        elif pid in seen:
            code = "DUPLICATE_SCAN"
        elif scan.get("gtin") != p["gtin"]:
            code = "WRONG_PRODUCT"
        elif scan.get("batch") != p["batch"]:
            code = "WRONG_BATCH"
        elif float(scan.get("qty") or 0) != float(p["qty"]):
            code = "BAD_QUANTITY"
        elif _batch_status(erp, p["batch"]) == "hold":
            code = "QUALITY_HOLD"
        elif p["truck_id"] and scan_truck and scan_truck != p["truck_id"]:
            code = "WRONG_TRUCK"
        erp.db.execute("INSERT INTO si_scans(pallet_id, order_ref, data, result, at) VALUES(?,?,?,?,?)",
                       (pid, order_ref, json.dumps(scan), code, now_iso()))
        if code == "OK":
            seen.add(pid)
            erp.db.execute("UPDATE si_pallets SET status = 'verified' WHERE pallet_id = ?", (pid,))
        else:
            if p and code != "DUPLICATE_SCAN":
                erp.db.execute("UPDATE si_pallets SET status = 'rejected' WHERE pallet_id = ?", (pid,))
            failures.append(record_exception(
                erp, type=code, severity="high" if code in {"QUALITY_HOLD", "WRONG_TRUCK", "WRONG_PRODUCT"} else "medium",
                order_ref=order_ref, pallet_id=pid, truck_id=scan_truck,
                explanation=f"pallet {pid}: {code.replace('_', ' ').lower()}",
                evidence={"scan": scan, "expected": p}))
        results.append({"pallet_id": pid, "result": code})
    erp.db.commit()
    return {"results": results, "exceptions": failures}


def _loading(erp: Erp, order_ref: str) -> dict[str, Any] | None:
    ensure_schema(erp)
    rows = erp._all("SELECT * FROM si_loadings WHERE order_ref = ? ORDER BY loading_id", (order_ref,))
    return _j(rows[-1]) if rows else None


def confirm_loading(erp: Erp, order_ref: str, *, truck_id: str | None = None) -> dict[str, Any]:
    """Load the verified pallets. A pallet on the list that was never verified is MISSING_PALLET."""
    m = manifest_for_order(erp, order_ref)
    the_truck = truck_id or (m["truck_id"] if m else None)
    loaded, failures = [], []
    for p in pallets(erp, order_ref):
        if p["status"] == "verified":
            if m and the_truck != m["truck_id"]:
                failures.append(record_exception(erp, type="WRONG_TRUCK", severity="high", order_ref=order_ref,
                                                 pallet_id=p["pallet_id"], truck_id=the_truck,
                                                 explanation=f"pallet {p['pallet_id']} is planned on {m['truck_id']}, "
                                                             f"not {the_truck}"))
                continue
            erp.db.execute("UPDATE si_pallets SET status = 'loaded', truck_id = ? WHERE pallet_id = ?",
                           (the_truck, p["pallet_id"]))
            loaded.append(p["pallet_id"])
        elif p["status"] in {"picked", "rejected"}:
            failures.append(record_exception(erp, type="MISSING_PALLET", severity="high", order_ref=order_ref,
                                             pallet_id=p["pallet_id"], truck_id=the_truck,
                                             explanation=f"pallet {p['pallet_id']} ({p['qty']:g} units) is not on the truck",
                                             evidence={"pallet": p}))
    loading_id = erp.next_id("si_loading", "LOAD-")
    erp.db.execute("INSERT INTO si_loadings(loading_id, order_ref, truck_id, manifest_id, data) VALUES(?,?,?,?,?)",
                   (loading_id, order_ref, the_truck, m["manifest_id"] if m else None,
                    json.dumps({"pallets": loaded, "exceptions": [f["exception_id"] for f in failures], "at": now_iso()})))
    erp.db.commit()
    if m and loaded:
        _set_manifest(erp, m["manifest_id"], "loaded", physically_loaded=True)
    erp.log("code", "shipping.loaded", order_ref, source_doc=loading_id, detail={"truck": the_truck, "pallets": loaded})
    return {"loading_id": loading_id, "truck_id": the_truck, "pallets": loaded, "exceptions": failures}


def authorize_dispatch(erp: Erp, order_ref: str, *, ship_date: str, truck_id: str | None = None) -> dict[str, Any]:
    """Write the shipment from the loaded pallets: holds checked again, then stock leaves."""
    loading = _loading(erp, order_ref)
    if not loading:
        raise ValueError(f"order {order_ref}: no loading record, nothing can be dispatched")
    m = manifest_for_order(erp, order_ref)
    the_truck = truck_id or loading["truck_id"]
    if m and (loading["truck_id"] != m["truck_id"] or loading["manifest_id"] != m["manifest_id"] or the_truck != m["truck_id"]):
        exc = record_exception(erp, type="WRONG_TRUCK", severity="high", order_ref=order_ref, truck_id=the_truck,
                               explanation=f"dispatch on {the_truck} but the plan is {m['truck_id']} ({m['manifest_id']})")
        return {"dispatched": False, "exceptions": [exc]}
    order = erp.order(order_ref)
    products = {p["gtin"]: p for p in erp.products()}
    lines, failures = [], []
    for p in pallets(erp, order_ref):
        if p["status"] != "loaded":
            continue
        if _batch_status(erp, p["batch"]) == "hold":
            failures.append(record_exception(erp, type="QUALITY_HOLD", severity="high", order_ref=order_ref,
                                             pallet_id=p["pallet_id"], explanation=f"batch {p['batch']} went on hold "
                                             "before dispatch; the pallet stays off"))
            erp.db.execute("UPDATE si_pallets SET status = 'rejected' WHERE pallet_id = ?", (p["pallet_id"],))
            continue
        erp.db.execute("UPDATE batches SET qty = qty - ? WHERE batch = ?", (p["qty"], p["batch"]))
        erp.db.execute("UPDATE si_pallets SET status = 'dispatched' WHERE pallet_id = ?", (p["pallet_id"],))
        lines.append({"gtin": p["gtin"], "batch": p["batch"], "qty": p["qty"], "pallet_id": p["pallet_id"]})
    erp.db.commit()
    if not lines:
        return {"dispatched": False, "exceptions": failures}

    shipped: dict[str, float] = {}
    for l in lines:
        shipped[l["gtin"]] = shipped.get(l["gtin"], 0) + l["qty"]
    gaps = []
    for line in order["lines"]:
        want = float(line["qty_confirmed"] if line["qty_confirmed"] is not None else line["qty_ordered"] or 0)
        got = shipped.get(line["gtin"], 0)
        if got < want:
            off = [p["pallet_id"] for p in pallets(erp, order_ref) if p["gtin"] == line["gtin"] and p["status"] != "dispatched"]
            held = [b["batch"] for b in batches(erp, line["gtin"], "hold")]
            if off:
                why = f"pallets {', '.join(off)} kept off"
            elif held:
                why = f"quality hold on {', '.join(held)}"
            else:
                why = "not enough released stock to pick"
            gaps.append(f"{products[line['gtin']]['item_code']}: {want - got:g} of {want:g} not shipped ({why})")
    n = len(erp.shipments(order_ref)) + 1
    desadv_ref, ddt_ref = f"DESADV-{order_ref}-{n}", f"DDT-{order_ref}-{n}"
    retailer = erp.retailer(order["buyer_gln"])
    desadv_doc = erp.add_document("DESADV", desadv_ref, build_desadv(
        desadv_ref=desadv_ref, order_ref=order_ref, ship_date=ship_date, buyer_gln=order["buyer_gln"],
        supplier_gln=order["supplier_gln"], delivery_point=(retailer or {}).get("delivery_point"), lines=lines))
    erp.add_document("DDT", ddt_ref, build_ddt(ddt_ref=ddt_ref, desadv_ref=desadv_ref, order_ref=order_ref,
                                               ship_date=ship_date, buyer=retailer, lines=lines, products=products))
    note = "; ".join(gaps) if gaps else None
    erp.save_shipment(desadv_ref=desadv_ref, order_ref=order_ref, ship_date=ship_date, ddt_ref=ddt_ref,
                      lines=[{"gtin": l["gtin"], "batch": l["batch"], "qty": l["qty"]} for l in lines],
                      source_doc=desadv_doc, notes=note)
    notes = dict(order["notes"] or {})
    notes["truck_id"] = the_truck
    notes["manifest_id"] = m["manifest_id"] if m else None
    if gaps:
        notes["fulfilment_gap"] = note
    erp.set_order(order_ref, status="shipped", notes=notes)
    if m:
        _set_manifest(erp, m["manifest_id"], "dispatched", physically_loaded=True, dispatched=True)
    erp.log("code", "shipping.dispatched", order_ref, source_doc=desadv_doc,
            detail={"truck": the_truck, "manifest": m["manifest_id"] if m else None, "short": gaps})
    return {"dispatched": True, "desadv_ref": desadv_ref, "ddt_ref": ddt_ref, "truck_id": the_truck,
            "manifest_id": m["manifest_id"] if m else None, "short": gaps, "exceptions": failures}


def next_day(iso: str) -> str:
    y, mth, d = (int(x) for x in iso.split("-"))
    return (date(y, mth, d) + timedelta(days=1)).isoformat()
