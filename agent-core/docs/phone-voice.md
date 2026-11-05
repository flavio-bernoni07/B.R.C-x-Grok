# Phone disputes via Grok Voice

Inbound calls → xAI Speech-to-Speech → our tools → same Mini ERP dispute path as `/support` chat → **Disputes**.

## Env (in `agent-core/.env.local`)

```bash
XAI_API_KEY=xai-...                 # grok.com or console.x.ai key
XAI_VOICE_WEBHOOK_SECRET=whsec_...  # only for Direct SIP webhook path (below)
BRC_PUBLIC_BASE_URL=https://....    # tunnel URL — do this BEFORE registering a webhook
BRC_PHONE_ALLOWLIST=+39...          # optional; your mobile for demos
# BRC_PHONE_DEMO_OPEN=0             # set to reject non-allowlisted callers
# BRC_PHONE_ALLOW_UNSIGNED_WEBHOOK=1  # local fixture posts only — never in prod
```

## Do this order

1. **Key** in `.env.local` (`XAI_API_KEY`) — you already did this.
2. **Step C — tunnel** (public HTTPS) — needed before any webhook.
3. **Step B — number** — pick Path 1 (easiest for demo) or Path 2 (full SIP).
4. Or skip the phone and use **simulate** (still creates a real `DSP-…` under Disputes).

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
3. Paste the playbook from `PHONE_INSTRUCTIONS` in `agent/lib/dispute/phone_agent.ts` (or the block below). Core rule: **ask only for missing fields**, including **which retailer** (Esselunga / Carrefour / …) if not said yet.
4. Add an **API Request** tool named `submit_dispute`:
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
5. Find **Phone number** / telephony on the agent (often near Publish / Live). Claim the **free US number**. Note the number.
6. **Publish / Live** the agent (drafts stay silent).
7. Call that number → expect a spoken `DSP-…` → open **Disputes**.

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

## Smoke-check Voice key

```bash
pnpm voice:check
```

Loads `.env.local` and checks whether the key can list phone numbers (does not print the key).
