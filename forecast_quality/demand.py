"""Demand forecast per product and week, and the weekly stock projection the Order row can read.

    python -m forecast_quality.demand

The order history is invented (data/world/order_history.csv, written by
`make_history()`): risotto rice peaks in winter, flyer weeks sell more, August is
slow, Christmas week is busy. It shows the pipeline works; it proves nothing about
accuracy on Riso Scotti's real orders.

Forecast = recent level x last year's seasonal shape x a promo uplift learned from
past flyer weeks, with the promo calendar coming from promo notices. Baseline =
same week last year. Both are scored on the last 12 weeks, each forecast made with
only the weeks before it.
"""

from __future__ import annotations

import csv
import math
import random
from datetime import date, timedelta
from pathlib import Path
from typing import Any

HISTORY = Path(__file__).resolve().parents[1] / "data" / "world" / "order_history.csv"
PRODUCTS = {"8000000000001": ("CAR-1KG", 9000), "8000000000000": ("ARB-1KG", 12000), "8000000000049": ("RSP-FUNGHI-210", 4000)}


def iso_week(d: date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def make_history(path: Path = HISTORY, *, start: date = date(2024, 11, 4), weeks: int = 104, seed: int = 11) -> Path:
    rng = random.Random(seed)
    rows = []
    for i in range(weeks):
        wk = start + timedelta(weeks=i)
        for gtin, (item, base) in PRODUCTS.items():
            season = 1 + 0.30 * math.cos(2 * math.pi * (wk.timetuple().tm_yday - 15) / 365)  # peak mid-January
            promo = rng.random() < 0.12
            holiday = 1.25 if (wk.month == 12 and 15 <= wk.day <= 24) else 0.7 if wk.month == 8 else 1.0
            trend = 1 + 0.0008 * i
            qty = base * season * holiday * trend * (1.4 if promo else 1.0) * rng.gauss(1, 0.06)
            rows.append({"week": iso_week(wk), "week_start": wk.isoformat(), "gtin": gtin, "item_code": item,
                         "qty": round(qty), "promo": int(promo)})
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    return path


def load_history(path: Path = HISTORY) -> dict[str, list[dict[str, Any]]]:
    if not path.exists():
        make_history(path)
    out: dict[str, list[dict[str, Any]]] = {}
    with path.open(encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            out.setdefault(r["gtin"], []).append({"week_start": date.fromisoformat(r["week_start"]), "qty": float(r["qty"]),
                                                  "promo": r["promo"] == "1"})
    return out


def _uplift(past: list[dict[str, Any]]) -> float:
    promo = [p["qty"] for p in past if p["promo"]]
    normal = [p["qty"] for p in past if not p["promo"]]
    return (sum(promo) / len(promo)) / (sum(normal) / len(normal)) if promo and normal else 1.0


def forecast_week(past: list[dict[str, Any]], target: date, *, promo: bool = False) -> float:
    """Recent level x seasonal shape from last year x promo uplift. Uses only `past`."""
    by_week = {p["week_start"]: p for p in past}
    up = _uplift(past)

    def clean(p: dict[str, Any]) -> float:
        return p["qty"] / up if p["promo"] else p["qty"]

    recent = past[-8:]
    ly = [by_week.get(w["week_start"] - timedelta(weeks=52)) for w in recent]
    ratios = [clean(r) / clean(l) for r, l in zip(recent, ly) if l]
    level_ratio = sum(ratios) / len(ratios) if ratios else 1.0
    last_year = by_week.get(target - timedelta(weeks=52))
    if last_year is None:
        base = sum(clean(p) for p in recent) / len(recent)
    else:
        neigh = [by_week.get(target - timedelta(weeks=52 + k)) for k in (-1, 0, 1)]
        base = sum(clean(n) for n in neigh if n) / len([n for n in neigh if n]) * level_ratio
    return base * (up if promo else 1.0)


def score(history: dict[str, list[dict[str, Any]]] | None = None, test_weeks: int = 12) -> dict[str, Any]:
    history = history or load_history()
    rows, ours_err, base_err, total = [], 0.0, 0.0, 0.0
    for gtin, series in history.items():
        for i in range(len(series) - test_weeks, len(series)):
            past, actual = series[:i], series[i]
            ly = {p["week_start"]: p["qty"] for p in past}.get(actual["week_start"] - timedelta(weeks=52))
            if ly is None:
                continue
            ours = forecast_week(past, actual["week_start"], promo=actual["promo"])
            ours_err += abs(ours - actual["qty"])
            base_err += abs(ly - actual["qty"])
            total += actual["qty"]
            rows.append({"gtin": gtin, "week": iso_week(actual["week_start"]), "actual": actual["qty"],
                         "ours": round(ours), "same_week_last_year": ly, "promo": actual["promo"]})
    return {"rows": rows, "wape_ours": ours_err / total, "wape_baseline": base_err / total}


def forecast(gtin: str, start: date, weeks: int = 8, promo_weeks: set[str] | None = None) -> list[dict[str, Any]]:
    series = load_history().get(gtin)
    if not series:
        return []
    past = [p for p in series if p["week_start"] < monday(start)]
    out = []
    for k in range(weeks):
        wk = monday(start) + timedelta(weeks=k)
        out.append({"week": iso_week(wk), "qty": round(forecast_week(past, wk, promo=iso_week(wk) in (promo_weeks or set())))})
    return out


def stock_projection(erp: Any, gtin: str, *, start: date, weeks: int = 8, promo_weeks: set[str] | None = None) -> list[dict[str, Any]]:
    """What we can promise per week: stock + production due - confirmed orders - expected orders.
    Confirmed orders not shipped count in the first week; held batches never count."""
    from core.stock import batches, committed_qty

    released = sum(b["qty"] for b in batches(erp, gtin, "released"))
    held = sum(b["qty"] for b in batches(erp, gtin, "hold"))
    planned = batches(erp, gtin, "planned")
    expected = {f["week"]: f["qty"] for f in forecast(gtin, start, weeks, promo_weeks)}
    rows, stock = [], released
    for k in range(weeks):
        wk = monday(start) + timedelta(weeks=k)
        label = iso_week(wk)
        due = [b for b in planned if b["available_from"] and iso_week(date.fromisoformat(b["available_from"])) == label]
        production = sum(b["qty"] for b in due)
        confirmed = committed_qty(erp, gtin) if k == 0 else 0.0
        demand = expected.get(label, 0)
        opening = stock
        stock = opening + production - confirmed - demand
        rows.append({"week": label, "opening": opening, "production": production, "confirmed_orders": confirmed,
                     "expected_orders": demand, "closing": stock, "held": held,
                     "available_to_promise": max(stock, 0.0),
                     "sources": [b["batch"] for b in due] + (["confirmed orders"] if confirmed else []) + ["demand forecast"]})
    return rows


def main() -> int:
    s = score()
    print(f"Demand forecast on invented history, last 12 weeks, 3 products: weighted error "
          f"{s['wape_ours']:.1%} against {s['wape_baseline']:.1%} for 'same week last year'.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


def production_suggestion(rows: list[dict[str, Any]], cover_weeks: int = 4) -> dict[str, Any] | None:
    """Predictive planning: the first week the projection goes short, and how much to make
    before it to cover that week and the next ones. A suggestion for the planner, never an order."""
    short = next((r for r in rows if r["closing"] < 0), None)
    if not short:
        return None
    i = rows.index(short)
    need = sum(r["expected_orders"] for r in rows[i:i + cover_weeks]) - max(rows[i]["opening"] + rows[i]["production"]
                                                                            - rows[i]["confirmed_orders"], 0)
    return {"short_from": short["week"], "make_before": rows[i]["week"], "qty": round(max(need, 0)),
            "covers_weeks": min(cover_weeks, len(rows) - i), "why": f"projected stock {short['closing']:,.0f} in {short['week']}"}
