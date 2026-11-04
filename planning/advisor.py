"""Buy or wait: a weekly paddy purchasing advisor, backtested against buying evenly.

    python -m planning.advisor                 # backtest table + this week's advice
    python -m planning.advisor --write docs/forecast-results.md

Each week, for each variety, a model trained only on the past predicts the paddy
price change over the next 8 weeks from:
- the price against the same weeks of earlier campaigns (seasonal position)
- the 4-week and 12-week price trend
- the world price (Thai 5%) in euros, its 3-month change, one month late as published
- the week of the campaign (September to August)

The rule turns the prediction into tonnes: buy 1.5 weeks of use when a rise above
2% is expected, half a week when a fall below 2% is expected, otherwise one week,
always keeping between 8 and 16 weeks of paddy in the silos. Weeks with no quote
are left out for both strategies.

The backtest replays 2017/18 to 2025/26 campaign by campaign, training only on
weeks whose outcome was known before the campaign started, against "buy the same
amount every week". The cost compares spend plus the change in stock valued at the
campaign's last price, per tonne used. A person signs every purchase.
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

import numpy as np

from planning.data import SOURCES, eu_series, world_price_eur

VARIETIES = ["Carnaroli", "Arborio", "Selenio", "S. Andrea", "Long B", "Baldo", "Roma", "Loto"]
HORIZON = 8
THRESHOLD = 0.02
MIN_COVER, MAX_COVER, START_COVER = 8.0, 16.0, 12.0
ANNUAL_TONNES = 200_000  # Riso Scotti paddy a year: our estimate, to check with the mentor
FEATURES = ["seasonal_gap", "trend_4w", "trend_12w", "world_eur_3m", "world_eur_level", "week_of_campaign"]


def campaign_of(d: date) -> str:
    start = d.year if d.month >= 9 else d.year - 1
    return f"{start}/{start + 1}"


def campaign_start(label: str) -> date:
    return date(int(label[:4]), 9, 1)


@dataclass
class Week:
    variety: str
    week: date
    price: float
    features: dict[str, float]
    target: float  # log change over HORIZON weeks; nan when unknown


def _month_back(d: date, months: int) -> str:
    y, m = d.year, d.month - months
    while m <= 0:
        y, m = y - 1, m + 12
    return f"{y:04d}-{m:02d}"


def build_weeks(variety: str, world: dict[str, float] | None = None) -> list[Week]:
    series = eu_series(variety)
    world = world if world is not None else world_price_eur()
    prices = {d: p for d, p in series}
    dates = [d for d, _ in series]
    by_week: dict[int, list[tuple[date, float]]] = {}
    for d, p in series:
        if not math.isnan(p):
            by_week.setdefault(d.isocalendar()[1], []).append((d, p))
    out = []
    for i, d in enumerate(dates):
        p = prices[d]
        if math.isnan(p):
            continue
        camp = campaign_start(campaign_of(d))
        past_same = [q for wk in range(d.isocalendar()[1] - 2, d.isocalendar()[1] + 3)
                     for (dd, q) in by_week.get(((wk - 1) % 53) + 1, []) if dd < camp]
        seasonal = math.log(p / np.mean(past_same)) if past_same else math.nan

        def back(n: int) -> float:
            q = prices.get(d - timedelta(weeks=n), math.nan)
            return math.log(p / q) if q and not math.isnan(q) else math.nan

        w1, w4 = world.get(_month_back(d, 1)), world.get(_month_back(d, 4))
        fwd = prices.get(d + timedelta(weeks=HORIZON), math.nan)
        out.append(Week(variety=variety, week=d, price=p, features={
            "seasonal_gap": seasonal, "trend_4w": back(4), "trend_12w": back(12),
            "world_eur_3m": math.log(w1 / w4) if w1 and w4 else math.nan,
            "world_eur_level": w1 if w1 else math.nan,
            "week_of_campaign": float((d - camp).days // 7)},
            target=math.log(fwd / p) if not math.isnan(fwd) else math.nan))
    return out


def _model():
    from sklearn.ensemble import HistGradientBoostingRegressor

    return HistGradientBoostingRegressor(loss="quantile", quantile=0.5, max_iter=200, learning_rate=0.05,
                                         max_leaf_nodes=15, min_samples_leaf=20, random_state=0)


def _xy(weeks: list[Week]) -> tuple[np.ndarray, np.ndarray]:
    x = np.array([[w.features[f] for f in FEATURES] for w in weeks], dtype=float)
    y = np.array([w.target for w in weeks], dtype=float)
    return x, y


def fit(train: list[Week]):
    rows = [w for w in train if not math.isnan(w.target)]
    x, y = _xy(rows)
    return _model().fit(x, y)


def decide(pred: float) -> float:
    return 1.5 if pred > THRESHOLD else 0.5 if pred < -THRESHOLD else 1.0


def simulate(weeks: list[Week], preds: dict[date, float] | None) -> dict[str, float]:
    """One campaign. preds None = buy the same every week. Returns cost per tonne used."""
    stock, spend, used, last = START_COVER, 0.0, 0.0, math.nan
    start_value = None
    for w in weeks:
        if start_value is None:
            start_value = w.price
        q = 1.0 if preds is None else decide(preds[w.week])
        q = min(max(q, MIN_COVER - (stock - 1.0)), MAX_COVER - (stock - 1.0))
        q = max(q, 0.0)
        spend += q * w.price
        stock += q - 1.0
        used += 1.0
        last = w.price
    # value the stock change at the last price so both strategies end even
    effective = spend - (stock - START_COVER) * last
    return {"cost_per_t": effective / used if used else math.nan, "end_stock": stock, "weeks": used}


def backtest(varieties: list[str] = VARIETIES, first: str = "2017/2018", last: str = "2025/2026") -> dict[str, Any]:
    world = world_price_eur()
    all_weeks = {v: build_weeks(v, world) for v in varieties}
    campaigns = sorted({campaign_of(w.week) for ws in all_weeks.values() for w in ws if first <= campaign_of(w.week) <= last})
    rows = []
    calls: list[bool] = []
    for camp in campaigns:
        start = campaign_start(camp)
        train = [w for ws in all_weeks.values() for w in ws
                 if w.week + timedelta(weeks=HORIZON) < start and not math.isnan(w.target)]
        if len(train) < 200:
            continue
        model = fit(train)
        for v, ws in all_weeks.items():
            season = [w for w in ws if campaign_of(w.week) == camp]
            if len(season) < 20:
                continue
            x, y = _xy(season)
            predicted = model.predict(x)
            preds = dict(zip([w.week for w in season], predicted))
            for pr, actual in zip(predicted, y):
                if not math.isnan(actual) and abs(actual) > THRESHOLD:
                    calls.append(np.sign(pr) == np.sign(actual))
            even = simulate(season, None)
            adv = simulate(season, preds)
            rows.append({"campaign": camp, "variety": v, "even": even["cost_per_t"], "advisor": adv["cost_per_t"],
                         "saved_per_t": even["cost_per_t"] - adv["cost_per_t"],
                         "saved_pct": (even["cost_per_t"] - adv["cost_per_t"]) / even["cost_per_t"]})
    saved_pct = float(np.mean([r["saved_pct"] for r in rows])) if rows else math.nan
    wins = sum(1 for r in rows if r["saved_per_t"] > 0)
    avg_price = float(np.mean([r["even"] for r in rows])) if rows else math.nan
    return {"rows": rows, "saved_pct": saved_pct, "wins": wins, "n": len(rows),
            "direction_hit_rate": float(np.mean(calls)) if calls else math.nan, "direction_n": len(calls),
            "saved_per_t": float(np.mean([r["saved_per_t"] for r in rows])) if rows else math.nan,
            "per_year_eur": saved_pct * avg_price * ANNUAL_TONNES, "avg_price": avg_price}


def advice(varieties: list[str] = VARIETIES) -> list[dict[str, Any]]:
    """This week's call for the varieties asked, from one model trained on every variety's
    known weeks (so asking for fewer varieties never changes the call)."""
    world = world_price_eur()
    training = {v: build_weeks(v, world) for v in VARIETIES}
    model = fit([w for ws in training.values() for w in ws if not math.isnan(w.target)])
    all_weeks = {v: training.get(v) or build_weeks(v, world) for v in varieties}
    latest = max(ws[-1].week for ws in training.values() if ws)
    out = []
    for v, ws in all_weeks.items():
        if not ws or (latest - ws[-1].week).days > 7 * HORIZON:
            continue  # no recent quote: no advice
        w = ws[-1]
        pred = float(model.predict(_xy([w])[0])[0])
        call = {1.5: "BUY MORE", 0.5: "WAIT", 1.0: "BUY AS USUAL"}[decide(pred)]
        last_year = [x for x in ws if abs((x.week - (w.week - timedelta(days=364))).days) <= 3]
        out.append({"variety": v, "week": w.week.isoformat(), "price_eur_t": w.price,
                    "price_a_year_ago": last_year[0].price if last_year else None,
                    "expected_8w_change": round(math.expm1(pred), 4), "call": call,
                    "tonnes_vs_usual": decide(pred),
                    "signals": {k: (None if math.isnan(val) else round(val, 4)) for k, val in w.features.items()},
                    "sources": [f"{SOURCES['eu']}, week of {w.week.isoformat()}",
                                f"{SOURCES['wb']} and {SOURCES['ecb']}, month {_month_back(w.week, 1)}"]})
    return out


def to_markdown(bt: dict[str, Any], calls: list[dict[str, Any]]) -> str:
    lines = ["# Buy or wait: backtest and this week's advice", "",
             "Weekly Italian paddy prices from the EU Agri-food Data Portal, world rice prices from the World Bank "
             "Pink Sheet in euros (ECB rates). Rebuild with `python -m planning.data` then `python -m planning.advisor`.", "",
             f"**Backtest, {bt['n']} variety-campaigns, 2017/18 to 2025/26:** the advisor paid "
             f"{bt['saved_pct']:+.2%} against buying the same amount every week "
             f"({bt['saved_per_t']:+.2f} €/t on average; it did better in {bt['wins']} of {bt['n']}). "
             f"At {ANNUAL_TONNES:,} t a year and the average price of €{bt['avg_price']:.0f}/t that is about "
             f"€{bt['per_year_eur']:,.0f} a year (the tonnage is our estimate, to check with the mentor). "
             "A positive number means the advisor paid less.", "",
             f"**Read this as: no proven edge yet.** The advisor beat even buying in half the variety-campaigns, "
             f"and when the price moved more than 2% in 8 weeks the model called the direction right "
             f"{bt['direction_hit_rate']:.0%} of the time ({bt['direction_n']} weeks). The signals and the weekly memo "
             "are useful to the buyer; the saving is not yet something to promise. We did not tune the model on "
             "this backtest, which would only fit the past.", "",
             "| Campaign | Variety | Even buying €/t | Advisor €/t | Saved €/t |", "|---|---|---|---|---|"]
    for r in bt["rows"]:
        lines.append(f"| {r['campaign']} | {r['variety']} | {r['even']:.2f} | {r['advisor']:.2f} | {r['saved_per_t']:+.2f} |")
    lines += ["", "## This week", "", "| Variety | Week | €/t | A year ago | Expected in 8 weeks | Call |", "|---|---|---|---|---|---|"]
    for c in calls:
        ago = f"{c['price_a_year_ago']:.0f}" if c["price_a_year_ago"] else "n/a"
        lines.append(f"| {c['variety']} | {c['week']} | {c['price_eur_t']:.0f} | {ago} | "
                     f"{c['expected_8w_change']:+.1%} | {c['call']} |")
    lines += ["", "Limits: prices are farm-gate averages, not what Riso Scotti pays; the backtest ignores storage cost "
              "and contracts signed at sowing; a person signs every purchase.", ""]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Backtest the buy-or-wait advisor and print this week's advice")
    parser.add_argument("--write", help="also write the markdown to this file")
    args = parser.parse_args(argv)
    md = to_markdown(backtest(), advice())
    print(md)
    if args.write:
        with open(args.write, "w", encoding="utf-8") as fh:
            fh.write(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
