"""Shipping and invoicing row on the shared Mini ERP.

    ingest_confirmed_order()  hand-over 1: the Order row's payload after the person confirmed
    ship_order()              released stock only, first in first out; DESADV + DDT
    record_delivery()         proof of delivery: the signed DDT at the retailer's dock
    invoice_shipment()        the invoice bills what shipped, once; FatturaPA TD01 + INVOIC 380
    reconcile_and_send()      order vs DESADV vs invoice; clean invoices go out, unclear ones wait
    export_for_dispute()      hand-over 2: the catalog shape Dispute's pull_facts reads

This is a lean version of the lane so one order can run end to end inside this
repo. Nicola's v0.5.0 (truck planning, pallet scans, exception cases) does more and
can replace ship_order() when it moves into shipping/.
"""

from __future__ import annotations

from collections import OrderedDict
from decimal import Decimal
from typing import Any

from agent import grok
from agent.checks import unknown_numbers
from core import signoff
from core.erp import Erp
from core.stock import allocate, batches
from shipping.documents import build_ddt, build_desadv, build_invoic_380, build_td01_xml, money
from shipping.reconcile import BILLING_CAUSES, explain, reconcile_documents


class ShippingError(ValueError):
    pass


def _products(erp: Erp) -> dict[str, dict[str, Any]]:
    return {p["gtin"]: p for p in erp.products()}


# ----- hand-over 1 ----------------------------------------------------------

def ingest_confirmed_order(erp: Erp, handoff: dict[str, Any]) -> str:
    """Accept the Order row's hand-over. Only a confirmed order with its ORDRSP gets in."""
    ref = handoff.get("order_number")
    order = erp.order(ref) if ref else None
    if not order:
        raise ShippingError(f"unknown order {ref!r}")
    if order["status"] != "confirmed":
        raise ShippingError(f"order {ref} is {order['status']}, not confirmed")
    if not handoff.get("ordrsp_ref") or handoff["ordrsp_ref"] != order["ordrsp_ref"]:
        raise ShippingError(f"order {ref}: the hand-over has no matching ORDRSP")
    erp_lines = {(l["gtin"], float(l["qty_confirmed"] or l["qty_ordered"] or 0)) for l in order["lines"]}
    handoff_lines = {(l["gtin"], float(l["quantity"] or 0)) for l in handoff.get("lines") or []}
    if erp_lines != handoff_lines:
        raise ShippingError(f"order {ref}: hand-over lines {handoff_lines} differ from the confirmed lines {erp_lines}")
    erp.set_order(ref, status="ready_to_ship")
    erp.log("code", "shipping.ingested", ref, source_doc=order["ordrsp_ref"], detail={"backorders": handoff.get("backorders")})
    return ref


# ----- dispatch -------------------------------------------------------------

def ship_order(erp: Erp, order_ref: str, *, ship_date: str) -> dict[str, Any]:
    order = erp.order(order_ref)
    if not order or order["status"] != "ready_to_ship":
        raise ShippingError(f"order {order_ref} is not ready to ship")
    products = _products(erp)
    retailer = erp.retailer(order["buyer_gln"])
    n = len(erp.shipments(order_ref)) + 1
    desadv_ref, ddt_ref = f"DESADV-{order_ref}-{n}", f"DDT-{order_ref}-{n}"
    lines: list[dict[str, Any]] = []
    gaps: list[str] = []
    for line in order["lines"]:
        want = float(line["qty_confirmed"] if line["qty_confirmed"] is not None else line["qty_ordered"] or 0)
        taken, short = allocate(erp, line["gtin"], want)
        lines.extend({"gtin": line["gtin"], "batch": t["batch"], "qty": t["qty"]} for t in taken)
        if short:
            held = [b["batch"] for b in batches(erp, line["gtin"], "hold")]
            why = f"quality hold on {', '.join(held)}" if held else "no released stock"
            gaps.append(f"{products[line['gtin']]['item_code']}: {short:g} of {want:g} not shipped ({why})")
    if not lines:
        raise ShippingError(f"order {order_ref}: nothing could be shipped ({'; '.join(gaps)})")
    desadv = build_desadv(desadv_ref=desadv_ref, order_ref=order_ref, ship_date=ship_date,
                          buyer_gln=order["buyer_gln"], supplier_gln=order["supplier_gln"],
                          delivery_point=(retailer or {}).get("delivery_point"), lines=lines)
    desadv_doc = erp.add_document("DESADV", desadv_ref, desadv)
    ddt_doc = erp.add_document("DDT", ddt_ref, build_ddt(ddt_ref=ddt_ref, desadv_ref=desadv_ref, order_ref=order_ref,
                                                        ship_date=ship_date, buyer=retailer, lines=lines,
                                                        products=products))
    note = "; ".join(gaps) if gaps else None
    erp.save_shipment(desadv_ref=desadv_ref, order_ref=order_ref, ship_date=ship_date, ddt_ref=ddt_ref,
                      lines=lines, source_doc=desadv_doc, notes=note)
    notes = dict(order["notes"] or {})
    if gaps:
        notes["fulfilment_gap"] = note
    erp.set_order(order_ref, status="shipped", notes=notes)
    erp.log("code", "shipping.dispatched", order_ref, source_doc=desadv_doc,
            detail={"desadv": desadv_ref, "ddt": ddt_ref, "ddt_doc": ddt_doc, "short": gaps})
    return {"desadv_ref": desadv_ref, "ddt_ref": ddt_ref, "lines": lines, "short": gaps}


