"""The retailer's receiving advice (EANCOM RECADV): what the warehouse accepted.

A gap between the DESADV and the RECADV is known here, before any claim email:
it is stored as proof for Dispute and opened as a RECEIVING_GAP exception, so
the account manager can ask for the signed DDT while the truck is still fresh.
"""

from __future__ import annotations

from typing import Any

from core.erp import Erp
from shipping.warehouse import record_exception


def parse_recadv(text: str) -> dict[str, Any]:
    """Read BGM (number), DTM+50 (receipt date), RFF+DQ (DESADV), RFF+ON (order),
    LIN (GTIN) with QTY+194 (accepted), QTY+195 (refused) or QTY+48 (received)."""
    out: dict[str, Any] = {"recadv_ref": None, "date": None, "desadv_ref": None, "order_ref": None, "lines": []}
    line: dict[str, Any] | None = None
    for raw in text.replace("\n", "").split("'"):
        seg = raw.strip()
        if not seg:
            continue
        parts = seg.split("+")
        tag = parts[0]
        if tag == "BGM" and len(parts) > 2:
            out["recadv_ref"] = parts[2]
        elif tag == "DTM" and len(parts) > 1 and parts[1].startswith("50:"):
            d = parts[1].split(":")[1]
            out["date"] = f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) >= 8 else d
        elif tag == "RFF" and len(parts) > 1:
            qual, _, value = parts[1].partition(":")
            if qual in {"DQ", "AAK"}:
                out["desadv_ref"] = value
            elif qual == "ON":
                out["order_ref"] = value
        elif tag == "LIN" and len(parts) > 3:
            line = {"gtin": parts[3].split(":")[0], "accepted": None, "refused": 0.0, "received": None}
            out["lines"].append(line)
        elif tag == "QTY" and line is not None and len(parts) > 1:
            qual, _, value = parts[1].partition(":")
            qty = float(value.split(":")[0])
            if qual == "194":
                line["accepted"] = qty
            elif qual == "195":
                line["refused"] = qty
            elif qual == "48":
                line["received"] = qty
    for l in out["lines"]:
        if l["accepted"] is None:
            l["accepted"] = (l["received"] or 0.0) - l["refused"]
    if not out["desadv_ref"] or not out["lines"]:
        raise ValueError("RECADV without a DESADV reference or lines")
    return out


def record_receiving_advice(erp: Erp, text: str) -> dict[str, Any]:
    advice = parse_recadv(text)
    shipment = erp.shipment(advice["desadv_ref"])
    if not shipment:
        raise ValueError(f"RECADV {advice['recadv_ref']} names {advice['desadv_ref']}, which we never shipped")
    order = erp.order(shipment["order_ref"])
    prices = {l["gtin"]: l["unit_price"] for l in order["lines"]}
    shipped: dict[str, float] = {}
    for l in shipment["lines"]:
        shipped[l["gtin"]] = shipped.get(l["gtin"], 0.0) + l["qty"]
    doc_id = erp.add_document("RECADV", advice["recadv_ref"], text)
    erp.log("retailer", "shipping.recadv_received", shipment["order_ref"], source_doc=doc_id, detail=advice)
    gaps = []
    for l in advice["lines"]:
        sent = shipped.get(l["gtin"], 0.0)
        if l["accepted"] < sent:
            item = (erp.product(gtin=l["gtin"]) or {}).get("item_code", l["gtin"])
            gaps.append({"gtin": l["gtin"], "item_code": item, "shipped": sent, "accepted": l["accepted"],
                         "gap": sent - l["accepted"], "eur": round((sent - l["accepted"]) * (prices.get(l["gtin"]) or 0), 2)})
    parts = [f"{g['item_code']} {g['accepted']:g} accepted of {g['shipped']:g} shipped" for g in gaps] or ["all accepted"]
    erp.add_proof(doc_id=f"RECADV-{advice['recadv_ref']}", order_ref=shipment["order_ref"], kind="recadv",
                  ref=advice["recadv_ref"], summary=f"RECADV {advice['recadv_ref']} for {advice['desadv_ref']}: "
                  + "; ".join(parts), at=advice["date"])
    exceptions = []
    if gaps:
        exceptions.append(record_exception(
            erp, type="RECEIVING_GAP", severity="medium", order_ref=shipment["order_ref"],
            shipment_ref=advice["desadv_ref"], explanation="; ".join(
                f"{g['item_code']}: retailer accepted {g['accepted']:g} of {g['shipped']:g} shipped" for g in gaps),
            evidence={"recadv": advice, "recadv_doc": doc_id}, financial_impact_eur=sum(g["eur"] for g in gaps)))
    return {"recadv_ref": advice["recadv_ref"], "doc_id": doc_id, "gaps": gaps, "exceptions": exceptions}
