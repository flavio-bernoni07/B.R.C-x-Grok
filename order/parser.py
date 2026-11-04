"""Parse EDIFACT-like ORDERS messages into structured fields + parse_flags.

Handles noisy whitespace/indent. Ambiguous quantities (IT thousands vs decimals)
and missing required segments raise flags for Grokbot — they do not silently pass.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


REQUIRED_SEGMENTS = ("BGM", "DTM", "NAD+BY", "NAD+SU", "LIN", "QTY")


@dataclass
class ParseFlag:
    code: str
    message: str
    segment: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class OrderLine:
    line_no: int | None
    gtin: str | None
    quantity: float | None
    quantity_raw: str | None
    unit_price: float | None
    unit_price_raw: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ParsedOrder:
    order_number: str | None
    order_date: str | None  # YYYYMMDD when clear
    buyer_gln: str | None
    supplier_gln: str | None
    lines: list[OrderLine] = field(default_factory=list)
    message_type: str | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["lines"] = [line.to_dict() for line in self.lines]
        return data


@dataclass
class ParseResult:
    order: ParsedOrder
    flags: list[ParseFlag]
    normalized_edi: str
    raw_edi: str

    @property
    def ok(self) -> bool:
        return len(self.flags) == 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "order": self.order.to_dict(),
            "flags": [f.to_dict() for f in self.flags],
            "normalized_edi": self.normalized_edi,
        }


def load_edi_file(path: Path | str) -> str:
    return Path(path).read_text(encoding="utf-8")


def normalize_edi_text(raw: str) -> str:
    """Strip indent/blank lines; keep segment terminators."""
    parts: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if stripped:
            parts.append(stripped)
    text = "".join(parts) if parts else raw.strip()
    # Ensure segments are separated for scanning if file used newlines without glue
    if "'" in text and "\n" not in raw:
        return text
    # Re-join already-stripped segments with nothing between (EDIFACT continuous)
    return "".join(parts)


def _split_segments(normalized: str) -> list[str]:
    chunks = [c.strip() for c in normalized.split("'") if c.strip()]
    return chunks


def _parse_quantity_token(token: str) -> tuple[float | None, list[ParseFlag]]:
    """Parse QTY value; flag Italian-style thousands vs ambiguous dots."""
    flags: list[ParseFlag] = []
    raw = token.strip()
    if not raw:
        flags.append(ParseFlag("qty_empty", "Empty quantity value", "QTY"))
        return None, flags

    # Plain integer / decimal with dot as decimal separator and no thousands
    if re.fullmatch(r"\d+", raw):
        return float(raw), flags
    if re.fullmatch(r"\d+\.\d{1,2}", raw):
        return float(raw), flags
    if re.fullmatch(r"\d+,\d{1,2}", raw):
        return float(raw.replace(",", ".")), flags

    # Italian thousands: 20.000 or 20.000,50
    if re.fullmatch(r"\d{1,3}(\.\d{3})+(,\d+)?", raw):
        flags.append(
            ParseFlag(
                "qty_ambiguous_it_thousands",
                f"Quantity '{raw}' looks like IT thousands grouping; needs Grokbot confirm",
                "QTY",
            )
        )
        normalized = raw.replace(".", "")
        if "," in normalized:
            normalized = normalized.replace(",", ".")
        try:
            return float(normalized), flags
        except ValueError:
            flags.append(ParseFlag("qty_unparseable", f"Cannot parse quantity '{raw}'", "QTY"))
            return None, flags

    # Ambiguous single-dot with 3 fractional digits: could be 20.000 units
    if re.fullmatch(r"\d+\.\d{3}", raw):
        flags.append(
            ParseFlag(
                "qty_ambiguous_dot",
                f"Quantity '{raw}' has three digits after dot (thousands vs decimal?)",
                "QTY",
            )
        )
        # Prefer thousands interpretation for ORDERS demo volumes, but still flag
        try:
            return float(raw.replace(".", "")), flags
        except ValueError:
            return None, flags

    flags.append(ParseFlag("qty_unparseable", f"Unrecognized quantity format '{raw}'", "QTY"))
    return None, flags


def _parse_price_token(token: str) -> tuple[float | None, list[ParseFlag]]:
    raw = token.strip().replace(",", ".")
    flags: list[ParseFlag] = []
    try:
        return float(raw), flags
    except ValueError:
        flags.append(ParseFlag("pri_unparseable", f"Unrecognized price '{token}'", "PRI"))
        return None, flags


def _elements(segment: str) -> list[str]:
    return segment.split("+")


def parse_orders_edi(raw: str) -> ParseResult:
    flags: list[ParseFlag] = []
    normalized = normalize_edi_text(raw)
    segments = _split_segments(normalized)

    if not segments:
        flags.append(ParseFlag("empty_message", "EDI message is empty"))
        return ParseResult(
            order=ParsedOrder(None, None, None, None, []),
            flags=flags,
            normalized_edi=normalized,
            raw_edi=raw,
        )

    order = ParsedOrder(
        order_number=None,
        order_date=None,
        buyer_gln=None,
        supplier_gln=None,
        lines=[],
        message_type=None,
    )

    seen: set[str] = set()
    current_line: OrderLine | None = None

    for seg in segments:
        tag = _elements(seg)[0]
        els = _elements(seg)

        if tag == "UNH":
            # UNH+1+ORDERS:D:96A:UN
            if len(els) > 2:
                order.message_type = els[2].split(":")[0]
                if order.message_type and order.message_type != "ORDERS":
                    flags.append(
                        ParseFlag(
                            "unexpected_message_type",
                            f"Expected ORDERS, got {order.message_type}",
                            "UNH",
                        )
                    )
            seen.add("UNH")

        elif tag == "BGM":
            seen.add("BGM")
            # BGM+220+ESS001+9
            if len(els) >= 3 and els[2]:
                order.order_number = els[2]
            else:
                flags.append(ParseFlag("bgm_missing_id", "BGM without order number", "BGM"))

        elif tag == "DTM":
            seen.add("DTM")
            # DTM+137:20261104:102
            composite = els[1] if len(els) > 1 else ""
            parts = composite.split(":")
            if len(parts) >= 2:
                date_raw = parts[1]
                if re.fullmatch(r"\d{8}", date_raw):
                    order.order_date = date_raw
                else:
                    flags.append(
                        ParseFlag(
                            "dtm_bad_format",
                            f"DTM date '{date_raw}' is not YYYYMMDD",
                            "DTM",
                        )
                    )
                    order.order_date = date_raw  # keep for Grokbot
            else:
                flags.append(ParseFlag("dtm_incomplete", "DTM segment incomplete", "DTM"))

        elif tag == "NAD":
            # NAD+BY+BUYER001::9
            party = els[1] if len(els) > 1 else ""
            code = els[2].split(":")[0] if len(els) > 2 else ""
            if party == "BY":
                seen.add("NAD+BY")
                order.buyer_gln = code or None
                if not code:
                    flags.append(ParseFlag("nad_by_missing", "NAD+BY without code", "NAD+BY"))
            elif party == "SU":
                seen.add("NAD+SU")
                order.supplier_gln = code or None
                if not code:
                    flags.append(ParseFlag("nad_su_missing", "NAD+SU without code", "NAD+SU"))

        elif tag == "LIN":
            if current_line is not None:
                order.lines.append(current_line)
            seen.add("LIN")
            line_no = None
            if len(els) > 1 and els[1].isdigit():
                line_no = int(els[1])
            gtin = None
            # LIN+1++8000000000000:EN
            if len(els) > 3 and els[3]:
                gtin = els[3].split(":")[0]
            if not gtin:
                flags.append(ParseFlag("lin_missing_gtin", "LIN without GTIN", "LIN"))
            elif not re.fullmatch(r"\d{8,14}", gtin):
                flags.append(
                    ParseFlag("lin_gtin_malformed", f"GTIN '{gtin}' looks malformed", "LIN")
                )
            current_line = OrderLine(
                line_no=line_no,
                gtin=gtin,
                quantity=None,
                quantity_raw=None,
                unit_price=None,
                unit_price_raw=None,
            )

        elif tag == "QTY":
            seen.add("QTY")
            composite = els[1] if len(els) > 1 else ""
            parts = composite.split(":")
            qty_raw = parts[1] if len(parts) > 1 else (parts[0] if parts else "")
            qty, qty_flags = _parse_quantity_token(qty_raw)
            flags.extend(qty_flags)
            if current_line is None:
                flags.append(ParseFlag("qty_without_lin", "QTY before LIN", "QTY"))
                current_line = OrderLine(None, None, qty, qty_raw, None, None)
            else:
                current_line.quantity = qty
                current_line.quantity_raw = qty_raw

        elif tag == "PRI":
            # PRI+AAA:1.85:CT
            composite = els[1] if len(els) > 1 else ""
            parts = composite.split(":")
            price_raw = parts[1] if len(parts) > 1 else ""
            price, price_flags = _parse_price_token(price_raw) if price_raw else (None, [])
            flags.extend(price_flags)
            if current_line is None:
                flags.append(ParseFlag("pri_without_lin", "PRI before LIN", "PRI"))
            else:
                current_line.unit_price = price
                current_line.unit_price_raw = price_raw or None

    if current_line is not None:
        order.lines.append(current_line)

    for req in REQUIRED_SEGMENTS:
        if req not in seen:
            flags.append(ParseFlag("missing_segment", f"Required segment {req} missing", req))

    if not order.lines:
        flags.append(ParseFlag("no_lines", "No order lines parsed"))

    return ParseResult(
        order=order,
        flags=flags,
        normalized_edi=normalized if normalized.endswith("'") else normalized + ("'" if segments else ""),
        raw_edi=raw,
    )


def parse_orders_file(path: Path | str) -> ParseResult:
    return parse_orders_edi(load_edi_file(path))
