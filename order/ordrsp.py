"""Emit a minimal EDIFACT-like ORDRSP from a confirmed parsed order."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from order.parser import ParsedOrder


@dataclass
class OrdrspDocument:
    order_number: str
    body: str
    handoff: dict


def build_ordrsp(order: ParsedOrder, *, response_date: str | None = None) -> OrdrspDocument:
    if not order.order_number:
        raise ValueError("Cannot build ORDRSP without order_number")
    today = response_date or date.today().strftime("%Y%m%d")
    segments = [
        "UNH+1+ORDRSP:D:96A:UN'",
        f"BGM+231+{order.order_number}+29'",  # 29 = accepted (demo)
        f"DTM+137:{today}:102'",
        f"RFF+ON:{order.order_number}'",
    ]
    if order.buyer_gln:
        segments.append(f"NAD+BY+{order.buyer_gln}::9'")
    if order.supplier_gln:
        segments.append(f"NAD+SU+{order.supplier_gln}::9'")

    handoff_lines = []
    for idx, line in enumerate(order.lines, start=1):
        n = line.line_no or idx
        gtin = line.gtin or ""
        qty = int(line.quantity) if line.quantity is not None and line.quantity == int(line.quantity) else line.quantity
        segments.append(f"LIN+{n}++{gtin}:EN'")
        segments.append(f"QTY+21:{qty}'")
        if line.unit_price is not None:
            segments.append(f"PRI+AAA:{line.unit_price}:CT'")
        handoff_lines.append(
            {
                "line_no": n,
                "gtin": line.gtin,
                "quantity": line.quantity,
                "unit_price": line.unit_price,
            }
        )

    segments.append("UNS+S'")
    segments.append(f"UNT+{len(segments) + 1}+1'")
    body = "".join(segments)
    handoff = {
        "order_number": order.order_number,
        "buyer_gln": order.buyer_gln,
        "supplier_gln": order.supplier_gln,
        "order_date": order.order_date,
        "lines": handoff_lines,
        "ordrsp": body,
    }
    return OrdrspDocument(order_number=order.order_number, body=body, handoff=handoff)
