# Phone disputes via Grok Voice

Inbound calls → xAI Speech-to-Speech → our tools → same Mini ERP dispute path as `/support` chat → **Disputes**.

## Laptop demo (do this)

From `agent-core`, with `XAI_API_KEY` already in `.env.local`:

```bash
# macOS: install the tunnel binary once if you don't have it
brew install cloudflared

pnpm phone:demo
```

That resets the Mini ERP (when nothing is on `:3000`), starts the dashboard, opens a Cloudflare quick tunnel, smoke-tests `POST /api/telephony/simulate` (a real Phone `DSP-…` lands under Disputes), and prints the Voice Agent Builder URL to paste. Prefer Homebrew for `cloudflared`; the script falls back to a GitHub download.

Then in [console.x.ai](https://console.x.ai) → **Voice Agents**:

1. Welcome: `Hey, how's it going — how can I help you?`
2. Instructions: paste `docs/phone-builder-instructions.txt`
3. Tool `submit_dispute` → **POST** the tunnel URL the script printed (`…/api/telephony/simulate`)
4. Claim the free number → **Publish / Live**
5. Call and say: *Esselunga, order ORD-3001, shortage — received only 1100 of 1200 Carnaroli*
6. Open `http://127.0.0.1:3000/disputes` — Phone badge + `DSP-…`

Leave the `phone:demo` process running; each new quick-tunnel host needs a Builder tool URL update.

## Env (in `agent-core/.env.local`)

```bash
XAI_API_KEY=xai-...                 # grok.com or console.x.ai key
XAI_VOICE_WEBHOOK_SECRET=whsec_...  # only for Direct SIP webhook path (below)
BRC_PUBLIC_BASE_URL=https://....    # tunnel URL — do this BEFORE registering a webhook
BRC_PHONE_ALLOWLIST=+39...          # optional; your mobile for demos
# BRC_PHONE_DEMO_OPEN=0             # set to reject non-allowlisted callers
# BRC_PHONE_ALLOW_UNSIGNED_WEBHOOK=1  # local fixture posts only — never in prod
```

## Do this order (manual)

1. **Key** in `.env.local` (`XAI_API_KEY`) — you already did this.
2. **Step C — tunnel** (public HTTPS) — needed before any webhook.
3. **Step B — number** — pick Path 1 (easiest for demo) or Path 2 (full SIP).
4. Or skip the phone and use **simulate** (still creates a real `DSP-…` under Disputes).
   Prefer `pnpm phone:demo` above when you want the tunnel + smoke test in one go.

---

## Step C — Public tunnel (do this before Step B)

1. Terminal 1, from `agent-core`:
   ```bash
   pnpm db:reset
   pnpm dev:web
   ```
2. Terminal 2:
   ```bash
   npx cloudflared tunnel --url http://localhost:3000
   ```
   (or ngrok: `npx ngrok http 3000`)
3. Copy the `https://….trycloudflare.com` (or ngrok) URL.
4. Add to `.env.local`:
   ```bash
   BRC_PUBLIC_BASE_URL=https://YOUR-TUNNEL-HOST
   ```
5. Leave both terminals running.

---

## Step B — Getting a number (two paths)

### Path 1 — Voice Agent Builder free number (easiest, recommended for jury)

xAI’s **free phone number** lives in the **Voice Agents** UI. It answers with *their* builder agent, so we point that agent at our app with one HTTP tool.

1. Open [console.x.ai](https://console.x.ai) → team **grok hackathon** → **Voice Agents (Beta)**.
2. Open one of your **Untitled** agents, or click **Create agent** / **Customer Support**.
3. **Welcome message** (on in the Voice Agent UI): paste exact text  
   `Hey, how's it going — how can I help you?`  
   (same as `PHONE_WELCOME_MESSAGE` in `phone_agent.ts`). Leave **Caller can interrupt** on.
4. Paste the playbook from `docs/phone-builder-instructions.txt` (same text as `PHONE_INSTRUCTIONS` in `phone_agent.ts`). Core rule: **ask only for missing fields**, including **which retailer** (Esselunga / Carrefour / …) if not said yet.
5. Add an **API Request** tool named `submit_dispute`:
   - Method: **POST**
   - URL: `https://YOUR-TUNNEL-HOST/api/telephony/simulate`
   - Body JSON fields (**Generated**, not System):
     - `retailer` (string, required) — Esselunga, Carrefour, Conad, Coop, Auchan
     - `order_ref` (string, required)
     - `category` (string: shortage | pricing | damage | late_delivery | other)
     - `claimed_quantity` (number, optional)
     - `claimed_amount` (number, optional)
     - `customer_description` (string, required)
     - `language` (`en` or `it`)
6. Find **Phone number** / telephony on the agent (often near Publish / Live). Claim the **free US number**. Note the number.
7. **Publish / Live** the agent (drafts stay silent).
8. Call that number → expect a spoken `DSP-…` → open **Disputes**.

You do **not** need `XAI_VOICE_WEBHOOK_SECRET` for Path 1.

### Path 2 — Direct SIP webhook (our `/api/telephony/incoming`)

This is the “join WebSocket yourself” path. The free Builder number is **not** created this way. Docs: provisioning xAI numbers via API is **not** supported; API create is for **bring-your-own** numbers (`origin: "byo_trunk"`, e.g. Twilio).

You only need Path 2 if you later bring a Twilio/Telnyx number. Then:

1. Have `BRC_PUBLIC_BASE_URL` from Step C.
2. Register the number with webhook  
   `https://YOUR-TUNNEL-HOST/api/telephony/incoming`
3. Copy the one-time `whsec_…` into `.env.local` as `XAI_VOICE_WEBHOOK_SECRET`.
4. Restart `pnpm dev:web`.

---

## Offline rehearsal (no phone, no tunnel)

```bash
# Call 1 — Esselunga shortage
curl -s -X POST http://localhost:3000/api/telephony/simulate \
  -H 'content-type: application/json' \
  -d '{"retailer":"Esselunga","order_ref":"ORD-3001","category":"shortage","claimed_quantity":1100,"customer_description":"Received only 1100 of 1200 Carnaroli","language":"en"}'

# Call 2 — Carrefour damage
curl -s -X POST http://localhost:3000/api/telephony/simulate \
  -H 'content-type: application/json' \
  -d '{"retailer":"Carrefour","order_ref":"ORD-3003","category":"damage","claimed_quantity":60,"customer_description":"60 Arborio packs crushed on arrival at CeDi","language":"en"}'
```

Then open **Disputes** — you should see Phone-channel cases.

Clear claims (e.g. Esselunga shortage on `ORD-3001` where DESADV/invoice match) settle alone with no Sign-off. Ambiguous ones (e.g. damage on `ORD-3003`) open a normal verdict case for a person.

## Smoke-check Voice key

```bash
pnpm voice:check
```

Loads `.env.local` and checks whether the key can list phone numbers (does not print the key).
