"""Prophet baseline for weekly Italian paddy prices, with a rolling backtest against a naive
"price stays where it is" forecast. The baseline is statistics only: it knows nothing about
news, trade deals or harvests. The agent puts it beside the news."""

from __future__ import annotations

import hashlib
import json
import logging
import warnings
from datetime import timedelta

import pandas as pd

from .paths import OUT_DIR
from .sources import ECB_FILE, EU_FILE, WB_FILE, load_sources, raw_path

logging.getLogger("prophet").setLevel(logging.ERROR)
logging.getLogger("cmdstanpy").setLevel(logging.ERROR)
logging.getLogger("cmdstanpy").disabled = True
warnings.filterwarnings("ignore")

# Paddy varieties shown by default: the ones Riso Scotti cares about most, with long histories.
DEFAULT_VARIETIES = ["Carnaroli", "Arborio", "Baldo", "Roma", "S. Andrea", "Selenio", "Loto", "Long B"]
MODEL_VERSION = "prophet-anchored-v3"


def load_paddy() -> pd.DataFrame:
    df = pd.read_csv(raw_path(EU_FILE), parse_dates=["week_start"])
    return df[df["stage"] == "Paddy"]


def series(variety: str) -> pd.DataFrame:
    df = load_paddy()
    s = df[df["variety"] == variety][["week_start", "price_eur_t"]]
    s = s.groupby("week_start", as_index=False)["price_eur_t"].mean().sort_values("week_start")
    if s.empty:
        raise ValueError(f"No paddy prices for variety {variety!r}")
    return s.rename(columns={"week_start": "ds", "price_eur_t": "y"})


def available_varieties(min_points: int = 150) -> list[dict]:
    df = load_paddy()
    latest = df["week_start"].max()
    rows = []
    for name, g in df.groupby("variety"):
        if name == "Avg" or len(g) < min_points:
            continue
        last = g["week_start"].max()
        if (latest - last).days > 120:
            continue
        rows.append({"variety": name, "type": g["type"].iloc[-1], "points": len(g),
                     "latest": last.date().isoformat()})
    order = {v: i for i, v in enumerate(DEFAULT_VARIETIES)}
    rows.sort(key=lambda r: (order.get(r["variety"], 99), r["variety"]))
    return rows


def _move_quantiles(train: pd.DataFrame, weeks: int, q: tuple[float, float]) -> tuple[float, float]:
    """Historical 10th/90th percentile of the log price change over `weeks` weeks."""
    import numpy as np

    a = train[["ds", "y"]].sort_values("ds")
    b = a.assign(ds=a["ds"] - timedelta(weeks=weeks)).rename(columns={"y": "y_later"})
    pairs = pd.merge_asof(a, b, on="ds", direction="nearest", tolerance=pd.Timedelta(days=3)).dropna()
    moves = np.log(pairs["y_later"] / pairs["y"])
    if len(moves) < 30:
        return (-0.1 * weeks / 8, 0.1 * weeks / 8)
    return float(moves.quantile(q[0])), float(moves.quantile(q[1]))


def _fit_predict(train: pd.DataFrame, horizon_weeks: int) -> pd.DataFrame:
    """Prophet on log prices (flat trend, yearly seasonality) gives the expected seasonal drift,
    anchored on the last observed price: Prophet's own level lags badly after the 2022-25 boom
    and crash. The 80% band comes from how far prices really moved over the same number of
    weeks in the training data, which is better calibrated than Prophet's in-sample band."""
    import numpy as np
    from prophet import Prophet

    m = Prophet(growth="flat", yearly_seasonality=4, weekly_seasonality=False,
                daily_seasonality=False, uncertainty_samples=0)
    m.fit(train.assign(y=np.log(train["y"])))
    last_ds, last_y = train["ds"].max(), float(train["y"].iloc[-1])
    dates = [last_ds + timedelta(weeks=i) for i in range(0, horizon_weeks + 1)]
    f = m.predict(pd.DataFrame({"ds": dates}))
    drift = (f["yhat"] - f["yhat"].iloc[0]).to_numpy()
    rows = []
    for i in range(1, horizon_weeks + 1):
        lo, hi = _move_quantiles(train, i, (0.1, 0.9))
        rows.append({"ds": dates[i], "yhat": last_y * np.exp(drift[i]),
                     "yhat_lower": last_y * np.exp(lo), "yhat_upper": last_y * np.exp(hi)})
    return pd.DataFrame(rows)


