# Integration notes (customer dispute chat + voice)

There is no separate INTEGRATION.md at the repo root; contracts live in `PORTING.md`, `DECISIONS.md` and `dispute-dec.md`. This file documents the **customer dispute chat** and its **voice** MVP against the redesigned app (Home, Orders, Shipping, Stock, Disputes, Sign-off).

## What it reuses

| Existing piece | How the chat uses it |
|---|---|
| Mini ERP `claims` + `signoffs` | Disputes are `claims` with id `DSP-…`; employee cases are `signoffs` with `row=dispute`, `kind=customer_dispute` |
| `pullFacts` / threeway | Read-only evidence for the employee workspace |
| `chatJson` / Grok client | Intake classification when `XAI_API_KEY` is set; otherwise deterministic offline intake |
| Retailers master data | Simulated session binds to a retailer GLN (`BUYER001` = Esselunga) |
| Disputes page (`/disputes`) | Phone/chat claims appear with a channel badge; drawer uses `DisputeWorkspace` |
| Sign-off (`/signoff`) | Same `customer_dispute` case for a person to decide (no auto money) |
| `@ai-sdk/xai` | Transcription, speech (TTS), realtime ephemeral client secrets |

## Surfaces

- Customer UI: `/support` (microphone + text fallback)
- APIs: `/api/support/session`, `/chat`, `/disputes`, `/voice/token`, `/voice/transcribe`, `/voice/speak`
- Phone: `/api/telephony/incoming` (xAI SIP webhook), `/api/telephony/simulate` (offline rehearsal / Voice Agent Builder tool). Laptop demo: `pnpm phone:demo` (see `docs/phone-voice.md`)
- Employee list: `/disputes` (and `/api/disputes`); workspace API `/api/actions/disputes` still feeds the drawer
- Notifications table + conversation transcripts as `documents` kind `customer conversation`

**Removed:** `/portal` page and `/api/portal/*`, and `portal_conversations` / `portal_messages` tables.

## Phone flow (Grok Voice)

1. Caller dials the free xAI number (or BYO SIP).
2. xAI POSTs signed `realtime.call.incoming` to `/api/telephony/incoming`.
3. Server verifies Standard Webhooks signature, joins `wss://api.x.ai/v1/realtime?call_id=…`.
4. Voice tools: `lookup_order` (read-only) and `submit_dispute` → `handleCustomerMessage` with `channel=phone`.
5. Agent speaks `DSP-…` only after ERP success. Setup: `docs/phone-voice.md`.

## Voice flow (MVP)

1. Customer taps mic → browser records (permission required).
2. Audio POSTs to `/api/support/voice/transcribe` (xAI STT server-side) **or** browser `SpeechRecognition` fallback.
3. Draft text is shown for edit/confirm.
4. Confirmed text POSTs to `/api/support/chat` → `handleCustomerMessage` (existing dispute workflow).
5. Only after backend success does the UI show a `DSP-…` reference / status.
6. Optional: read replies aloud via `/api/support/voice/speak`.
7. Optional: `/api/support/voice/token` mints an ephemeral xAI realtime secret for browser WebSocket speech-to-speech — permanent key never leaves the server. Realtime is for natural dialogue drafts; dispute creation still requires the confirmed chat POST.

## Auth

**Simulated only.** Cookie `brc_support_retailer` + banner label.

## Safety

Never emits TD04 / refunds from the customer chat. Voice never claims a dispute was submitted until `/api/support/chat` returns `submitted: true`.
