# Linear Webhook

Cloudflare Worker for receiving Linear webhooks, validating signatures, queueing supported events, and forwarding notifications to Telegram.

## Overview

This project provides a small webhook consumer built for Cloudflare Workers. It receives Linear webhook events at `/webhooks/linear`, verifies the request with HMAC-SHA256, rejects stale payloads to reduce replay risk, extracts safe metadata, then enqueues Telegram notifications for supported event types. Queue consumers retry Telegram delivery without forcing Linear to retry accepted webhooks.

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

## Documentation

- [Deployment and Cloudflare setup](docs/deployment.md) — Queue, KV, secrets, deploy, verification, and troubleshooting.

## Features

- Linear webhook endpoint: `POST /webhooks/linear`
- Health endpoint: `GET /health`
- Service info endpoint: `GET /`
- HMAC-SHA256 signature verification using raw request body
- Timestamp freshness validation with 60-second tolerance using payload `webhookTimestamp` or `Linear-Timestamp` header fallback
- Timing-safe signature comparison
- Telegram notification delivery via Bot API
- Cloudflare Queue delivery retries for Telegram failures
- KV-backed idempotency guard using `Linear-Delivery` or `webhookId`, with `queued`, `sent`, and `failed` delivery states
- Human-readable Telegram notifications for issue/comment events without debug-only fields and with deterministic Telegram length limits
- Safe logging without raw payload or secret values
- Local signed payload generator for manual testing
- Unit/integration tests with Bun

## Requirements

- Bun
- Node.js `>=16.17.0`
- Cloudflare account
- Cloudflare Wrangler account/session for deployment
- Linear workspace webhook secret
- Telegram bot token and target chat ID

## Installation

Check runtime versions:

```sh
node -v
bun -v
```

Install dependencies:

```sh
bun install
```

Wrangler is installed as a project dev dependency. Check version:

```sh
bunx wrangler --version
```

Optional global install:

```sh
npm install -g wrangler
wrangler --version
```

Log in to Cloudflare:

```sh
bunx wrangler login
```

Verify active Cloudflare account:

```sh
bunx wrangler whoami
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

Cloudflare bindings:

| Binding                | Required for reliable delivery | Description                                                    |
| ---------------------- | ------------------------------ | -------------------------------------------------------------- |
| `NOTIFICATION_QUEUE`   | Yes                            | Queue used to decouple webhook acceptance from Telegram sends. |
| `PROCESSED_DELIVERIES` | Yes                            | KV namespace storing processed `Linear-Delivery`/`webhookId`.  |

If Telegram config is missing, valid webhook requests still return `200`, but notification delivery is skipped and logged safely.

## Local Development

Start local Worker:

```sh
bun run dev
```

Wrangler rejects future compatibility dates. Keep `compatibility_date` in `wrangler.jsonc` on or before Wrangler's supported date; this project currently pins `2026-07-02`.

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

Expected successful response without Queue binding:

```json
{ "received": true }
```

Expected successful response with Queue binding:

```json
{ "received": true, "queued": true }
```

Duplicate delivery response:

```json
{ "received": true, "duplicate": true }
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

Full deployment guide: [Deployment and Cloudflare setup](docs/deployment.md).

Required Cloudflare resources:

- Queue: `linear-notifications`
- Workers KV namespace: `PROCESSED_DELIVERIES`
- Worker secrets: `LINEAR_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

Quick command list:

```sh
bunx wrangler queues create linear-notifications
bunx wrangler kv namespace create PROCESSED_DELIVERIES
bunx wrangler secret put LINEAR_WEBHOOK_SECRET
bunx wrangler secret put TELEGRAM_BOT_TOKEN
bunx wrangler secret put TELEGRAM_CHAT_ID
bunx wrangler deploy --dry-run
bun run deploy
```

After creating the KV namespace, update `wrangler.jsonc` with the generated namespace ID before deploying.

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
├── docs/
│   └── deployment.md        # Cloudflare setup and deployment guide
├── scripts/
│   └── sign-payload.ts      # Signed curl payload generator
├── src/
│   ├── crypto.ts            # HMAC and timing-safe comparison helpers
│   ├── index.ts             # Worker entrypoint, routes, and Queue consumer
│   ├── linear.ts            # Linear payload parsing and safe logging
│   ├── queue.ts             # Queue job delivery and idempotency helpers
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
