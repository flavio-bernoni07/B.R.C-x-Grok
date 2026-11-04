"""Download the public price data into data/raw/ as CSV, with a sources.json that records
where and when each file came from. Every later step reads these files, never the internet."""

from __future__ import annotations

import io
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests

from .paths import RAW_DIR

EU_RICE_URL = "https://api.tech.ec.europa.eu/agrifood/api/rice/prices"
ECB_URL = "https://data-api.ecb.europa.eu/service/data/EXR/M.USD.EUR.SP00.A?format=csvdata"
WB_PAGE_URL = "https://www.worldbank.org/en/research/commodity-markets"
# Fallback if the page layout changes; the link rotates with each monthly update.
WB_FALLBACK_URL = (
    "https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/"
    "related/CMO-Historical-Data-Monthly.xlsx"
)

EU_FILE = "eu_rice_prices_it.csv"
ECB_FILE = "ecb_usd_eur_monthly.csv"
WB_FILE = "worldbank_rice_monthly.csv"
SOURCES_FILE = "sources.json"

HEADERS = {"User-Agent": "rice-forecast/0.1 (hackathon research script)"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fetch_eu_prices(begin: str = "01/09/2015") -> dict:
    """Italian rice prices per variety and stage, weekly since 2015 (EU Agri-food Data Portal)."""
    end = datetime.now().strftime("%d/%m/%Y")
    params = {"memberStateCodes": "IT", "beginDate": begin, "endDate": end}
    resp = requests.get(EU_RICE_URL, params=params, headers=HEADERS, timeout=120)
    resp.raise_for_status()
    df = pd.DataFrame(resp.json())
    df["week_start"] = pd.to_datetime(df["beginDate"], format="%d/%m/%Y")
    df["price_eur_t"] = (
        df["price"].astype(str).str.replace("€", "", regex=False).str.replace(",", "", regex=False)
    )
    df["price_eur_t"] = pd.to_numeric(df["price_eur_t"], errors="coerce")
    # A price of 0.00 means a missing week, not a free week.
    df.loc[df["price_eur_t"] <= 0, "price_eur_t"] = pd.NA
    out = df[["week_start", "stage", "type", "variety", "price_eur_t", "marketingYear"]]
    out = out.dropna(subset=["price_eur_t"]).sort_values(["stage", "variety", "week_start"])
    out.to_csv(RAW_DIR / EU_FILE, index=False)
    return {
        "file": EU_FILE,
        "name": "EU Agri-food Data Portal, Italian rice prices",
        "url": f"{EU_RICE_URL}?memberStateCodes=IT&beginDate={begin}&endDate={end}",
        "rows": len(out),
        "latest": out["week_start"].max().date().isoformat(),
        "retrieved": _now(),
    }


def fetch_ecb_usd_eur() -> dict:
    """Monthly average USD per EUR (ECB)."""
    resp = requests.get(ECB_URL, headers=HEADERS, timeout=60)
    resp.raise_for_status()
    df = pd.read_csv(io.StringIO(resp.text))
    out = pd.DataFrame(
        {"month": pd.to_datetime(df["TIME_PERIOD"]), "usd_per_eur": df["OBS_VALUE"]}
    ).dropna()
    out.to_csv(RAW_DIR / ECB_FILE, index=False)
    return {
        "file": ECB_FILE,
        "name": "ECB euro reference rate, USD per EUR, monthly average",
        "url": ECB_URL,
        "rows": len(out),
        "latest": out["month"].max().date().isoformat(),
        "retrieved": _now(),
    }


def _worldbank_xlsx_url() -> str:
    try:
        page = requests.get(WB_PAGE_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=60).text
        found = re.findall(
            r"https://thedocs\.worldbank\.org[^\"']*CMO-Historical-Data-Monthly\.xlsx", page
        )
        if found:
            return found[0]
    except requests.RequestException:
        pass
    return WB_FALLBACK_URL


def fetch_worldbank_rice() -> dict:
    """Thai and Vietnamese export rice prices, USD per tonne, monthly (World Bank Pink Sheet)."""
    url = _worldbank_xlsx_url()
    resp = requests.get(url, headers=HEADERS, timeout=180)
    resp.raise_for_status()
    sheet = pd.read_excel(io.BytesIO(resp.content), sheet_name="Monthly Prices", header=None)
    names = [str(v).strip() for v in sheet.iloc[4].tolist()]
    wanted = {"Rice, Thai 5%": "thai_5pct_usd_t", "Rice, Viet Namese 5%": "viet_5pct_usd_t"}
    cols = {i: wanted[n] for i, n in enumerate(names) if n in wanted}
    if len(cols) != len(wanted):
        raise RuntimeError(f"World Bank sheet layout changed; found {names[:40]}")
    body = sheet.iloc[6:, [0, *cols]].copy()
    body.columns = ["period", *cols.values()]
    body = body[body["period"].astype(str).str.match(r"^\d{4}M\d{2}$")]
    body["month"] = pd.to_datetime(body["period"].str.replace("M", "-") + "-01")
    for c in cols.values():
        body[c] = pd.to_numeric(body[c], errors="coerce")
    out = body[["month", *cols.values()]].dropna()
    out = out[out["month"] >= "2010-01-01"]
    out.to_csv(RAW_DIR / WB_FILE, index=False)
    return {
        "file": WB_FILE,
        "name": "World Bank Pink Sheet, monthly commodity prices (rice)",
        "url": url,
        "rows": len(out),
        "latest": out["month"].max().date().isoformat(),
        "retrieved": _now(),
    }


def fetch_all() -> dict:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    meta = {
        "eu_rice": fetch_eu_prices(),
        "ecb_fx": fetch_ecb_usd_eur(),
        "worldbank_rice": fetch_worldbank_rice(),
    }
    (RAW_DIR / SOURCES_FILE).write_text(json.dumps(meta, indent=2))
    return meta


def load_sources() -> dict:
    path = RAW_DIR / SOURCES_FILE
    return json.loads(path.read_text()) if path.exists() else {}


def raw_ready() -> bool:
    return all((RAW_DIR / f).exists() for f in (EU_FILE, ECB_FILE, WB_FILE, SOURCES_FILE))


def raw_path(name: str) -> Path:
    return RAW_DIR / name
