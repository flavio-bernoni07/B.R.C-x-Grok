"""Vendored from https://github.com/Bhavya-Dhoot/threeway (MIT) — src/threeway/core.py.

Pure reconciliation logic, kept free of I/O so the matching/status rules can be
unit tested without touching the filesystem and reused by any future front end (CLI, API, ...).

See dispute/THREEWAY_LICENSE.txt. Prefer this vendored copy over a live pip install
so Dispute CI needs no network and matches the hackathon threeway baseline.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Dict, Optional, Tuple, TypedDict, TypeVar, Union, cast

ZERO = Decimal("0")

_T = TypeVar("_T")

Key = Tuple[str, str]
UomFactor = Union[Decimal, int, float, str]
UomRule = Tuple[Optional[str], Optional[UomFactor]]
UomByKey = Dict[Key, Optional[str]]
DateByKey = Dict[Key, Optional[date]]


class NormUomMap(TypedDict):
    """Internal shape `_normalize_uom_map` reduces a user-supplied uom map to:
    global rules and per-item rules, both keyed by upper-cased unit."""

    global_: Dict[str, UomRule]
    items: Dict[str, Dict[str, UomRule]]


DEFAULT_QTY_TOLERANCE = Decimal("2")
DEFAULT_VALUE_TOLERANCE = Decimal("1.00")
DEFAULT_PCT_TOLERANCE = Decimal("0.5")
DEFAULT_CUTOFF_DAYS = 0

ORPHAN_REASON = "Receipt or invoice with no matching purchase order line"
UOM_MISMATCH_REASON = "Units differ and no conversion rule applies"
TIMING_REASON = "Timing difference within the cut-off window"


def _key(po_number: str, item_code: str) -> Key:
    return (po_number.strip().upper(), item_code.strip().upper())


def _last_non_null(current: Optional[_T], new: Optional[_T]) -> Optional[_T]:
    return new if new is not None else current


@dataclass(frozen=True)
class RawLine:
    """One parsed CSV row, already Decimal-typed. `price` is None when the source
    column was blank, which is meaningful (e.g. no invoice price recorded yet).
    `uom` and `date` are None when the source file carries no such column, or the
    cell was blank - both are optional extras, not required for a line to reconcile.
    """

    po_number: str
    item_code: str
    quantity: Decimal
    price: Optional[Decimal] = None
    uom: Optional[str] = None
    date: Optional[date] = None


@dataclass(frozen=True)
class LineResult:
    po_number: str
    item_code: str
    ordered: Decimal
    po_price: Decimal
    received: Decimal
    invoiced: Decimal
    invoice_price: Decimal
    expected_value: Decimal
    invoiced_value: Decimal
    qty_variance: Decimal
    value_variance: Decimal
    status: str
    reason: str
    uom: Optional[str] = None
    uom_conversion_applied: bool = False
    po_date: Optional[date] = None
    received_date: Optional[date] = None
    invoice_date: Optional[date] = None
    timing_gap_days: Optional[int] = None


@dataclass(frozen=True)
class ReconcileResult:
    lines: list[LineResult]
    warnings: list[str]
    as_of: Optional[date] = None
    cutoff_days: int = DEFAULT_CUTOFF_DAYS


def _aggregate_po(
    po_rows: list[RawLine],
) -> Tuple[Dict[Key, Tuple[Decimal, Optional[Decimal]]], UomByKey, DateByKey, list[str]]:
    """Sum ordered qty per key; keep the last non-null price, uom and date. A key
    seen more than once is a data smell worth flagging, not an error - PO
    amendments do happen."""
    totals: Dict[Key, Tuple[Decimal, Optional[Decimal]]] = {}
    uoms: UomByKey = {}
    dates: DateByKey = {}
    counts: Dict[Key, int] = {}
    warnings: list[str] = []
    for row in po_rows:
        key = _key(row.po_number, row.item_code)
        ordered, price = totals.get(key, (ZERO, None))
        ordered += row.quantity
        if row.price is not None:
            price = row.price
        totals[key] = (ordered, price)
        uoms[key] = _last_non_null(uoms.get(key), row.uom)
        dates[key] = _last_non_null(dates.get(key), row.date)
        counts[key] = counts.get(key, 0) + 1
    for key, count in counts.items():
        if count > 1:
            warnings.append(
                f"Duplicate PO line for {key[0]}/{key[1]}: quantities summed, using last price"
            )
    return totals, uoms, dates, warnings


def _aggregate_qty(rows: list[RawLine]) -> Tuple[Dict[Key, Decimal], UomByKey, DateByKey]:
    totals: Dict[Key, Decimal] = {}
    uoms: UomByKey = {}
    dates: DateByKey = {}
    for row in rows:
        key = _key(row.po_number, row.item_code)
        totals[key] = totals.get(key, ZERO) + row.quantity
        uoms[key] = _last_non_null(uoms.get(key), row.uom)
        dates[key] = _last_non_null(dates.get(key), row.date)
    return totals, uoms, dates


def _aggregate_qty_and_price(
    rows: list[RawLine],
) -> Tuple[Dict[Key, Decimal], Dict[Key, Decimal], UomByKey, DateByKey]:
    qty_totals: Dict[Key, Decimal] = {}
    prices: Dict[Key, Decimal] = {}
    uoms: UomByKey = {}
    dates: DateByKey = {}
    for row in rows:
        key = _key(row.po_number, row.item_code)
        qty_totals[key] = qty_totals.get(key, ZERO) + row.quantity
        if row.price is not None:
            prices[key] = row.price
        uoms[key] = _last_non_null(uoms.get(key), row.uom)
        dates[key] = _last_non_null(dates.get(key), row.date)
    return qty_totals, prices, uoms, dates


def _filter_as_of(rows: list[RawLine], as_of: Optional[date]) -> list[RawLine]:
    """Drop rows dated after `as_of`. A row with no date column, or a blank cell,
    has nothing to filter on and is always kept."""
    if as_of is None:
        return rows
    return [row for row in rows if row.date is None or row.date <= as_of]


def _normalize_unit(unit: Optional[str]) -> Optional[str]:
    if unit is None:
        return None
    cleaned = unit.strip()
    return cleaned.upper() if cleaned else None


def _normalize_uom_map(uom_map: Optional[Dict[str, object]]) -> NormUomMap:
    """Reshape a user-supplied uom map into {"global": {UNIT: (target, factor)},
    "items": {ITEM: {UNIT: (target, factor)}}} with unit and item keys upper-cased,
    so lookups are a single case-insensitive dict access."""

    def norm_rules(rules: object) -> Dict[str, UomRule]:
        out: Dict[str, UomRule] = {}
        # `rules` is user-supplied and only loosely shaped; cast (rather than
        # narrow) so a non-dict truthy value still raises AttributeError below,
        # exactly as it did before typing was added.
        mapping = cast(Dict[str, object], rules or {})
        for unit, rule in mapping.items():
            norm_unit = _normalize_unit(unit)
            if norm_unit is None or not isinstance(rule, dict):
                continue
            out[norm_unit] = (rule.get("unit"), rule.get("factor"))
        return out

    if not uom_map:
        return {"global_": {}, "items": {}}

    global_rules = norm_rules(uom_map.get("global"))
    items: Dict[str, Dict[str, UomRule]] = {}
    for item_code, rules in cast(Dict[str, object], uom_map.get("items") or {}).items():
        items[item_code.strip().upper()] = norm_rules(rules)
    return {"global_": global_rules, "items": items}


def _uom_rule(norm_map: NormUomMap, item_code: str, unit: Optional[str]) -> Optional[UomRule]:
    """Look up the conversion rule for `unit` on `item_code`: item-specific rules
    win over global ones. Returns (target_unit, factor) or None if uncovered."""
    norm_unit = _normalize_unit(unit)
    if norm_unit is None:
        return None
    norm_item = item_code.strip().upper()
    item_rules = norm_map["items"].get(norm_item, {})
    if norm_unit in item_rules:
        return item_rules[norm_unit]
    return norm_map["global_"].get(norm_unit)


def _convert_to_base(
    quantity: Decimal,
    source_uom: Optional[str],
    base_uom: Optional[str],
    item_code: str,
    norm_map: NormUomMap,
) -> tuple[Decimal, bool, bool]:
    """Convert `quantity` from `source_uom` into `base_uom`. Returns (quantity,
    applied, covered): `applied` is True only when a real conversion happened,
    `covered` is False when the units differ and no rule bridges them - the
    quantity comes back unconverted in that case, for the caller to flag."""
    norm_source = _normalize_unit(source_uom)
    norm_base = _normalize_unit(base_uom)
    if norm_source is None or norm_base is None or norm_source == norm_base:
        return quantity, False, True

    rule = _uom_rule(norm_map, item_code, source_uom)
    if rule is None:
        return quantity, False, False
    target_unit, factor = rule
    if _normalize_unit(target_unit) != norm_base or factor is None:
        return quantity, False, False
    # Factors may arrive as plain str/int/float (a hand-built map, or JSON
    # loaded without the Decimal-safe hooks) as well as Decimal (a map loaded
    # via config.py); route everything through str() so the result is exact
    # either way and never touches a binary float.
    if not isinstance(factor, Decimal):
        factor = Decimal(str(factor))
    return quantity * factor, True, True


def _base_uom(
    po_uom: Optional[str], grn_uom: Optional[str], invoice_uom: Optional[str]
) -> Optional[str]:
    """Pick which of the three files' units is 'the base' to convert the others
    into. Two documents agreeing on a unit outvotes the third (e.g. a PO written
    in cases against a GRN and invoice both in eaches means eaches is the base);
    a three-way tie or a lone unit falls back to PO, then GRN, then invoice."""
    candidates = [uom for uom in (po_uom, grn_uom, invoice_uom) if uom is not None]
    if not candidates:
        return None
    counts: Dict[Optional[str], int] = {}
    for uom in candidates:
        norm = _normalize_unit(uom)
        counts[norm] = counts.get(norm, 0) + 1
    best_count = max(counts.values())
    for uom in candidates:
        if counts[_normalize_unit(uom)] == best_count:
            return uom
    return candidates[0]  # unreachable, kept for clarity


def _gap_days(first: Optional[date], second: Optional[date]) -> Optional[int]:
    if first is None or second is None:
        return None
    return abs((first - second).days)


def _evaluate(
    ordered: Decimal,
    po_price: Decimal,
    received: Decimal,
    invoiced: Decimal,
    invoice_price: Decimal,
    qty_tolerance: Decimal,
    value_tolerance: Decimal,
    pct_tolerance: Decimal,
    orphan: bool,
) -> tuple[str, str, Decimal, Decimal, Decimal, Decimal]:
    expected_value = received * po_price
    invoiced_value = invoiced * invoice_price
    qty_variance = invoiced - received
    value_variance = invoiced_value - expected_value

    if orphan:
        return (
            "exception",
            ORPHAN_REASON,
            expected_value,
            invoiced_value,
            qty_variance,
            value_variance,
        )

    if received == ZERO and invoiced == ZERO:
        status = "not_started"
    elif abs(qty_variance) <= qty_tolerance and abs(value_variance) <= value_tolerance:
        status = "matched"
    elif abs(qty_variance) <= qty_tolerance * 2 and abs(value_variance) <= value_tolerance * 3:
        status = "check"
    else:
        status = "exception"

    if status == "matched":
        reason = ""
    elif received == ZERO and invoiced > ZERO:
        reason = "Invoiced but nothing received"
    elif received == ZERO and invoiced == ZERO:
        reason = "No receipt and no invoice yet"
    elif invoiced > received:
        reason = "Billed for more than was received"
    elif received > ordered:
        reason = "Received more than was ordered"
    elif received < ordered:
        reason = "Short delivery against the order"
    elif abs(invoice_price - po_price) > po_price * pct_tolerance / Decimal(100):
        reason = "Invoice price differs from the PO price"
    else:
        reason = "Value gap with matching quantities"

    return status, reason, expected_value, invoiced_value, qty_variance, value_variance


def reconcile(
    po_rows: list[RawLine],
    grn_rows: list[RawLine],
    invoice_rows: list[RawLine],
    qty_tolerance: Decimal = DEFAULT_QTY_TOLERANCE,
    value_tolerance: Decimal = DEFAULT_VALUE_TOLERANCE,
    pct_tolerance: Decimal = DEFAULT_PCT_TOLERANCE,
    uom_map: Optional[Dict[str, object]] = None,
    as_of: Optional[date] = None,
    cutoff_days: int = DEFAULT_CUTOFF_DAYS,
) -> ReconcileResult:
    po_rows = _filter_as_of(po_rows, as_of)
    grn_rows = _filter_as_of(grn_rows, as_of)
    invoice_rows = _filter_as_of(invoice_rows, as_of)

    po_totals, po_uoms, po_dates, warnings = _aggregate_po(po_rows)
    received_totals, grn_uoms, grn_dates = _aggregate_qty(grn_rows)
    invoiced_totals, invoice_prices, invoice_uoms, invoice_dates = _aggregate_qty_and_price(
        invoice_rows
    )

    norm_map = _normalize_uom_map(uom_map)

    all_keys = set(po_totals) | set(received_totals) | set(invoiced_totals)

    lines: list[LineResult] = []
    for key in all_keys:
        po_number, item_code = key
        orphan = key not in po_totals
        if orphan:
            ordered, po_price = ZERO, ZERO
        else:
            ordered, raw_po_price = po_totals[key]
            po_price = raw_po_price if raw_po_price is not None else ZERO
        received = received_totals.get(key, ZERO)
        invoiced = invoiced_totals.get(key, ZERO)
        invoice_price = invoice_prices.get(key, ZERO)

        po_uom = po_uoms.get(key)
        grn_uom = grn_uoms.get(key)
        invoice_uom = invoice_uoms.get(key)
        base_uom = _base_uom(po_uom, grn_uom, invoice_uom)

        po_date = po_dates.get(key)
        received_date = grn_dates.get(key)
        invoice_date = invoice_dates.get(key)

        uom_conversion_applied = False
        uom_covered = True

        ordered, applied, covered = _convert_to_base(ordered, po_uom, base_uom, item_code, norm_map)
        uom_conversion_applied = uom_conversion_applied or applied
        uom_covered = uom_covered and covered

        received, applied, covered = _convert_to_base(
            received, grn_uom, base_uom, item_code, norm_map
        )
        uom_conversion_applied = uom_conversion_applied or applied
        uom_covered = uom_covered and covered

        invoiced, applied, covered = _convert_to_base(
            invoiced, invoice_uom, base_uom, item_code, norm_map
        )
        uom_conversion_applied = uom_conversion_applied or applied
        uom_covered = uom_covered and covered

        status, reason, expected_value, invoiced_value, qty_variance, value_variance = _evaluate(
            ordered,
            po_price,
            received,
            invoiced,
            invoice_price,
            qty_tolerance,
            value_tolerance,
            pct_tolerance,
            orphan,
        )

        timing_gap_days = _gap_days(received_date, invoice_date)

        if orphan:
            pass  # orphan reason from _evaluate always wins - checked first.
        elif not uom_covered:
            status, reason = "exception", UOM_MISMATCH_REASON
        elif (
            status == "exception"
            and timing_gap_days is not None
            and 0 < timing_gap_days <= cutoff_days
        ):
            status, reason = "check", TIMING_REASON

        lines.append(
            LineResult(
                po_number=po_number,
                item_code=item_code,
                ordered=ordered,
                po_price=po_price,
                received=received,
                invoiced=invoiced,
                invoice_price=invoice_price,
                expected_value=expected_value,
                invoiced_value=invoiced_value,
                qty_variance=qty_variance,
                value_variance=value_variance,
                status=status,
                reason=reason,
                uom=base_uom,
                uom_conversion_applied=uom_conversion_applied,
                po_date=po_date,
                received_date=received_date,
                invoice_date=invoice_date,
                timing_gap_days=timing_gap_days,
            )
        )

    lines.sort(key=lambda line: (line.po_number, line.item_code))
    return ReconcileResult(lines=lines, warnings=warnings, as_of=as_of, cutoff_days=cutoff_days)
