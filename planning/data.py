"""Public market data for the purchasing advisor, kept as CSV in data/raw/ so everything
downstream runs offline and every number has a file it came from.

    python -m planning.data          # refresh all three sources

- EU Agri-food Data Portal: Italian rice prices per variety and stage, weekly since
  Sep 2015. "€0.00" means no quote that week: it becomes missing, never zero.
- ECB: USD per EUR, monthly.
- World Bank Pink Sheet: Thai 5% and Viet Nam 5% export prices, $/t, monthly.
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
import urllib.request
from datetime import date, datetime
from pathlib import Path
from typing import Any

RAW = Path(__file__).resolve().parents[1] / "data" / "raw"
EU_URL = ("https://ec.europa.eu/agrifood/api/rice/prices?memberStateCodes=IT"
          "&beginDate={begin}&endDate={end}")
ECB_URL = "https://data-api.ecb.europa.eu/service/data/EXR/M.USD.EUR.SP00.A?startPeriod={start}&format=csvdata"
WB_PAGE = "https://www.worldbank.org/en/research/commodity-markets"
SOURCES = {
    "eu": "EU Agri-food Data Portal, rice prices, Italy (ec.europa.eu/agrifood/api/rice/prices)",
    "ecb": "ECB data portal, EXR.M.USD.EUR.SP00.A",
    "wb": "World Bank Pink Sheet, CMO-Historical-Data-Monthly.xlsx",
}


def _get(url: str, timeout: int = 120) -> bytes:
    import ssl

    try:  # python.org builds on macOS ship without root certificates
        import certifi

        context = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        context = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": "brc-x-grok/0.1 (hackathon research)"})
    with urllib.request.urlopen(req, timeout=timeout, context=context) as resp:
        return resp.read()


def parse_eu_price(text: str) -> float:
    """'€1,346.00' -> 1346.0; '€0.00' -> nan (no quote that week)."""
    value = float(re.sub(r"[^\d.]", "", text or "") or 0)
    return math.nan if value == 0 else value


def parse_eu_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for r in rows:
        out.append({"week_start": datetime.strptime(r["beginDate"], "%d/%m/%Y").date().isoformat(),
                    "marketing_year": r.get("marketingYear"), "stage": r.get("stage"), "type": r.get("type"),
                    "variety": r.get("variety"), "price_eur_t": parse_eu_price(r.get("price", ""))})
    out.sort(key=lambda r: (r["variety"], r["stage"], r["week_start"]))
    return out


def fetch_eu(begin: date, end: date) -> list[dict[str, Any]]:
    url = EU_URL.format(begin=begin.strftime("%d/%m/%Y"), end=end.strftime("%d/%m/%Y"))
    body = _get(url).decode("utf-8", errors="replace")
    try:
        rows = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{url} did not answer with JSON: {body[:80]!r}") from exc
    if not isinstance(rows, list) or not rows:
        raise ValueError(f"{url} answered with no rows")
    return parse_eu_rows(rows)


def parse_ecb(text: str) -> list[dict[str, Any]]:
    reader = csv.DictReader(io.StringIO(text))
    return [{"month": r["TIME_PERIOD"], "usd_per_eur": float(r["OBS_VALUE"])} for r in reader if r.get("OBS_VALUE")]


def parse_pink_sheet(path: Path) -> list[dict[str, Any]]:
    import openpyxl

    ws = openpyxl.load_workbook(path, read_only=True, data_only=True)["Monthly Prices"]
    header = next(r for r in ws.iter_rows(min_row=1, max_row=12, values_only=True)
                  if any(c and str(c).startswith("Rice, Thai 5%") for c in r))
    thai = next(i for i, c in enumerate(header) if c and str(c).startswith("Rice, Thai 5%"))
    viet = next(i for i, c in enumerate(header) if c and "Viet" in str(c) and "5%" in str(c))
    out = []
    for r in ws.iter_rows(values_only=True):
        if r[0] and re.fullmatch(r"\d{4}M\d{2}", str(r[0])) and isinstance(r[thai], (int, float)):
            out.append({"month": f"{str(r[0])[:4]}-{str(r[0])[5:]}", "thai5_usd": float(r[thai]),
                        "viet5_usd": float(r[viet]) if isinstance(r[viet], (int, float)) else math.nan})
    return out


def _write(name: str, rows: list[dict[str, Any]]) -> Path:
    RAW.mkdir(parents=True, exist_ok=True)
    path = RAW / name
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0]))
        writer.writeheader()
        for row in rows:
            writer.writerow({k: ("" if isinstance(v, float) and math.isnan(v) else v) for k, v in row.items()})
    return path


def refresh(today: date | None = None) -> dict[str, Path]:
    today = today or date.today()
    eu = fetch_eu(date(2015, 9, 1), today)
    ecb = parse_ecb(_get(ECB_URL.format(start="2010-01")).decode("utf-8"))
    page = _get(WB_PAGE).decode("utf-8", errors="replace")
    link = re.search(r"https://thedocs\.worldbank\.org[^\"']*CMO-Historical-Data-Monthly\.xlsx", page)
    if not link:
        raise ValueError(f"no Pink Sheet link on {WB_PAGE}")
    xlsx = RAW / "pink_sheet.xlsx"
    RAW.mkdir(parents=True, exist_ok=True)
    xlsx.write_bytes(_get(link.group(0)))
    wb = [r for r in parse_pink_sheet(xlsx) if r["month"] >= "2010-01"]
    xlsx.unlink()
    return {"eu": _write("eu_rice_prices_it.csv", eu), "ecb": _write("ecb_usd_per_eur_monthly.csv", ecb),
            "wb": _write("world_rice_prices_monthly.csv", wb)}


def _read(name: str) -> list[dict[str, str]]:
    with (RAW / name).open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def _num(value: str) -> float:
    return float(value) if value not in ("", None) else math.nan


def eu_series(variety: str, stage: str = "Paddy") -> list[tuple[date, float]]:
    """Weekly prices for one variety, oldest first; nan where there was no quote."""
    rows = [r for r in _read("eu_rice_prices_it.csv") if r["variety"] == variety and r["stage"] == stage]
    if not rows:
        raise KeyError(f"no {stage} prices for {variety!r} in data/raw/eu_rice_prices_it.csv")
    return [(date.fromisoformat(r["week_start"]), _num(r["price_eur_t"])) for r in rows]


def world_price_eur() -> dict[str, float]:
    """Thai 5% export price in €/t per month (USD price / USD per EUR)."""
    fx = {r["month"]: _num(r["usd_per_eur"]) for r in _read("ecb_usd_per_eur_monthly.csv")}
    return {r["month"]: _num(r["thai5_usd"]) / fx[r["month"]]
            for r in _read("world_rice_prices_monthly.csv") if r["month"] in fx}


def main() -> int:
    for name, path in refresh().items():
        print(f"{SOURCES[name]} -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
