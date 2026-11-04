"""Score our reconciliation against the threeway baseline on the labelled cases.

    python -m bench.score                 # table on screen
    python -m bench.score --write docs/results.md

Two questions per case:
- attention: does someone at Riso Scotti have to act?
- causes:    are all the causes named, and nothing else?

threeway runs as vendored in dispute/_threeway_core.py with its default settings
(no unit-conversion map). Ours is shipping.reconcile.reconcile_documents with the
product list from data/world/products.json.
"""

from __future__ import annotations

import argparse
import json
from decimal import Decimal
from pathlib import Path
from typing import Any

from dispute._threeway_core import ORPHAN_REASON, TIMING_REASON, UOM_MISMATCH_REASON, RawLine, reconcile
from shipping.reconcile import reconcile_documents

ROOT = Path(__file__).resolve().parents[1]
CASES = ROOT / "data" / "bench" / "cases.json"
PRODUCTS = ROOT / "data" / "world" / "products.json"

THREEWAY_CAUSE = {
    "Invoiced but nothing received": "overbilled",
    "No receipt and no invoice yet": "not_shipped",
    "Billed for more than was received": "overbilled",
    "Received more than was ordered": "over_delivery",
    "Short delivery against the order": "short_delivery",
    "Invoice price differs from the PO price": "price_difference",
    "Value gap with matching quantities": "price_difference",
    UOM_MISMATCH_REASON: "uom_unknown",
    TIMING_REASON: "timing",
}


def _raw(lines: list[dict[str, Any]], with_price: bool) -> list[RawLine]:
    return [RawLine(po_number=l["order_ref"], item_code=l["item_code"], quantity=Decimal(str(l["quantity"])),
                    price=Decimal(str(l["unit_price"])) if with_price and l.get("unit_price") is not None else None,
                    uom=l.get("uom")) for l in lines]


def run_threeway(case: dict[str, Any]) -> dict[str, Any]:
    result = reconcile(_raw(case["po"], True), _raw(case["received"], False), _raw(case["invoiced"], True))
    causes = set()
    attention = False
    for line in result.lines:
        if line.status == "matched":
            continue
        attention = True
        if line.reason == ORPHAN_REASON:
            causes.add("orphan_invoice" if line.invoiced > 0 else "orphan_receipt")
        else:
            causes.add(THREEWAY_CAUSE.get(line.reason, line.reason))
    return {"attention": attention, "causes": sorted(causes)}


def run_ours(case: dict[str, Any], products: list[dict[str, Any]]) -> dict[str, Any]:
    report = reconcile_documents(case["po"], case["received"], case["invoiced"], products=products)
    return {"attention": report.status != "matched", "causes": sorted(report.causes)}


def score(cases_path: Path = CASES, products_path: Path = PRODUCTS) -> dict[str, Any]:
    cases = json.loads(cases_path.read_text(encoding="utf-8"))["cases"]
    products = json.loads(products_path.read_text(encoding="utf-8"))["products"]
    rows = []
    for case in cases:
        tw, us = run_threeway(case), run_ours(case, products)
        exp = case["expected"]
        rows.append({
            "id": case["id"], "kind": case["kind"], "description": case["description"], "expected": exp,
            "threeway": tw, "ours": us,
            "threeway_attention_ok": tw["attention"] == exp["attention"],
            "threeway_causes_ok": tw["causes"] == exp["causes"],
            "ours_attention_ok": us["attention"] == exp["attention"],
            "ours_causes_ok": us["causes"] == exp["causes"],
        })
    n = len(rows)
    totals = {k: sum(r[k] for r in rows) for k in ("threeway_attention_ok", "threeway_causes_ok",
                                                  "ours_attention_ok", "ours_causes_ok")}
    return {"n": n, "totals": totals, "rows": rows}


def _fmt(result: dict[str, Any]) -> str:
    return ("act" if result["attention"] else "ok") + (f": {', '.join(result['causes'])}" if result["causes"] else "")


def to_markdown(res: dict[str, Any]) -> str:
    n, t = res["n"], res["totals"]
    out = [
        "# Reconciliation against the threeway baseline",
        "",
        f"{n} labelled cases in `data/bench/cases.json`. Run `python -m bench.score` to reproduce.",
        "",
        "| | threeway | ours |",
        "|---|---|---|",
        f"| Right call on whether someone must act | {t['threeway_attention_ok']}/{n} | {t['ours_attention_ok']}/{n} |",
        f"| Every cause named, nothing extra | {t['threeway_causes_ok']}/{n} | {t['ours_causes_ok']}/{n} |",
        "",
        "| Case | What happened | Right answer | threeway | ours |",
        "|---|---|---|---|---|",
    ]
    for r in res["rows"]:
        mark = lambda ok: "" if ok else " ✗"  # noqa: E731
        out.append(f"| {r['id']} | {r['description']} | {_fmt(r['expected'])} | {_fmt(r['threeway'])}"
                   f"{mark(r['threeway_attention_ok'] and r['threeway_causes_ok'])} | {_fmt(r['ours'])}"
                   f"{mark(r['ours_attention_ok'] and r['ours_causes_ok'])} |")
    out += [
        "",
        "How to read this: we wrote these cases and their answers ourselves, before running either matcher, "
        "to cover the blind spots we found in threeway's code. A full score on our own set shows those blind "
        "spots are handled; it is not a measure of accuracy on documents we have not seen. threeway runs with "
        "its default settings: it can convert units if it is given a conversion map, which the baseline does not have.",
        "",
    ]
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Score our reconciliation against threeway")
    parser.add_argument("--write", type=Path, help="also write the markdown table to this file")
    args = parser.parse_args(argv)
    md = to_markdown(score())
    print(md)
    if args.write:
        args.write.write_text(md, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
