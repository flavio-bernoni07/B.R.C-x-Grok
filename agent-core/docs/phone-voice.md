# Phone disputes via Grok Voice

Inbound calls → xAI Speech-to-Speech → our tools → same Mini ERP dispute path as `/support` chat → **Actions → Disputes**.

## Env (in `agent-core/.env.local`)

```bash
XAI_API_KEY=xai-...                 # grok.com or console.x.ai key
XAI_VOICE_WEBHOOK_SECRET=whsec_...  # shown once when you register the number
BRC_PUBLIC_BASE_URL=https://....    # tunnel URL (step C)
BRC_PHONE_ALLOWLIST=+39...          # optional; your mobile for demos
# BRC_PHONE_DEMO_OPEN=0             # set to reject non-allowlisted callers
# BRC_PHONE_ALLOW_UNSIGNED_WEBHOOK=1  # local fixture posts only — never in prod
```

## Your setup (after code is running)

### B — Free xAI number
1. Open [console.x.ai](https://console.x.ai) → team **grok hackathon** → **Voice Agents (Beta)** or **Voice**.
2. Claim / attach the **free provisioned number**, or register via API once the webhook URL exists (`POST /v2/phone-numbers` with webhook URL).
3. Set the webhook URL to: `{BRC_PUBLIC_BASE_URL}/api/telephony/incoming`
4. Copy the **webhook signing secret** (`whsec_…`) into `.env.local` as `XAI_VOICE_WEBHOOK_SECRET`.

### C — Public tunnel
1. Run the web app: `pnpm dev:web` (from `agent-core`).
2. In another terminal: `npx cloudflared tunnel --url http://localhost:3000` (or ngrok).
3. Put the `https://…` URL in `BRC_PUBLIC_BASE_URL` and on the xAI number webhook.

### Demo script
Call the number and say: *“Ordine ORD-3001, Carnaroli: ne abbiamo ricevuti solo 1100 su 1200.”*  
Expect a spoken `DSP-…`, then open **Actions → Disputes**.

## Offline rehearsal (no phone)

```bash
curl -s -X POST http://localhost:3000/api/telephony/simulate \
  -H 'content-type: application/json' \
  -d '{"order_ref":"ORD-3001","category":"shortage","claimed_quantity":1100,"customer_description":"Received only 1100 of 1200 Carnaroli","language":"en"}'
```

## Smoke-check Voice key

```bash
pnpm voice:check
```

Reports whether `XAI_API_KEY` is set and whether ephemeral realtime / phone-number list APIs respond (does not print the key).
