# Linear Webhook

Cloudflare Worker for receiving Linear webhooks, validating signatures, and forwarding supported events to Telegram.

## Overview

This project provides a small webhook consumer built for Cloudflare Workers. It receives Linear webhook events at `/webhooks/linear`, verifies the request with HMAC-SHA256, rejects stale payloads to reduce replay risk, extracts safe metadata, then sends a Telegram notification for supported event types.

Supported Linear event types:

- `Issue`
- `Comment`

Unsupported event types are acknowledged with `200` and marked as ignored to prevent Linear retry loops.

## Tech Stack

- **Cloudflare Workers** — runtime and hosting
- **Wrangler** — local development, secrets, deployment
- **ElysiaJS** — HTTP routing with Cloudflare Worker adapter
- **Bun** — package manager, scripts, tests
- **TypeScript** — source language

## Features

- Linear webhook endpoint: `POST /webhooks/linear`
- Health endpoint: `GET /health`
- Service info endpoint: `GET /`
- HMAC-SHA256 signature verification using raw request body
- Timestamp freshness validation with 60-second tolerance
- Timing-safe signature comparison
- Telegram notification delivery via Bot API
- Safe logging without raw payload or secret values
- Local signed payload generator for manual testing
- Unit/integration tests with Bun

## Requirements

- Bun
- Cloudflare Wrangler account/session for deployment
- Linear workspace webhook secret
- Telegram bot token and target chat ID

## Installation

Install dependencies:

```sh
bun install
```

Copy local Worker secrets template:

```sh
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with local values:

```env
LINEAR_WEBHOOK_SECRET=test-linear-webhook-secret
TELEGRAM_BOT_TOKEN=test-telegram-bot-token
TELEGRAM_CHAT_ID=test-telegram-chat-id
```

Do not commit `.dev.vars`, `.env`, real webhook secrets, Telegram bot tokens, or chat IDs.

## Environment Variables

| Name                    | Required                      | Description                                                     |
| ----------------------- | ----------------------------- | --------------------------------------------------------------- |
| `LINEAR_WEBHOOK_SECRET` | Yes                           | Secret used to verify `Linear-Signature` HMAC-SHA256 signature. |
| `TELEGRAM_BOT_TOKEN`    | Yes for notification delivery | Telegram bot token from BotFather.                              |
| `TELEGRAM_CHAT_ID`      | Yes for notification delivery | Target Telegram chat/channel/user ID.                           |

If Telegram config is missing, valid webhook requests still return `200`, but notification delivery is skipped and logged safely.

## Local Development

Start local Worker:

```sh
bun run dev
```

Default local URL:

```txt
http://localhost:8787
```

Check health:

```sh
curl http://localhost:8787/health
```

Expected response:

```txt
ok
```

## Webhook Endpoint

Linear should send webhook events to:

```txt
https://<your-worker-domain>/webhooks/linear
```

Local endpoint:

```txt
http://localhost:8787/webhooks/linear
```

Expected successful response:

```json
{ "received": true }
```

Unsupported event response:

```json
{ "received": true, "ignored": true }
```

Invalid signature response:

```txt
401 invalid signature
```

Invalid JSON response after signature verification:

```txt
400 invalid payload
```

Expired/future timestamp response:

```txt
401 expired timestamp
```

## Manual Verification

Generate a signed local payload:

```sh
LINEAR_WEBHOOK_SECRET=test-linear-webhook-secret bun run sign:payload -- --url http://localhost:8787/webhooks/linear
```

Run generated curl command directly:

```sh
LINEAR_WEBHOOK_SECRET=test-linear-webhook-secret bun run sign:payload -- --url http://localhost:8787/webhooks/linear | sh
```

Expected result: `200` with `{ "received": true }`.

Generate different event/action values:

```sh
LINEAR_WEBHOOK_SECRET=test-linear-webhook-secret bun run sign:payload -- \
  --url http://localhost:8787/webhooks/linear \
  --type Comment \
  --action create
```

Test invalid signature handling:

```sh
curl -i http://localhost:8787/webhooks/linear \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'Linear-Signature: sha256=00' \
  --data '{"webhookTimestamp":0,"type":"Issue"}'
```

Expected result: `401`.

## Tests and Checks

Run tests:

```sh
bun test
```

Run TypeScript type check:

```sh
bun run typecheck
```

## Deployment

Set production secrets through Wrangler:

```sh
wrangler secret put LINEAR_WEBHOOK_SECRET
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
```

Deploy Worker:

```sh
bun run deploy
```

After deployment, configure Linear webhook URL:

```txt
https://<your-worker-domain>/webhooks/linear
```

Use Linear webhook settings to send a test event and confirm Telegram delivery.

## Scripts

| Script                 | Description                                                    |
| ---------------------- | -------------------------------------------------------------- |
| `bun run dev`          | Start local Cloudflare Worker through Wrangler.                |
| `bun run deploy`       | Deploy Worker through Wrangler.                                |
| `bun run sign:payload` | Generate signed curl command for local/manual webhook testing. |
| `bun run typecheck`    | Run TypeScript check without emitting files.                   |
| `bun test`             | Run Bun test suite.                                            |

## Security Notes

- Signature verification uses raw request body. Do not parse or stringify JSON before verification.
- `Linear-Signature` is validated with HMAC-SHA256.
- Timestamp tolerance is 60 seconds to reduce replay attack risk.
- Logs include safe metadata only, not raw payloads or secret values.
- Secrets must be stored as Cloudflare Worker secrets in production.
- Local secret files are gitignored and must stay untracked.

## Project Structure

```txt
.
├── scripts/
│   └── sign-payload.ts      # Signed curl payload generator
├── src/
│   ├── crypto.ts            # HMAC and timing-safe comparison helpers
│   ├── index.ts             # Worker entrypoint and routes
│   ├── linear.ts            # Linear payload parsing and safe logging
│   └── telegram.ts          # Telegram message formatting and delivery
├── test/
│   └── index.test.ts        # Tests
├── .dev.vars.example        # Local Worker secret template
├── .env.example             # Env template
├── package.json
├── tsconfig.json
└── wrangler.jsonc
```

## License

Private project. No public license specified.