def record_delivery(erp: Erp, desadv_ref: str, *, signed_by: str, received: dict[str, float] | None = None,
                    note: str | None = None, when: str | None = None) -> str:
    """The retailer signs the DDT at the dock. Stored as proof for any later claim."""
    shipment = erp.shipment(desadv_ref)
    if not shipment:
        raise ShippingError(f"no shipment {desadv_ref}")
    products = _products(erp)
    shipped: dict[str, float] = {}
    for line in shipment["lines"]:
        shipped[line["gtin"]] = shipped.get(line["gtin"], 0) + line["qty"]
    got = received or shipped
    parts = []
    for gtin, qty in shipped.items():
        r = got.get(gtin, qty)
        item = products[gtin]["item_code"]
        parts.append(f"{item} {r:g} received of {qty:g} shipped" if r != qty else f"{item} {qty:g} received")
    reserve = f", with reservation: {note}" if note else ", no notes"
    summary = f"Signed DDT {shipment['ddt_ref']} by {signed_by}{' on ' + when if when else ''}: {'; '.join(parts)}{reserve}"
    doc_id = f"POD-{desadv_ref}"
    erp.add_proof(doc_id=doc_id, order_ref=shipment["order_ref"], kind="pod", ref=shipment["ddt_ref"], summary=summary,
                  at=when)
    erp.log("retailer", "shipping.delivered", shipment["order_ref"], source_doc=doc_id, detail={"received": got, "note": note})
    return doc_id


# ----- invoice --------------------------------------------------------------

def invoice_shipment(erp: Erp, desadv_ref: str, *, invoice_date: str) -> dict[str, Any]:
    """Bill the shipped quantity at the confirmed price. A shipment is invoiced once."""
    shipment = erp.shipment(desadv_ref)
    if not shipment:
        raise ShippingError(f"no shipment {desadv_ref}")
    if any(i["desadv_ref"] == desadv_ref for i in erp.invoices(shipment["order_ref"])):
        raise ShippingError(f"{desadv_ref} is already invoiced")
    order = erp.order(shipment["order_ref"])
    products = _products(erp)
    prices = {l["gtin"]: l["unit_price"] for l in order["lines"]}
    qty_by_gtin: "OrderedDict[str, float]" = OrderedDict()
    for line in shipment["lines"]:
        qty_by_gtin[line["gtin"]] = qty_by_gtin.get(line["gtin"], 0) + line["qty"]
    lines = []
    for gtin, qty in qty_by_gtin.items():
        price = prices.get(gtin)
        if price is None:
            raise ShippingError(f"no confirmed price for {gtin} on {order['order_ref']}: an invoice never guesses a price")
        lines.append({"gtin": gtin, "qty": qty, "unit_price": price, "vat_rate": products[gtin]["vat_rate"]})

    invoice_ref = f"FT-2026/{erp.next_id('invoice', '', 4)}"
    net = sum((money(Decimal(str(l["qty"])) * Decimal(str(l["unit_price"]))) for l in lines), Decimal("0"))
    vat_by_rate: dict[float, Decimal] = {}
    for l in lines:
        vat_by_rate[l["vat_rate"]] = vat_by_rate.get(l["vat_rate"], Decimal("0")) + money(
            Decimal(str(l["qty"])) * Decimal(str(l["unit_price"])))
    vat = sum((money(base * Decimal(str(rate)) / 100) for rate, base in vat_by_rate.items()), Decimal("0"))
    retailer = erp.retailer(order["buyer_gln"]) or {"name": order["buyer_gln"]}
    xml, a38_total = build_td01_xml(invoice_ref=invoice_ref, invoice_date=invoice_date, order_ref=order["order_ref"],
                                    ddt_ref=shipment["ddt_ref"], ship_date=shipment["ship_date"], buyer=retailer,
                                    lines=lines, products=products)
    if a38_total != net + vat:
        raise ShippingError(f"invoice total mismatch: code {net + vat}, a38 {a38_total}")
    edi = build_invoic_380(invoice_ref=invoice_ref, invoice_date=invoice_date, order_ref=order["order_ref"],
                           desadv_ref=desadv_ref, buyer_gln=order["buyer_gln"], supplier_gln=order["supplier_gln"],
                           lines=lines, total_net=net, total_vat=vat, total=net + vat)
    xml_doc = erp.add_document("FatturaPA TD01", invoice_ref, xml)
    edi_doc = erp.add_document("INVOIC 380", invoice_ref, edi)
    erp.save_invoice(invoice_ref=invoice_ref, order_ref=order["order_ref"], desadv_ref=desadv_ref,
                     invoice_date=invoice_date, lines=lines, total_net=float(net), total_vat=float(vat),
                     total=float(net + vat), status="draft", source_doc=xml_doc)
    erp.log("code", "shipping.invoiced", order["order_ref"], source_doc=xml_doc,
            detail={"invoice": invoice_ref, "edi_doc": edi_doc, "net": float(net), "vat": float(vat)})
    return {"invoice_ref": invoice_ref, "net": float(net), "vat": float(vat), "total": float(net + vat),
            "td01_doc": xml_doc, "invoic_doc": edi_doc}


