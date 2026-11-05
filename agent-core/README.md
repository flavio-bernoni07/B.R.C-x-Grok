# Risolve: the app

Riso Scotti's zero-touch back office in one window: orders checked by code, invoices matched against what shipped, claims answered with sources, and a person only when a case is unclear. Grok is the agent you talk to on the Overview. It can use and show every feature of the app.

- **Overview:** the agent's chat. The first message is the state of things: a short story, four numbers, the cases waiting for a person and the latest actions. Your questions and Grok's answers continue below. Tool results show as the same cards the pages use.
- **Orders, Shipping, Disputes:** one page per row, as in the B.R.C dashboard design.
- **Sign-off:** one desk for every row. A person approves or rejects and writes why.
- **Stock and Paddy prices:** what we can promise, and buy now or wait.

It runs fully locally: Next.js 16 with the [eve](https://github.com/vercel/eve) agent inside, Grok through xAI (`grok-4.7`), and one SQLite Mini ERP (Drizzle). There's no Vercel account, no Docker and no database server. The rows are a one-to-one port of the Python reference in the repo root. The design is the HeyHandy UI kit.

## Run

Requires Node 24 (`.nvmrc`), pnpm and [uv](https://docs.astral.sh/uv/).

```bash
cd agent-core
pnpm install
pnpm setup:py                 # Python env for the paddy price forecaster
cp .env.example .env.local    # set XAI_API_KEY=xai-...
pnpm db:reset                 # Mini ERP with the golden order run through every row
pnpm dev:web                  # starts the server and opens the Risolve app
```

Without a key, the app and every page still work. The golden demo uses recorded Grok answers; only chatting with the agent needs the key.

| Command | What |
|---|---|
| `pnpm dev:web` | The server, then the Risolve Mac app. If the server is already running, it just opens the app |
| `pnpm dev` | The agent alone, in eve's terminal UI |
| `pnpm db:reset` | Fresh Mini ERP plus the golden demo (`--empty` for the world only) |
| `pnpm test` | All Vitest suites (core, order, shipping, benchmark, dispute, golden) |
| `pnpm voice:check` | Smoke-check that `XAI_API_KEY` can list Voice phone numbers |
| `pnpm phone:demo` | Laptop demo: reset DB, start web, open tunnel, smoke `simulate` → Disputes, print Builder paste |
| `pnpm data:fetch` | Refresh the public paddy price data |

Customer phone claims (Grok Voice → Actions): see [`docs/phone-voice.md`](docs/phone-voice.md). Rehearse without a live number via `POST /api/telephony/simulate`.

## For developers

Read `AGENTS.md` (layout, principles, recipes) and `PORTING.md` (the contract between the TypeScript rows and the Python reference).

`.npmrc` must keep `ignore-workspace-root-check=true`, or `eve add …` fails with "Dependency installation failed". For the Web Chat installer, these answers keep everything local: `pnpm exec eve add channel/web --non-interactive --answer 'web-framework="next"' --answer 'web-hosting="next"' --answer 'web-authentication="custom"'`.
