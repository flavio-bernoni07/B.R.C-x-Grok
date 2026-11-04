# Porting the Python rows to the app (TypeScript)

The final app is `agent-core/`: one Next.js 16 app that also hosts the eve agent (Rice Agent / B.R.C x Grok). The Python rows in the repo root (`core/`, `order/`, `shipping/`, `dispute/`, `bench/`) are the reference implementation. This file is the contract every port follows. The design rules in `../DECISIONS.md`, `../order-dec.md`, `../dispute-dec.md` and `../grok-agent-dec.md` apply unchanged.

## One feature, three faces

Every feature the UI can use is written once, in `agent/lib/<row>/`, and exposed three ways:

1. **Agent tool**: `agent/tools/<row>_<verb>.ts` (`defineTool` from `eve/tools`, Zod input, a `label`, and a description for the model that names its sources).
2. **API route**: `apps/web/app/api/<row>/.../route.ts`, calling the same lib function.
3. **Component**: `apps/web/components/<row>/*.tsx`, built only from the kit (`@/components/kit`). The same component renders on the row's page *and* as the chat card when the agent calls the tool.

## Foundation (already written, do not edit; ask if you need a change)

| Module | What |
|---|---|
| `agent/lib/core/erp.ts` | `Erp` class: port of `core/erp.py`. Same tables and columns (`agent/lib/db/schema.ts`, Drizzle). Methods are camelCase versions of the Python ones (`saveOrder`, `order`, `orders`, `setOrder`, `confirmLine`, `saveShipment`, `shipments`, `saveInvoice`, `invoices`, `addProof`, `proofs`, `saveClaim`, `setClaim`, `claim(s)`, `signoff(s)`, `addDocument`, `documents`, `nextId`, `log`, `auditLog`, `tx`). `erp.db` is the Drizzle handle, `erp.sqlite` the raw better-sqlite3 handle |
| `agent/lib/core/stock.ts` | `recordEvent`, `batches`, `availableToPromise`, `allocate`, `committedQty`, `nextReadyDate`, `isoDate` |
| `agent/lib/core/signoff.ts` | `requestSignoff`, `pending`, `decide`, `recordPastCase` |
| `agent/lib/core/world.ts` | `loadWorld`, `freshErp(":memory:")` for tests |
| `agent/lib/core/digest.ts` | `buildDigest` |
| `agent/lib/core/checks.ts` | `numbersIn`, `unknownNumbers` |
| `agent/lib/grok/client.ts` | `chatJson(messages, { task, validate, caller })`, `hasKey`, `GrokAnswerRejected`, `MissingApiKeyError`. Async. `caller` replaces the network (recorded answers) |
| `agent/lib/db/app.ts` | `getReadyErp()`: the app's database (`data/app.sqlite`). Tools and routes use it; tests use `freshErp()` |
| `agent/lib/paths.ts` | `repoRoot()`, `dataPath(...)` to read fixtures in `../data/` |

## Naming and data shapes

- **ERP rows** (what `Erp` returns) are camelCase objects (`orderRef`, `qtyConfirmed`, `sourceDoc`).
- **Everything that is a JSON document** keeps the Python key names exactly (snake_case): hand-over payloads between rows, Grok request/answer JSON, proposals stored in the sign-off queue, claim extractions and verdicts, the dispute catalog, fixtures in `../data/`. That way stored JSON, fixtures and recorded Grok answers stay compatible with the Python code.
- Functions: camelCase of the Python name, same argument order (first argument `erp: Erp`), keyword arguments become one options object. Anything that calls Grok becomes `async`.
- IDs, statuses, document kinds, audit action names and messages stay identical to Python (the UI and the digest read them).

## Rules the port keeps

- Code writes every document and every amount. Grok proposes JSON; code validates; a person decides when it is unclear. Grok never writes an amount.
- No euro threshold anywhere. Order: a person always confirms before ORDRSP. Shipping: an employee in the case role approves every exception resolution. Dispute: sign-off only when ambiguous (unsure or confidence < 0.55, a point with no source, a claim type not in the Playbook, a missing document, an amount not in the documents).
- **No agent tool approves a sign-off or decides a case.** The person does that in the UI (the sign-off card posts to the API). Tools can list, explain, run code checks, prepare proposals and run actions that are already approved.
- Without an API key, every Grok step falls back to the recorded answers or to what code can do alone, or stops at a person, exactly as in Python.
- Every action is written to the audit log with the same actor names (`code`, `grok`, `retailer`, `person:<name>`).

## Sign-off decisions

The app has one sign-off page and one sign-off card for every row. When a person decides, the generic route calls the row's own decision path. Each row exports, from `agent/lib/<row>/decide.ts`:

```ts
export async function decideSignoff(
  erp: Erp,
  caseId: string,
  d: { approve: boolean; by: string; reason: string; edits?: Record<string, unknown> | null },
): Promise<Record<string, unknown>>
```

It runs exactly what the Python row does after a person decides: Order confirms (ORDRSP + hand-over) or rejects, Shipping decides and executes the exception resolution, Dispute approves or rejects the verdict and writes the outcome. It returns a JSON summary for the UI.

## Cross-row hand-overs

- Order to Shipping: `confirmOrder` returns the hand-over payload (Python `confirm_order` shape). Shipping's `ingestConfirmedOrder(erp, payload)` takes it.
- Shipping to Dispute: `exportForDispute(erp, orderRef?)` in `agent/lib/shipping/service.ts` returns the catalog shape of `../data/disputes/erp/catalog.json` (keys `orders`, `desadv`, `invoices`, `proofs`).
- threeway: ported once, in `agent/lib/threeway/core.ts` (from `dispute/_threeway_core.py`), used by Dispute's `pullFacts` and by the benchmark.
- Seller data for FatturaPA: `agent/lib/core/seller.ts`.

## Documents

EDI (ORDERS, ORDRSP, DESADV, INVOIC 380/381) and FatturaPA XML (TD01, TD04) are written by code as strings, stored with `erp.addDocument(kind, ref, body)`. The Python side validates FatturaPA with `a38`; the TypeScript port writes the same XML structure and keeps the `SIMULATED` markers. Keep the document `kind` strings identical (the digest counts `FatturaPA TD04`).

## Tests

Port the relevant Python tests in `../tests/` to Vitest in `agent-core/tests/<row>.test.ts`, using `freshErp()` and offline callers. Run with `pnpm exec vitest run`.

## Components

- Use only `@/components/kit` (Pill, Panel, Stat, DataTable, Segmented, PageHeader, SourceTag, Facts, eur, qty, day) and the icons in `@/components/kit/icons`. Tailwind classes use the brand tokens (`text-ink`, `text-ink-68`, `bg-hh-seasalt`, `bg-hh-honeydew`, `bg-st-attention` ...). No other colours, no new fonts, sentence case, no all caps.
- Status pills follow `components/kit/index.tsx`: `ok` done, `grok` Grok acted on its own, `attention` a person must act, `wait` checking.
- Each row exports from `apps/web/components/<row>/index.ts`:
  - `<Row>View`: the client component for the row's page (fetches its API routes),
  - `cards`: a map from tool name to a component `(props: { output: unknown }) => ReactNode` that renders that tool's result in chat.
- Components are client components (`"use client"`), fetch through the row's API routes, and import types only (`import type`) from `@agent/lib/...`.