def _value_near(s: pd.DataFrame, when: pd.Timestamp, tolerance_days: int) -> float | None:
    gap = (s["ds"] - when).abs()
    i = gap.idxmin()
    return float(s.loc[i, "y"]) if gap.loc[i].days <= tolerance_days else None


def backtest(s: pd.DataFrame, horizon_weeks: int, years: int = 2, step_weeks: int = 4) -> dict:
    """Refit at past dates using only data known then; score the price `horizon_weeks` ahead."""
    end = s["ds"].max() - timedelta(weeks=horizon_weeks)
    origins = [end - timedelta(weeks=step_weeks * k) for k in range(int(52 * years / step_weeks))]
    rows = []
    for origin in sorted(origins):
        train = s[s["ds"] <= origin]
        if len(train) < 104:
            continue
        target = train["ds"].max() + timedelta(weeks=horizon_weeks)
        actual = _value_near(s, target, 3)
        if actual is None:
            continue
        fc = _fit_predict(train, horizon_weeks).iloc[-1]
        pred, fc_lo, fc_hi = float(fc["yhat"]), float(fc["yhat_lower"]), float(fc["yhat_upper"])
        naive = float(train["y"].iloc[-1])
        rows.append({"origin": origin.date().isoformat(), "actual": actual,
                     "prophet": round(pred, 1), "naive": naive,
                     "in_band": bool(fc_lo <= actual <= fc_hi)})
    if not rows:
        return {"origins": 0}
    bt = pd.DataFrame(rows)
    mae_p = (bt["prophet"] - bt["actual"]).abs().mean()
    mae_n = (bt["naive"] - bt["actual"]).abs().mean()
    return {
        "origins": len(bt),
        "horizon_weeks": horizon_weeks,
        "mae_prophet_eur_t": round(float(mae_p), 1),
        "mae_naive_eur_t": round(float(mae_n), 1),
        "mape_prophet_pct": round(float(((bt["prophet"] - bt["actual"]).abs() / bt["actual"]).mean() * 100), 1),
        "mape_naive_pct": round(float(((bt["naive"] - bt["actual"]).abs() / bt["actual"]).mean() * 100), 1),
        "prophet_beats_naive": bool(mae_p < mae_n),
        "band_coverage_pct": round(float(bt["in_band"].mean() * 100), 0),
        "period": f"{rows[0]['origin']} to {rows[-1]['origin']}",
    }


def _pct(a: float | None, b: float | None) -> float | None:
    return None if a is None or b in (None, 0) else round((a / b - 1) * 100, 1)


def _cache_key(*parts: str) -> str:
    stamp = raw_path(EU_FILE).stat().st_mtime_ns
    return hashlib.sha1("|".join([MODEL_VERSION, str(stamp), *parts]).encode()).hexdigest()[:12]


