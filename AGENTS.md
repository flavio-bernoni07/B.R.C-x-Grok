# Guide for coding agents

Team B.R.C, Grok Hackathon Pavia 2026, Track B (Riso Scotti): a zero-touch back office for orders, invoices and disputes, plus paddy price forecasting. Read `README.md` for the process map, then the guide for the part you are changing.

## Where things are

| Path | What | Guide |
|---|---|---|
| `DECISIONS.md` | Decisions that change what another area receives. **Read it before designing anything.** Add a line when you change an interface | – |
| `docs/*.md` | One findings file per area (order, shipping, dispute, core) and the process map | – |
| `agent-core/` | **Rice Agent**: the eve agent (TypeScript, pnpm) with Grok, its tools and skills, and the Next.js web UI | `agent-core/AGENTS.md` |
| `planning/` | Python forecaster (uv): data downloaders, Prophet baseline, backtest. Called by the agent's tools | `planning/AGENTS.md` |
| `data/raw/` | Public price data written by `planning` (committed, so the demo works offline). `sources.json` records where each file came from | – |
| `data/out/` | Forecast cache, gitignored, rebuilt automatically | – |
| `data/disputes/` | Synthetic dispute world (claims, ERP, verdicts) | `dispute/README.md` |
| `dispute/`, `tests/` | Dispute row in Python (root `pyproject.toml`, pytest) | `dispute/README.md` |

## Team rules that apply to code

- **Every number has a source.** Tools return the file, URL or record each figure came from; the UI and the agent cite it. No invented data.
- **People sign off.** The agent advises, a person decides: every paddy purchase, and every ORDRSP. Never build an automatic purchase or send.
- **Code checks first, Grok on exceptions.** Deterministic code parses and checks. Grok handles what fails the checks, and corrections go back through the checks.
- **Measure against a baseline.** Any model result is reported next to a simple baseline, honestly, even when the baseline wins.
- Keep the demo runnable offline except for Grok calls: read local files, never the internet, at request time.

## Git

- Work on a branch. `main` is shared.
- Commit messages: short imperative subject, explaining what changed and why.
- Don't commit `.env.local`, `node_modules/`, `.venv/`, `.eve/`, `.next/` or `data/out/`.
