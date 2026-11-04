# planning: guide for coding agents

The Python side of the paddy price forecaster: it downloads public data and computes a statistical baseline. The Rice Agent (`../agent-core`) calls it through a JSON command line interface (CLI). Plan and context: the "Forecast and quality" section of `../DECISIONS.md`.

## Run

Use uv only; never pip or a system Python.

```bash
uv sync                                    # once (Python 3.10-3.12)
uv run python -m rice_forecast fetch       # download sources into ../data/raw/
uv run python -m rice_forecast varieties   # paddy varieties with enough history
uv run python -m rice_forecast market      # latest paddy and world prices
uv run python -m rice_forecast forecast --variety Carnaroli --horizon 8
```

## The CLI contract

- stdout is **exactly one line of JSON**. Prophet and cmdstan output is captured, and warnings go to stderr. Errors print `{"error": "..."}` and exit 1.
- The output shapes are mirrored by TypeScript types in `../agent-core/agent/lib/rice.ts` (`MarketSnapshot`, `PriceForecast`). **If you change a field, update those types and the UI cards** in `../agent-core/apps/web/components/rice/`.
- Data paths come from `paths.py`: `../data/raw/` by default, or `RICE_DATA_DIR` if set. Request-time commands read only local files. Only `fetch` touches the internet. If the raw files are missing, the other commands run `fetch` first.

## Modules

| File | Does |
|---|---|
| `sources.py` | One downloader per source, writing CSV plus `sources.json` (URL, rows, latest date, retrieved time). The EU API lives at `api.tech.ec.europa.eu`. The World Bank Pink Sheet link changes monthly, so it is scraped from the commodity-markets page with a fallback URL |
| `model.py` | Paddy series per variety, the Prophet baseline, the rolling backtest, and the market snapshot. Results are cached in `../data/out/` and keyed on `MODEL_VERSION` and the raw file's mtime |
| `__main__.py` | The CLI |

## What we learned about the model (don't relearn it)

- Paddy prices behave close to a random walk over 8 weeks. **Plain Prophet loses badly to "price stays the same"**: Carnaroli error €315/t against €39/t, because its trend level lags after the 2022-25 boom and crash.
- Current model: Prophet on log price with `growth="flat"` and yearly seasonality (Fourier order 4), **anchored on the last observed price**. Prophet supplies only the seasonal drift. The 80% band comes from the empirical 10th/90th percentile of past h-week log price moves. Result: error close to naive but not better (Carnaroli €51 vs €39), and the band holds the real price 80–93% of the time.
- The backtest refits at past origins using only data up to that date (no lookahead), every 4 weeks over 2 years, and scores the price at the horizon. Keep it honest: report `prophet_beats_naive` even when it's false. The agent's skill relies on that flag.
- Ideas not tried yet: world price (Thai 5% in EUR) as a lagged regressor, Ente Nazionale Risi farmer stocks, a model of the price change instead of the level (e.g. gradient boosting on returns), per DECISIONS.md.

## When you change the model

1. Bump `MODEL_VERSION` in `model.py` (this invalidates the cache).
2. Compare old and new with the backtest on several varieties (Carnaroli, Arborio, Selenio, Long B, Baldo, Roma), using `backtest()` error and band coverage. Keep the change only if it helps.
3. Update the `model` string and the `caveat` in the output. Update this file's findings.

## Adding a data source

Add a `fetch_*` function in `sources.py` that writes a CSV to `RAW_DIR` and returns a metadata dict (`file`, `name`, `url`, `rows`, `latest`, `retrieved`). Register it in `fetch_all()`, and cite it in the output's `sources`. Candidates from DECISIONS.md: Ente Risi stocks (PDF), Open-Meteo weather, MODIS NDVI.