def forecast(variety: str, horizon_weeks: int = 8, history_weeks: int = 156) -> dict:
    """Prophet baseline for one variety. Cached in data/out/ until the raw data changes."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    key = _cache_key(variety, str(horizon_weeks), str(history_weeks))
    cache = OUT_DIR / f"forecast_{variety.replace(' ', '_').replace('.', '')}_{horizon_weeks}w_{key}.json"
    if cache.exists():
        return json.loads(cache.read_text())

    s = series(variety)
    fc = _fit_predict(s, horizon_weeks)
    last_date = s["ds"].iloc[-1]
    last_price = float(s["y"].iloc[-1])
    end = fc.iloc[-1]
    hist = s[s["ds"] >= last_date - timedelta(weeks=history_weeks)]
    result = {
        "variety": variety,
        "unit": "EUR/t paddy, Italy",
        "model": "Prophet on log price, flat trend, yearly seasonality, anchored on the last price; 80% band from past 8-week moves",
        "as_of": last_date.date().isoformat(),
        "last_price": last_price,
        "change_4w_pct": _pct(last_price, _value_near(s, last_date - timedelta(weeks=4), 10)),
        "change_52w_pct": _pct(last_price, _value_near(s, last_date - timedelta(weeks=52), 14)),
        "horizon_weeks": horizon_weeks,
        "forecast_end": {
            "date": end["ds"].date().isoformat(),
            "mean": round(float(end["yhat"]), 1),
            "lower": round(float(end["yhat_lower"]), 1),
            "upper": round(float(end["yhat_upper"]), 1),
            "change_pct": _pct(float(end["yhat"]), last_price),
        },
        "history": [{"date": d.date().isoformat(), "price": float(p)} for d, p in zip(hist["ds"], hist["y"])],
        "forecast": [
            {"date": r.ds.date().isoformat(), "mean": round(r.yhat, 1),
             "lower": round(r.yhat_lower, 1), "upper": round(r.yhat_upper, 1)}
            for r in fc.itertuples()
        ],
        "backtest": backtest(s, horizon_weeks),
        "sources": [load_sources().get("eu_rice", {"file": EU_FILE})],
        "caveat": "Statistical baseline from past prices only. It does not know about news, "
                  "trade policy, harvest size or farmer stocks.",
    }
    for old in OUT_DIR.glob(cache.name.rsplit("_", 1)[0] + "_*.json"):
        old.unlink()
    cache.write_text(json.dumps(result))
    return result


def market() -> dict:
    """Latest paddy prices per variety plus world rice prices converted to euros."""
    paddy = load_paddy()
    rows = []
    for v in available_varieties():
        s = series(v["variety"])
        last_date, last = s["ds"].iloc[-1], float(s["y"].iloc[-1])
        rows.append({
            "variety": v["variety"], "type": v["type"], "as_of": last_date.date().isoformat(),
            "price_eur_t": last,
            "change_4w_pct": _pct(last, _value_near(s, last_date - timedelta(weeks=4), 10)),
            "change_52w_pct": _pct(last, _value_near(s, last_date - timedelta(weeks=52), 14)),
        })

    wb = pd.read_csv(raw_path(WB_FILE), parse_dates=["month"])
    fx = pd.read_csv(raw_path(ECB_FILE), parse_dates=["month"])
    w = wb.merge(fx, on="month", how="inner").sort_values("month")
    for c in ("thai_5pct", "viet_5pct"):
        w[f"{c}_eur_t"] = (w[f"{c}_usd_t"] / w["usd_per_eur"]).round(1)
    last, prev = w.iloc[-1], w[w["month"] == w["month"].iloc[-1] - pd.DateOffset(years=1)]
    prev = prev.iloc[0] if len(prev) else None

    def world(col: str) -> dict:
        return {
            "usd_t": float(last[f"{col}_usd_t"]), "eur_t": float(last[f"{col}_eur_t"]),
            "change_12m_usd_pct": _pct(float(last[f"{col}_usd_t"]), float(prev[f"{col}_usd_t"]) if prev is not None else None),
            "change_12m_eur_pct": _pct(float(last[f"{col}_eur_t"]), float(prev[f"{col}_eur_t"]) if prev is not None else None),
        }

    recent = w[w["month"] >= w["month"].iloc[-1] - pd.DateOffset(years=3)]
    src = load_sources()
    return {
        "as_of": paddy["week_start"].max().date().isoformat(),
        "paddy": rows,
        "world": {
            "month": last["month"].date().isoformat(),
            "usd_per_eur": float(last["usd_per_eur"]),
            "thai_5pct": world("thai_5pct"),
            "viet_5pct": world("viet_5pct"),
            "history": [
                {"month": r.month.date().isoformat(), "thai_5pct_eur_t": r.thai_5pct_eur_t,
                 "viet_5pct_eur_t": r.viet_5pct_eur_t}
                for r in recent.itertuples()
            ],
        },
        "sources": [src[k] for k in ("eu_rice", "worldbank_rice", "ecb_fx") if k in src],
    }