# ----- reconcile, explain, send --------------------------------------------

def _docs_for(erp: Erp, order_ref: str) -> tuple[list[dict], list[dict], list[dict]]:
    order = erp.order(order_ref)
    products = _products(erp)
    po = [{"order_ref": order_ref, "item_code": products[l["gtin"]]["item_code"],
           "quantity": l["qty_confirmed"] if l["qty_confirmed"] is not None else l["qty_ordered"],
           "unit_price": l["unit_price"], "uom": products[l["gtin"]]["uom"]} for l in order["lines"]]
    received = [{"order_ref": s["order_ref"], "item_code": products[l["gtin"]]["item_code"], "quantity": l["qty"],
                 "uom": products[l["gtin"]]["uom"]} for s in erp.shipments(order_ref) for l in s["lines"]]
    invoiced = [{"order_ref": i["order_ref"], "item_code": products[l["gtin"]]["item_code"], "quantity": l["qty"],
                 "unit_price": l["unit_price"], "uom": products[l["gtin"]]["uom"]}
                for i in erp.invoices(order_ref) for l in i["lines"]]
    return po, received, invoiced


def explain_flags(report_text: str, facts_text: str, *, caller: Any = None) -> tuple[str, str]:
    """Grok rewrites the code's explanation for the person; every figure must already be in the facts."""
    if caller is None and not grok.has_key():
        return report_text, "code"
    messages = [
        {"role": "system", "content": (
            "You explain reconciliation flags to the Riso Scotti invoicing desk in two or three short sentences. "
            "Name every cause and its euro amount. Use only figures from the facts. "
            "Return one JSON object: {\"explanation\": string, \"confidence\": number}.")},
        {"role": "user", "content": f"Code findings: {report_text}\n\nFacts: {facts_text}"},
    ]

    def validate(payload: dict[str, Any]) -> list[str]:
        text = str(payload.get("explanation") or "")
        if not text:
            return ["explanation is empty"]
        extra = unknown_numbers(text, report_text + " " + facts_text)
        return [f"figures not in the facts: {sorted(extra)}"] if extra else []

    try:
        payload = grok.chat_json(messages, task="shipping.explain_flags", validate=validate, caller=caller)
    except (grok.GrokAnswerRejected, grok.MissingApiKeyError, RuntimeError):
        return report_text, "code"
    return str(payload["explanation"]), "grok"


