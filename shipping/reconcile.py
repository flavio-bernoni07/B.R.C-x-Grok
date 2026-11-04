"""Reconciliation that names every cause, where threeway names one.

threeway (the track baseline) joins on order number + item code exactly and
gives one reason per line. Reading its code we found three blind spots:

1. a short delivery that was invoiced correctly comes out as "matched";
2. a price error behind a quantity problem is never named;
3. a typo in an order number turns into two false exceptions.

This module keeps threeway's join, then:
- reads references and item codes without punctuation, and links a reference
  that is one character away from exactly one order (and shares its items);
- converts cartons and units with the product's case size;
- compares the order, the despatch advice and the invoice separately, and lists
  every cause on a line, each with its euro amount.

`reconcile_documents()` is pure (no database); `bench/` scores it against threeway.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

BILLING_CAUSES = {"overbilled", "underbilled", "price_difference", "orphan_invoice", "uom_unknown"}
FULFILMENT_CAUSES = {"short_delivery", "over_delivery", "not_shipped", "orphan_receipt"}
PRICE_EPS = 0.005


def norm(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())


def _edit_distance(a: str, b: str) -> int:
    if abs(len(a) - len(b)) > 1:
        return 2
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


@dataclass
class Cause:
    code: str
    qty: float
    eur: float
    text: str


@dataclass
class LineResult:
    order_ref: str
    item_code: str
    ordered: float
    received: float
    invoiced: float
    po_price: float | None
    invoice_price: float | None
    status: str  # matched | fulfilment_gap | exception
    causes: list[Cause] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["causes"] = [asdict(c) for c in self.causes]
        return data


@dataclass
class Report:
    lines: list[LineResult]
    notes: list[str]

    @property
    def status(self) -> str:
        statuses = {line.status for line in self.lines}
        if "exception" in statuses:
            return "exception"
        if "fulfilment_gap" in statuses:
            return "fulfilment_gap"
        return "matched"

    @property
    def causes(self) -> set[str]:
        return {c.code for line in self.lines for c in line.causes}

    def to_dict(self) -> dict[str, Any]:
        return {"status": self.status, "causes": sorted(self.causes), "notes": self.notes,
                "lines": [line.to_dict() for line in self.lines]}


def _product_index(products: list[dict[str, Any]] | None) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for product in products or []:
        for key in (product.get("item_code"), product.get("gtin")):
            if key:
                index[norm(key)] = product
    return index


def _to_base(qty: float, price: float | None, uom: str | None, product: dict[str, Any] | None) -> tuple[float, float | None, bool]:
    """Convert a line to the product's own unit. Returns (qty, price, ok)."""
    if not uom or not product or norm(uom) == norm(product.get("uom")):
        return qty, price, True
    per_case = float(product.get("units_per_case") or 1)
    base = norm(product.get("uom"))
    unit = norm(uom)
    if base == "CTN" and unit in {"EA", "PCE", "PZ", "NR"} and per_case > 1:
        return qty / per_case, (price * per_case if price is not None else None), True
    if base in {"EA", "PCE"} and unit == "CTN" and per_case > 1:
        return qty * per_case, (price / per_case if price is not None else None), True
    return qty, price, False


