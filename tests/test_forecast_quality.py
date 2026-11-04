"""Forecast and quality: market data, the buy-or-wait advisor, the memo, the lot photo check,
the demand forecast and the stock projection."""

from __future__ import annotations

import math
from datetime import date, timedelta
from pathlib import Path

import pytest

from core.world import fresh_erp
from forecast_quality import advisor, data, demand, memo, quality


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)


# ----- data -----------------------------------------------------------------

def test_eu_prices_zero_is_missing_and_thousands_parse() -> None:
    assert math.isnan(data.parse_eu_price("€0.00"))
    assert data.parse_eu_price("€1,346.00") == 1346.0
    rows = data.parse_eu_rows([{"beginDate": "19/10/2026", "price": "€672.00", "marketingYear": "2026/2027",
                                "stage": "Paddy", "type": "Japonica", "variety": "Carnaroli"}])
    assert rows[0]["week_start"] == "2026-10-19" and rows[0]["price_eur_t"] == 672.0


def test_fetch_names_the_url_when_the_api_answers_html(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(data, "_get", lambda url, timeout=120: b"<HTML>Redirect</HTML>")
    with pytest.raises(ValueError, match="ec.europa.eu/agrifood/api/rice/prices"):
        data.fetch_eu(date(2026, 9, 1), date(2026, 10, 31))


def test_committed_data_matches_the_research() -> None:
    carnaroli = dict(data.eu_series("Carnaroli"))
    assert carnaroli[date(2026, 10, 19)] == 672.0
    world = data.world_price_eur()
    assert round(world["2025-10"], 1) == 306.1 and round(world["2026-10"], 1) == 436.5


# ----- advisor --------------------------------------------------------------

def test_features_only_look_back() -> None:
    weeks = advisor.build_weeks("Carnaroli")
    w = next(x for x in weeks if x.week == date(2026, 10, 19))
    prices = dict(data.eu_series("Carnaroli"))
    assert w.features["trend_4w"] == pytest.approx(math.log(672.0 / prices[date(2026, 9, 21)]))
    assert math.isnan(w.target)  # 8 weeks ahead is not known yet


def test_even_buying_pays_the_average_price_and_the_rule_respects_the_silos() -> None:
    weeks = [advisor.Week("X", date(2020, 9, 7) + timedelta(weeks=i), p, {}, math.nan)
             for i, p in enumerate([500, 520, 540, 560, 580, 600])]
    even = advisor.simulate(weeks, None)
    assert even["cost_per_t"] == pytest.approx(sum(w.price for w in weeks) / 6)
    always_more = advisor.simulate(weeks, {w.week: 0.5 for w in weeks})
    assert always_more["end_stock"] <= advisor.MAX_COVER


def test_advice_has_a_call_and_sources_for_recent_varieties() -> None:
    calls = advisor.advice(["Carnaroli", "Loto"])
    assert [c["variety"] for c in calls] == ["Carnaroli"]  # Loto has no quote since 2024
    c = calls[0]
    assert c["call"] in {"BUY MORE", "WAIT", "BUY AS USUAL"} and c["price_eur_t"] == 672.0
    assert any("EU Agri-food" in s for s in c["sources"])
    text = memo.weekly_memo(calls)
    assert text["by"] == "code" and "Carnaroli: €672/t" in text["memo"]
    liar = memo.weekly_memo(calls, caller=lambda _m: {"memo": "Carnaroli will hit €900/t."})
    assert liar["by"] == "code"


# ----- quality ----------------------------------------------------------------

def test_photo_check_counts_broken_and_chalky_and_leaves_clumps_out(tmp_path: Path) -> None:
    img = tmp_path / "tray.png"
    quality.make_sample(img, whole=80, broken=8, chalky=4, clumps=2)
    a = quality.analyse(img)
    assert a["grains_measured"] == 88 and a["clumps_left_out"] == 2
    assert a["broken_pct"] == pytest.approx(100 * 8 / 88, abs=0.01)
    assert a["chalky_pct"] == pytest.approx(100 * 4 / 88, abs=0.01)


def test_yield_shortfall_prices_the_cut_and_routes_the_lot() -> None:
    sample = {"broken_pct": 20.0, "chalky_pct": 2.0, "grains_measured": 90, "clumps_left_out": 0}
    r = quality.lot_report(sample, variety="Carnaroli", lot="L1", tonnes=30, milled_price=2300, broken_price=460)
    assert r["whole_yield"] == 56.0 and r["points_below"] == 2.0
    assert r["eur_per_point"] == 18.4 and r["price_cut_eur_t"] == 18.4 and r["lot_value_cut_eur"] == 552.0
    assert r["destination"] == "rice drinks and rice cakes" and r["needs_lab_check"]
    clean = quality.lot_report(dict(sample, broken_pct=3.0), variety="Carnaroli", lot="L2", tonnes=30,
                               milled_price=2300, broken_price=460)
    assert clean["destination"] == "premium 1 kg packs" and not clean["needs_lab_check"]
    bad = quality.lot_report(dict(sample, broken_pct=35.0), variety="Carnaroli", lot="L3", tonnes=30,
                             milled_price=2300, broken_price=460)
    assert bad["decision"] == "can be refused"


def test_lot_check_holds_the_batch_until_the_lab_confirms(tmp_path: Path) -> None:
    from core.stock import available_to_promise
    from crm.actions import decide

    erp = fresh_erp()
    img = tmp_path / "tray.png"
    quality.make_sample(img, whole=72, broken=18, chalky=2, clumps=0)
    res = quality.check_lot(erp, img, variety="Carnaroli", lot="LOT-PADDY-17", tonnes=30, batch="LOT-C-0417")
    assert res["status"] == "awaiting_person"
    assert available_to_promise(erp, "8000000000001", "20261104")["held"] == 6000
    done = decide(erp, res["case_id"], approve=True, by="Lab, Pavia", reason="sample confirmed")
    assert done["done"].startswith("lot accepted")
    assert available_to_promise(erp, "8000000000001", "20261104")["held"] == 0


# ----- demand and projection ---------------------------------------------------

def test_forecast_beats_same_week_last_year_on_the_invented_history() -> None:
    s = demand.score()
    assert s["wape_ours"] < s["wape_baseline"]


def test_projection_counts_production_orders_and_suggests_a_batch() -> None:
    erp = fresh_erp()
    rows = demand.stock_projection(erp, "8000000000001", start=date(2026, 11, 4), weeks=4)
    assert rows[0]["opening"] == 12000 and rows[1]["production"] == 4000 and "LOT-C-0419" in rows[1]["sources"]
    assert rows[1]["opening"] == rows[0]["closing"]
    s = demand.production_suggestion(rows)
    assert s and s["short_from"] == rows[1]["week"] and s["qty"] > 0
