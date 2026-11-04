/**
 * The single data layer for the rice forecaster. The agent's tools and the web UI's API routes
 * both call these functions, so the dashboard and Grok always see the same numbers.
 *
 * Price data and the Prophet baseline live in the Python package at <repo>/planning
 * (run through uv). News comes from Grok's own web and X search.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { xai } from "@ai-sdk/xai";
import { generateText } from "ai";

const run = promisify(execFile);

export type Source = {
  file?: string;
  name?: string;
  url?: string;
  latest?: string;
  retrieved?: string;
};

export type PaddyQuote = {
  variety: string;
  type: string;
  as_of: string;
  price_eur_t: number;
  change_4w_pct: number | null;
  change_52w_pct: number | null;
};

export type WorldPrice = {
  usd_t: number;
  eur_t: number;
  change_12m_usd_pct: number | null;
  change_12m_eur_pct: number | null;
};

export type MarketSnapshot = {
  as_of: string;
  paddy: PaddyQuote[];
  world: {
    month: string;
    usd_per_eur: number;
    thai_5pct: WorldPrice;
    viet_5pct: WorldPrice;
    history: { month: string; thai_5pct_eur_t: number; viet_5pct_eur_t: number }[];
  };
  sources: Source[];
};

export type ForecastPoint = { date: string; mean: number; lower: number; upper: number };

export type PriceForecast = {
  variety: string;
  unit: string;
  model: string;
  as_of: string;
  last_price: number;
  change_4w_pct: number | null;
  change_52w_pct: number | null;
  horizon_weeks: number;
  forecast_end: ForecastPoint & { change_pct: number | null };
  history: { date: string; price: number }[];
  forecast: ForecastPoint[];
  backtest: {
    origins: number;
    horizon_weeks?: number;
    mae_prophet_eur_t?: number;
    mae_naive_eur_t?: number;
    mape_prophet_pct?: number;
    mape_naive_pct?: number;
    prophet_beats_naive?: boolean;
    band_coverage_pct?: number;
    period?: string;
  };
  sources: Source[];
  caveat: string;
};

export type NewsResult = {
  query: string;
  summary: string;
  sources: { url: string; title?: string }[];
  searched_at: string;
};

/** Finds <repo>/planning from the working directory (agent-core or apps/web) or RICE_REPO_ROOT. */
function planningDir(): string {
  const fromEnv = process.env.RICE_REPO_ROOT;
  if (fromEnv) return join(resolve(fromEnv), "planning");
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, "planning", "pyproject.toml");
    if (existsSync(candidate)) return dirname(candidate);
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Cannot find planning/pyproject.toml; set RICE_REPO_ROOT.");
    dir = parent;
  }
}

async function cli<T>(args: string[]): Promise<T> {
  const cwd = planningDir();
  let stdout: string;
  try {
    ({ stdout } = await run("uv", ["run", "--quiet", "python", "-m", "rice_forecast", ...args], {
      cwd,
      timeout: 300_000,
      maxBuffer: 20 * 1024 * 1024,
    }));
  } catch (error) {
    // The CLI prints {"error": ...} on stdout and exits 1.
    const out = (error as { stdout?: string }).stdout;
    if (out) stdout = out;
    else throw error;
  }
  const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as T & { error?: string };
  if (parsed && typeof parsed === "object" && "error" in parsed && parsed.error) {
    throw new Error(parsed.error);
  }
  return parsed;
}

export function getMarketSnapshot(): Promise<MarketSnapshot> {
  return cli<MarketSnapshot>(["market"]);
}

export function getPriceForecast(variety: string, horizonWeeks = 8): Promise<PriceForecast> {
  return cli<PriceForecast>(["forecast", "--variety", variety, "--horizon", String(horizonWeeks)]);
}

export function refreshData(): Promise<Record<string, Source & { rows: number }>> {
  return cli(["fetch"]);
}

/** Grok's server-side web and X search (xAI Agent Tools), summarised with citations. */
export async function searchMarketNews(query: string, days = 30): Promise<NewsResult> {
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const { text, sources } = await generateText({
    model: xai.responses(process.env.GROK_SEARCH_MODEL ?? process.env.GROK_MODEL ?? "grok-4.7"),
    // Search is the slow part; keep reasoning low and the answer short.
    providerOptions: { xai: { reasoningEffort: "low" } },
    maxOutputTokens: 900,
    tools: {
      web_search: xai.tools.webSearch(),
      x_search: xai.tools.xSearch({ fromDate: from }),
    },
    system:
      "You research rice markets for an Italian rice miller that buys paddy. Search the web and X. " +
      "Report only facts you found, each with its date and source. Focus on what moves paddy and " +
      "milled rice prices: export bans or quotas (India, Vietnam, Thailand, Myanmar), EU tariffs " +
      "and trade deals (EU safeguard clause, EBA/Cambodia/Myanmar, Mercosur), Asian export prices, " +
      "Italian and EU harvest size and weather, Ente Nazionale Risi reports, currency moves. " +
      "Say for each fact whether it pushes prices up or down. Do at most 3 searches. " +
      "Answer in at most 6 short bullets, newest first.",
    prompt: `${query}\n\nOnly use news from ${from} onward unless older context is essential.`,
  });
  const seen = new Set<string>();
  const cited = sources
    .filter((s) => s.sourceType === "url")
    .map((s) => ({ url: s.url, title: s.title }))
    .filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)))
    .slice(0, 15);
  return { query, summary: text, sources: cited, searched_at: new Date().toISOString() };
}
