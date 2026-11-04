"""Availability hook — stub until Core Mini ERP / stock projection is wired.

Interface kept stable so Order can swap the backend without changing checks.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol


DEFAULT_STUB = (
    Path(__file__).resolve().parents[1] / "data" / "orders" / "availability_stub.json"
)


@dataclass(frozen=True)
class AvailabilityQuery:
    gtin: str
    buyer_gln: str | None
    supplier_gln: str | None
    requested_date: str | None  # YYYYMMDD


@dataclass(frozen=True)
class AvailabilityResult:
    gtin: str
    available_qty: float
    source: str
    found: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class AvailabilityProvider(Protocol):
    def get_availability(self, query: AvailabilityQuery) -> AvailabilityResult: ...


class StubAvailabilityProvider:
    """Reads `data/orders/availability_stub.json`. Replace when Core lands."""

    def __init__(self, path: Path | str | None = None) -> None:
        self.path = Path(path) if path else DEFAULT_STUB
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        self._rows: list[dict[str, Any]] = list(raw.get("rows") or [])

    def get_availability(self, query: AvailabilityQuery) -> AvailabilityResult:
        for row in self._rows:
            if row.get("gtin") != query.gtin:
                continue
            buyer = row.get("buyer_gln")
            if buyer and query.buyer_gln and buyer != query.buyer_gln:
                continue
            return AvailabilityResult(
                gtin=query.gtin,
                available_qty=float(row.get("available_qty") or 0),
                source=str(row.get("source") or self.path.name),
                found=True,
            )
        return AvailabilityResult(
            gtin=query.gtin,
            available_qty=0.0,
            source="stub_miss",
            found=False,
        )


def get_availability(
    query: AvailabilityQuery,
    provider: AvailabilityProvider | None = None,
) -> AvailabilityResult:
    active = provider or StubAvailabilityProvider()
    return active.get_availability(query)