def reconcile_documents(
    po_lines: list[dict[str, Any]],
    received_lines: list[dict[str, Any]],
    invoice_lines: list[dict[str, Any]],
    *,
    products: list[dict[str, Any]] | None = None,
    delivery_tolerance_pct: float = 2.0,
    delivery_tolerance_units: float = 2.0,
) -> Report:
    """Lines are dicts with order_ref, item_code, quantity, and unit_price / uom when known.

    Delivery tolerance follows the contract (§7: ±2% or 2 units, whichever is greater).
    An invoice must match what was received exactly: there is no billing tolerance.
    """
    index = _product_index(products)
    notes: list[str] = []
    po_refs = {norm(l["order_ref"]): l["order_ref"] for l in po_lines}
    po_items: dict[str, set[str]] = {}

    def item_key(line: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
        product = index.get(norm(line.get("item_code")))
        return (norm(product["item_code"]) if product else norm(line.get("item_code"))), product

    for line in po_lines:
        po_items.setdefault(norm(line["order_ref"]), set()).add(item_key(line)[0])

    def resolve_ref(raw: str, item: str) -> str:
        key = norm(raw)
        if key in po_refs:
            return key
        near = [ref for ref in po_refs if _edit_distance(key, ref) <= 1 and item in po_items.get(ref, set())]
        if len(near) == 1:
            notes.append(f"Reference {raw} read as {po_refs[near[0]]} (one character apart, same item).")
            return near[0]
        if len(near) > 1:
            notes.append(f"Reference {raw} is one character from several orders; left unmatched for a person.")
        return key

    agg: dict[tuple[str, str], dict[str, Any]] = {}

    def bucket(ref: str, item: str, display_ref: str, display_item: str) -> dict[str, Any]:
        return agg.setdefault((ref, item), {"order_ref": display_ref, "item_code": display_item, "ordered": 0.0,
                                            "received": 0.0, "invoiced": 0.0, "po_value": 0.0, "inv_value": 0.0,
                                            "in_po": False, "uom_ok": True})

    for line in po_lines:
        item, product = item_key(line)
        qty, price, ok = _to_base(float(line.get("quantity") or 0), line.get("unit_price"), line.get("uom"), product)
        b = bucket(norm(line["order_ref"]), item, line["order_ref"], product["item_code"] if product else line["item_code"])
        b["ordered"] += qty
        b["po_value"] += qty * float(price or 0)
        b["in_po"] = True
        b["uom_ok"] &= ok
    for kind, lines in (("received", received_lines), ("invoiced", invoice_lines)):
        for line in lines:
            item, product = item_key(line)
            ref = resolve_ref(line["order_ref"], item)
            qty, price, ok = _to_base(float(line.get("quantity") or 0), line.get("unit_price"), line.get("uom"), product)
            b = bucket(ref, item, po_refs.get(ref, line["order_ref"]), product["item_code"] if product else line["item_code"])
            b[kind] += qty
            if kind == "invoiced":
                b["inv_value"] += qty * float(price or 0)
            b["uom_ok"] &= ok

    results: list[LineResult] = []
    for (_ref, _item), b in sorted(agg.items()):
        ordered, received, invoiced = b["ordered"], b["received"], b["invoiced"]
        po_price = b["po_value"] / ordered if ordered else None
        inv_price = b["inv_value"] / invoiced if invoiced else None
        causes: list[Cause] = []
        if not b["uom_ok"]:
            causes.append(Cause("uom_unknown", 0, 0, "units differ and the product has no case size to convert"))
        if not b["in_po"]:
            if invoiced:
                causes.append(Cause("orphan_invoice", invoiced, round(b["inv_value"], 2),
                                    f"invoiced {invoiced:g} with no matching order line"))
            elif received:
                causes.append(Cause("orphan_receipt", received, 0, f"received {received:g} with no matching order line"))
        else:
            tol = max(delivery_tolerance_units, ordered * delivery_tolerance_pct / 100)
            price = po_price or 0
            if received == 0 and invoiced == 0:
                causes.append(Cause("not_shipped", ordered, round(ordered * price, 2), "nothing shipped or invoiced yet"))
            if invoiced > received:
                q = invoiced - received
                causes.append(Cause("overbilled", q, round(q * (inv_price or price), 2),
                                    f"invoiced {invoiced:g} but only {received:g} were delivered"))
            elif invoiced < received and invoiced > 0:
                q = received - invoiced
                causes.append(Cause("underbilled", q, round(q * price, 2), f"delivered {received:g} but invoiced {invoiced:g}"))
            if 0 < received < ordered - tol:
                q = ordered - received
                causes.append(Cause("short_delivery", q, round(q * price, 2),
                                    f"delivered {received:g} of {ordered:g} ordered"))
            elif received > ordered + tol:
                q = received - ordered
                causes.append(Cause("over_delivery", q, round(q * price, 2),
                                    f"delivered {received:g} against {ordered:g} ordered"))
            if po_price is not None and inv_price is not None and abs(inv_price - po_price) > PRICE_EPS:
                causes.append(Cause("price_difference", invoiced, round((inv_price - po_price) * invoiced, 2),
                                    f"invoice price €{inv_price:.2f} against order price €{po_price:.2f}"))
        codes = {c.code for c in causes}
        if not codes:
            status = "matched"
        elif codes <= {"short_delivery"}:
            status = "fulfilment_gap"
        else:
            status = "exception"
        results.append(LineResult(order_ref=b["order_ref"], item_code=b["item_code"], ordered=ordered,
                                  received=received, invoiced=invoiced,
                                  po_price=round(po_price, 4) if po_price is not None else None,
                                  invoice_price=round(inv_price, 4) if inv_price is not None else None,
                                  status=status, causes=causes))
    return Report(lines=results, notes=notes)


def explain(report: Report) -> str:
    """Plain explanation written by code; Grok may rephrase it, never change a figure."""
    if report.status == "matched":
        return "Order, despatch advice and invoice agree on every line."
    parts = []
    for line in report.lines:
        for cause in line.causes:
            parts.append(f"{line.order_ref} {line.item_code}: {cause.text} (€{cause.eur:.2f})")
    return "; ".join(parts) + ("." if parts else "")
