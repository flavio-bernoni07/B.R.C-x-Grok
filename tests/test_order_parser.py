"""Tests for order.parser — no API key required."""

from __future__ import annotations

from pathlib import Path

from order.parser import parse_orders_edi, parse_orders_file

EDI = Path(__file__).resolve().parents[1] / "data" / "orders" / "edi"


def test_clean_orders_parses_key_fields() -> None:
    result = parse_orders_file(EDI / "ordine_ess_001.edi")
    assert result.ok
    assert result.order.order_number == "ESS001"
    assert result.order.order_date == "20261104"
    assert result.order.buyer_gln == "BUYER001"
    assert result.order.supplier_gln == "SUPPLIER001"
    assert len(result.order.lines) == 1
    line = result.order.lines[0]
    assert line.gtin == "8000000000000"
    assert line.quantity == 10000.0
    assert line.unit_price == 1.85


def test_messy_qty_raises_parse_flags() -> None:
    result = parse_orders_file(EDI / "ordine_ess_messy.edi")
    assert not result.ok
    codes = {f.code for f in result.flags}
    assert "qty_ambiguous_it_thousands" in codes or "qty_ambiguous_dot" in codes
    assert "dtm_bad_format" in codes


def test_indent_and_whitespace_normalized() -> None:
    raw = "  \n  BGM+220+X1+9'  \n  DTM+137:20261104:102'\nNAD+BY+BUYER001::9'\nNAD+SU+SUPPLIER001::9'\nLIN+1++8000000000000:EN'\nQTY+21:10'\n"
    result = parse_orders_edi(raw)
    assert result.order.order_number == "X1"
    assert result.order.lines[0].quantity == 10.0


def test_missing_bgm_flags() -> None:
    raw = "UNH+1+ORDERS:D:96A:UN'DTM+137:20261104:102'NAD+BY+BUYER001::9'NAD+SU+SUPPLIER001::9'LIN+1++8000000000000:EN'QTY+21:5'"
    result = parse_orders_edi(raw)
    assert not result.ok
    assert any(f.code == "missing_segment" and f.segment == "BGM" for f in result.flags)
