"""Fictional Scotti ↔ retailer supply contract: list prices + volume discounts."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


DEFAULT_CONTRACT = (
    Path(__file__).resolve().parents[1]
    / "data"
    / "orders"
    / "contract_scotti_esselunga.json"
)

PRICE_EPS = 0.005  # euro tolerance


@dataclass
class VolumeDiscount:
    min_qty: float
    unit_price: float


@dataclass
class ContractProduct:
    gtin: str
    name: str
    unit_price: float
    volume_discounts: list[VolumeDiscount]


@dataclass
class SupplyContract:
    id: str
    buyer_gln: str
    supplier_gln: str
    buyer_name: str
    supplier_name: str
    currency: str
    products: dict[str, ContractProduct]

    def product(self, gtin: str) -> ContractProduct | None:
        return self.products.get(gtin)

    def expected_unit_price(self, gtin: str, qty: float) -> float | None:
        prod = self.product(gtin)
        if not prod:
            return None
        price = prod.unit_price
        for disc in sorted(prod.volume_discounts, key=lambda d: d.min_qty):
            if qty >= disc.min_qty:
                price = disc.unit_price
        return price


@dataclass
class PriceCheckLine:
    gtin: str | None
    ordered_qty: float | None
    order_price: float | None
    expected_price: float | None
    ok: bool
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PriceCheckResult:
    ok: bool
    lines: list[PriceCheckLine]
    contract_id: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "contract_id": self.contract_id,
            "lines": [line.to_dict() for line in self.lines],
        }


def load_contract(path: Path | str | None = None) -> SupplyContract:
    contract_path = Path(path) if path else DEFAULT_CONTRACT
    data = json.loads(contract_path.read_text(encoding="utf-8"))
    products: dict[str, ContractProduct] = {}
    for row in data.get("products") or []:
        discounts = [
            VolumeDiscount(min_qty=float(d["min_qty"]), unit_price=float(d["unit_price"]))
            for d in (row.get("volume_discounts") or [])
        ]
        products[row["gtin"]] = ContractProduct(
            gtin=row["gtin"],
            name=row.get("name") or row["gtin"],
            unit_price=float(row["unit_price"]),
            volume_discounts=discounts,
        )
    return SupplyContract(
        id=data["id"],
        buyer_gln=data["buyer_gln"],
        supplier_gln=data["supplier_gln"],
        buyer_name=data.get("buyer_name") or "",
        supplier_name=data.get("supplier_name") or "",
        currency=data.get("currency") or "EUR",
        products=products,
    )


def check_prices(
    *,
    lines: list[dict[str, Any]],
    contract: SupplyContract | None = None,
) -> PriceCheckResult:
    """If a line has no PRI, it is skipped (not a mismatch)."""
    active = contract or load_contract()
    results: list[PriceCheckLine] = []
    all_ok = True

    for line in lines:
        gtin = line.get("gtin")
        qty = line.get("quantity")
        order_price = line.get("unit_price")

        if order_price is None:
            results.append(
                PriceCheckLine(
                    gtin=gtin,
                    ordered_qty=qty,
                    order_price=None,
                    expected_price=None,
                    ok=True,
                    reason="no_PRI_on_order",
                )
            )
            continue

        if not gtin or qty is None:
            all_ok = False
            results.append(
                PriceCheckLine(
                    gtin=gtin,
                    ordered_qty=qty,
                    order_price=order_price,
                    expected_price=None,
                    ok=False,
                    reason="missing_gtin_or_qty_for_price_check",
                )
            )
            continue

        expected = active.expected_unit_price(str(gtin), float(qty))
        if expected is None:
            all_ok = False
            results.append(
                PriceCheckLine(
                    gtin=gtin,
                    ordered_qty=qty,
                    order_price=order_price,
                    expected_price=None,
                    ok=False,
                    reason="gtin_not_on_contract",
                )
            )
            continue

        match = abs(float(order_price) - expected) <= PRICE_EPS
        if not match:
            all_ok = False
        results.append(
            PriceCheckLine(
                gtin=gtin,
                ordered_qty=qty,
                order_price=float(order_price),
                expected_price=expected,
                ok=match,
                reason="match" if match else "price_mismatch_vs_contract",
            )
        )

    return PriceCheckResult(ok=all_ok, lines=results, contract_id=active.id)


def draft_price_mismatch_mail(
    *,
    order_number: str | None,
    buyer_name: str,
    supplier_name: str,
    contract: SupplyContract,
    price_check: PriceCheckResult,
) -> str:
    """Human will review/send — never auto-sent."""
    bad = [line for line in price_check.lines if not line.ok]
    lines_txt = "\n".join(
        (
            f"- GTIN {line.gtin}: ordered €{line.order_price}, "
            f"contract €{line.expected_price} (qty {line.ordered_qty}) — {line.reason}"
        )
        for line in bad
    )
    return (
        f"Subject: Price discrepancy on order {order_number or '(unknown)'} — {contract.id}\n\n"
        f"Dear {buyer_name},\n\n"
        f"We received your ORDERS message for order {order_number or '(unknown)'}. "
        f"The unit price on the order does not match the supply contract {contract.id} "
        f"between {buyer_name} and {supplier_name}.\n\n"
        f"Details:\n{lines_txt}\n\n"
        f"Please confirm the contractual price or send a corrected ORDERS.\n\n"
        f"Kind regards,\n{supplier_name}\n"
        f"(Draft — review and send manually)\n"
    )