def reconcile_and_send(erp: Erp, order_ref: str, *, caller: Any = None) -> dict[str, Any]:
    """Clean invoices go out. A short delivery with a recorded cause goes out too, and is
    followed up. Anything else (a billing error, an unexplained gap) waits for a person."""
    po, received, invoiced = _docs_for(erp, order_ref)
    report = reconcile_documents(po, received, invoiced, products=erp.products())
    code_text = explain(report)
    order = erp.order(order_ref)
    shipments = erp.shipments(order_ref)
    facts_text = "; ".join(f"{s['desadv_ref']} notes: {s['notes'] or 'none'}" for s in shipments)
    pending = [i for i in erp.invoices(order_ref) if i["status"] == "draft"]

    gap_explained = all(s["notes"] for s in shipments) if report.status == "fulfilment_gap" else True
    clear = report.status == "matched" or (report.status == "fulfilment_gap" and gap_explained)
    result: dict[str, Any] = {"report": report.to_dict(), "explanation": code_text, "explained_by": "code"}

    if clear:
        for inv in pending:
            erp.set_invoice_status(inv["invoice_ref"], "sent")
            erp.log("code", "shipping.invoice_sent", order_ref, source_doc=inv["source_doc"],
                    detail={"to": ["retailer (EDI INVOIC)", "SdI (FatturaPA)"], "simulated": True})
        erp.set_order(order_ref, status="invoiced")
        result["status"] = "sent"
        if report.status == "fulfilment_gap":
            result["follow_up"] = (order["notes"] or {}).get("fulfilment_gap")
        erp.log("code", "shipping.reconciled", order_ref, detail=report.to_dict())
        return result

    text, by = explain_flags(code_text, facts_text, caller=caller)
    reasons = []
    billing = sorted(report.causes & BILLING_CAUSES)
    if billing:
        reasons.append("billing error found: " + ", ".join(billing))
    if report.status == "fulfilment_gap" and not gap_explained:
        reasons.append("a short delivery has no recorded cause")
    if any("several orders" in n for n in report.notes):
        reasons.append("a reference matches more than one order")
    case_id = signoff.request(erp, row="shipping", kind="reconcile", subject_ref=order_ref,
                              title=f"Order {order_ref}: invoice held, the documents disagree",
                              proposal={"report": report.to_dict(), "explanation": text, "explained_by": by,
                                        "invoices": [i["invoice_ref"] for i in pending],
                                        "options": ["correct the invoice and reconcile again", "send as is"]},
                              reasons=reasons or ["the documents disagree"])
    erp.log("code", "shipping.held", order_ref, source_doc=case_id, detail=report.to_dict())
    result.update({"status": "awaiting_person", "case_id": case_id, "explanation": text, "explained_by": by})
    return result


# ----- hand-over 2 ----------------------------------------------------------

def export_for_dispute(erp: Erp) -> dict[str, Any]:
    """Everything shipped and invoiced, in the shape of data/disputes/erp/catalog.json."""
    products = _products(erp)
    out: dict[str, list[dict[str, Any]]] = {"orders": [], "desadv": [], "invoices": [], "proofs": []}
    for order in erp.orders():
        if not erp.shipments(order["order_ref"]):
            continue
        retailer = erp.retailer(order["buyer_gln"]) or {}
        date = order["order_date"] or ""
        out["orders"].append({
            "doc_id": f"ORD-{order['order_ref']}", "order_ref": order["order_ref"], "aliases": [],
            "customer": retailer.get("name") or order["buyer_gln"],
            "order_date": f"{date[:4]}-{date[4:6]}-{date[6:8]}" if len(date) == 8 else date,
            "lines": [{"item_code": products[l["gtin"]]["item_code"], "product": products[l["gtin"]]["name"],
                       "quantity": l["qty_confirmed"] if l["qty_confirmed"] is not None else l["qty_ordered"],
                       "unit_price": l["unit_price"], "uom": products[l["gtin"]]["uom"]} for l in order["lines"]],
        })
        for s in erp.shipments(order["order_ref"]):
            merged: dict[str, float] = {}
            for l in s["lines"]:
                merged[l["gtin"]] = merged.get(l["gtin"], 0) + l["qty"]
            out["desadv"].append({
                "doc_id": s["source_doc"], "desadv_ref": s["desadv_ref"], "order_ref": s["order_ref"],
                "ship_date": s["ship_date"],
                "lines": [{"item_code": products[g]["item_code"], "product": products[g]["name"], "quantity": q,
                           "uom": products[g]["uom"]} for g, q in merged.items()],
                "notes": s["notes"] or "",
            })
            out["proofs"].append({"doc_id": f"DDT-DOC-{s['ddt_ref']}", "order_ref": s["order_ref"], "kind": "ddt",
                                  "ref": s["ddt_ref"], "summary": f"DDT {s['ddt_ref']} issued with {s['desadv_ref']}"})
        for inv in erp.invoices(order["order_ref"]):
            ref = inv["invoice_ref"]
            out["invoices"].append({
                "doc_id": inv["source_doc"], "invoice_ref": ref,
                "aliases": [ref.replace("/", "-"), ref.replace("/", "").replace("-", "")],
                "order_ref": inv["order_ref"], "invoice_date": inv["invoice_date"], "currency": "EUR",
                "total": inv["total_net"],
                "lines": [{"item_code": products[l["gtin"]]["item_code"], "product": products[l["gtin"]]["name"],
                           "quantity": l["qty"], "unit_price": l["unit_price"], "uom": products[l["gtin"]]["uom"]}
                          for l in inv["lines"]],
                "notes": f"status {inv['status']}",
            })
        for proof in erp.proofs(order["order_ref"]):
            out["proofs"].append(dict(proof))
    return out
