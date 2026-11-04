"""Order pipeline — parse → availability → price → next action (see order-dec.md)."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from order.availability import (
    AvailabilityProvider,
    AvailabilityQuery,
    StubAvailabilityProvider,
    get_availability,
)
from order.contract import (
    PriceCheckResult,
    SupplyContract,
    check_prices,
    draft_price_mismatch_mail,
    load_contract,
)
from order.ordrsp import OrdrspDocument, build_ordrsp
from order.parser import ParseResult, ParsedOrder, parse_orders_edi, parse_orders_file


class PipelineStatus(str, Enum):
    AWAIT_GROK_PARSE = "await_grok_parse"
    AWAIT_GROK_QTY = "await_grok_qty"
    AWAIT_PRICE_HUMAN = "await_price_human"  # draft mail → manual EDI / pending
    AWAIT_CONFIRM_SIGNOFF = "await_confirm_signoff"
    READY_ORDRSP = "ready_ordrsp"
    ERROR = "error"


@dataclass
class AvailabilityLineCheck:
    gtin: str | None
    ordered_qty: float | None
    available_qty: float | None
    ok: bool
    source: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PipelineResult:
    status: PipelineStatus
    parse: ParseResult | None = None
    availability: list[AvailabilityLineCheck] = field(default_factory=list)
    price_check: PriceCheckResult | None = None
    draft_mail: str | None = None
    ordrsp: OrdrspDocument | None = None
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "parse": self.parse.to_dict() if self.parse else None,
            "availability": [a.to_dict() for a in self.availability],
            "price_check": self.price_check.to_dict() if self.price_check else None,
            "draft_mail": self.draft_mail,
            "ordrsp": self.ordrsp.body if self.ordrsp else None,
            "handoff": self.ordrsp.handoff if self.ordrsp else None,
            "notes": self.notes,
        }


def _check_availability(
    order: ParsedOrder,
    provider: AvailabilityProvider,
) -> tuple[bool, list[AvailabilityLineCheck]]:
    checks: list[AvailabilityLineCheck] = []
    ok = True
    for line in order.lines:
        if not line.gtin or line.quantity is None:
            ok = False
            checks.append(
                AvailabilityLineCheck(
                    gtin=line.gtin,
                    ordered_qty=line.quantity,
                    available_qty=None,
                    ok=False,
                    source="missing_gtin_or_qty",
                )
            )
            continue
        result = get_availability(
            AvailabilityQuery(
                gtin=line.gtin,
                buyer_gln=order.buyer_gln,
                supplier_gln=order.supplier_gln,
                requested_date=order.order_date,
            ),
            provider=provider,
        )
        line_ok = result.found and line.quantity <= result.available_qty
        if not line_ok:
            ok = False
        checks.append(
            AvailabilityLineCheck(
                gtin=line.gtin,
                ordered_qty=line.quantity,
                available_qty=result.available_qty,
                ok=line_ok,
                source=result.source,
            )
        )
    return ok, checks


def run_order_pipeline(
    raw_edi: str,
    *,
    availability: AvailabilityProvider | None = None,
    contract: SupplyContract | None = None,
    confirm: bool = False,
) -> PipelineResult:
    """Run checks up to the next human/Grok gate.

    `confirm=True` only applies when the path is already clear for the
    always-on confirm sign-off: then ORDRSP is emitted (simulates human OK).
    """
    provider = availability or StubAvailabilityProvider()
    active_contract = contract or load_contract()
    notes: list[str] = []

    parse = parse_orders_edi(raw_edi)
    if not parse.ok:
        return PipelineResult(
            status=PipelineStatus.AWAIT_GROK_PARSE,
            parse=parse,
            notes=["parse_flags present — Grokbot must correct and re-enter Parse EDI"],
        )

    qty_ok, avail_checks = _check_availability(parse.order, provider)
    if not qty_ok:
        return PipelineResult(
            status=PipelineStatus.AWAIT_GROK_QTY,
            parse=parse,
            availability=avail_checks,
            notes=[
                "qty_short — Grokbot chooses split or mail, then availability check again"
            ],
        )

    price = check_prices(
        lines=[line.to_dict() for line in parse.order.lines],
        contract=active_contract,
    )
    if not price.ok:
        mail = draft_price_mismatch_mail(
            order_number=parse.order.order_number,
            buyer_name=active_contract.buyer_name,
            supplier_name=active_contract.supplier_name,
            contract=active_contract,
            price_check=price,
        )
        return PipelineResult(
            status=PipelineStatus.AWAIT_PRICE_HUMAN,
            parse=parse,
            availability=avail_checks,
            price_check=price,
            draft_mail=mail,
            notes=[
                "price_mismatch — draft mail ready; human: manual EDI or park pending "
                "(not confirm sign-off)"
            ],
        )

    if not confirm:
        return PipelineResult(
            status=PipelineStatus.AWAIT_CONFIRM_SIGNOFF,
            parse=parse,
            availability=avail_checks,
            price_check=price,
            notes=["checks ok — always-on human confirm sign-off before ORDRSP"],
        )

    ordrsp = build_ordrsp(parse.order)
    notes.append("confirmed — ORDRSP built; handoff payload ready for shipping")
    return PipelineResult(
        status=PipelineStatus.READY_ORDRSP,
        parse=parse,
        availability=avail_checks,
        price_check=price,
        ordrsp=ordrsp,
        notes=notes,
    )


def run_order_file(
    path: Path | str,
    *,
    confirm: bool = False,
    availability: AvailabilityProvider | None = None,
    contract: SupplyContract | None = None,
) -> PipelineResult:
    raw = Path(path).read_text(encoding="utf-8")
    return run_order_pipeline(
        raw,
        confirm=confirm,
        availability=availability,
        contract=contract,
    )


def main(argv: list[str] | None = None) -> int:
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(description="Run Order pipeline on an ORDERS EDI file")
    parser.add_argument("edi_path", type=Path)
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Simulate human confirm sign-off and emit ORDRSP when checks pass",
    )
    args = parser.parse_args(argv)

    result = run_order_file(args.edi_path, confirm=args.confirm)
    json.dump(result.to_dict(), sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0 if result.status != PipelineStatus.ERROR else 1


if __name__ == "__main__":
    raise SystemExit(main())
