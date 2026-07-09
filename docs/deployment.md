# Deployment and Cloudflare Setup

This guide covers Cloudflare resources, secrets, configuration, deployment, and verification for the Linear webhook Worker.

## Required Cloudflare Resources

Create these resources once per environment:

| Resource          | Name / binding                                                    | Purpose                                                                                                           |
| ----------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Queue             | `linear-notifications` / `NOTIFICATION_QUEUE`                     | Decouples Linear webhook acceptance from Telegram delivery. Telegram failures retry from the Queue consumer.      |
| Dead Letter Queue | `linear-notifications-dlq`                                        | Receives notification jobs that still fail after Queue retries are exhausted.                                     |
| Workers KV        | `PROCESSED_DELIVERIES`                                            | Stores processed `Linear-Delivery` IDs, falling back to `webhookId`, to prevent duplicate Telegram notifications. |
| Worker secrets    | `LINEAR_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Signature verification and Telegram delivery config.                                                              |

## Prerequisites

- Bun installed.
- Cloudflare account with Workers enabled.
- Wrangler login/session.
- Linear webhook secret.
- Telegram bot token and target chat ID.

Install dependencies if needed:

```sh
bun install
```

Log in to Cloudflare:

```sh
bunx wrangler login
bunx wrangler whoami
```

## 1. Create Queue

```sh
bunx wrangler queues create linear-notifications
bunx wrangler queues create linear-notifications-dlq
```

`wrangler.jsonc` already expects these Queue names:

```jsonc
"queues": {
  "producers": [
    {
      "queue": "linear-notifications",
      "binding": "NOTIFICATION_QUEUE"
    }
  ],
  "consumers": [
    {
      "queue": "linear-notifications",
      "max_retries": 5,
      "dead_letter_queue": "linear-notifications-dlq"
    }
  ]
}
```

## 2. Create KV Namespace

```sh
bunx wrangler kv namespace create PROCESSED_DELIVERIES
```

Wrangler prints an ID. Copy that ID into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "PROCESSED_DELIVERIES",
    "id": "<kv-namespace-id-from-wrangler>"
  }
]
```

Do not leave `replace-with-kv-namespace-id` in production config.

## 3. Set Worker Secrets

Set production secrets through Wrangler:

```sh
bunx wrangler secret put LINEAR_WEBHOOK_SECRET
bunx wrangler secret put TELEGRAM_BOT_TOKEN
bunx wrangler secret put TELEGRAM_CHAT_ID
```

Use values from:

- Linear webhook settings: `LINEAR_WEBHOOK_SECRET`
- Telegram BotFather: `TELEGRAM_BOT_TOKEN`
- Telegram chat/channel/user ID: `TELEGRAM_CHAT_ID`

Do not commit real secret values to `.dev.vars`, `.env`, docs, or source files.

## 4. Local Development Config

For local development, copy template:

```sh
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with non-production test values:

```env
LINEAR_WEBHOOK_SECRET=test-linear-webhook-secret
TELEGRAM_BOT_TOKEN=test-telegram-bot-token
TELEGRAM_CHAT_ID=test-telegram-chat-id
```

Run local Worker:

```sh
bun run dev
```

Health check:

```sh
curl http://localhost:8787/health
```

Expected response when Queue and KV bindings are configured:

```json
{
  "status": "ok",
  "bindings": {
    "notificationQueue": { "configured": true, "status": "ok" },
    "processedDeliveries": { "configured": true, "status": "ok" }
  }
}
```

## 5. Verify Before Deploy

Run tests and type check:

```sh
bun test
bun run typecheck
```

Run a dry-run deploy:

```sh
bunx wrangler deploy --dry-run
```

If dry-run fails, check:

- Queue `linear-notifications` exists.
- Dead Letter Queue `linear-notifications-dlq` exists.
- KV namespace ID in `wrangler.jsonc` is real.
- `compatibility_date` is supported by installed Wrangler.
- Worker secrets are set in Cloudflare for production deploys.

## 6. Deploy

```sh
bun run deploy
```

Or:

```sh
bunx wrangler deploy
```

After deploy, Wrangler prints Worker URL.

## 7. Configure Linear Webhook

In Linear webhook settings, set URL:

```txt
https://<your-worker-domain>/webhooks/linear
```

Configure webhook secret in Linear. It must match `LINEAR_WEBHOOK_SECRET` stored in Cloudflare.

Supported event types:

- `Issue`
- `Comment`

Unsupported events return `200` with `{ "received": true, "ignored": true }` to avoid retry loops.

## 8. Post-Deploy Verification

Health check:

```sh
curl https://<your-worker-domain>/health
```

Expected response when Queue and KV bindings are configured:

```json
{
  "status": "ok",
  "bindings": {
    "notificationQueue": { "configured": true, "status": "ok" },
    "processedDeliveries": { "configured": true, "status": "ok" }
  }
}
```

Send a Linear test webhook and verify:

- Worker returns `200`.
- Response is `{ "received": true, "queued": true }` when Queue binding is active.
- Telegram notification arrives.
- Duplicate Linear delivery does not send duplicate Telegram notification.

## Runtime Behavior

### Normal flow

1. Worker receives `POST /webhooks/linear`.
2. Worker validates `Linear-Signature` with raw body.
3. Worker validates timestamp freshness from payload `webhookTimestamp`, falling back to `Linear-Timestamp` header.
4. Worker extracts safe metadata only.
5. Worker checks KV using `Linear-Delivery`, fallback `webhookId`.
6. Worker enqueues notification job.
7. Queue consumer sends Telegram notification.
8. Queue consumer marks delivery as `sent` in KV.

### Retry behavior

- Queue messages are handled independently: successful messages are acked, failed messages call `message.retry()`.
- Any consumer error schedules message retry; check Worker logs, Telegram status, and KV failures before manual replay.
- Telegram failure in Queue consumer schedules message retry, so Cloudflare Queue retries.
- Messages that keep failing after 5 retries move to `linear-notifications-dlq`.
- Linear webhook request already returned quickly after enqueue, so Telegram failure does not force Linear duplicate retry.
- Enqueue failure returns `500`, allowing Linear to retry because job was not accepted.

### Idempotency behavior

- KV key: `Linear-Delivery` when present, else payload `webhookId`.
- KV values: JSON records with `queued`, `sent`, or `failed` status, timestamp, and retry attempts when relevant.
- TTL: 7 days.
- `sent` deliveries always return `{ "received": true, "duplicate": true }` and skip Telegram delivery.
- Fresh `queued` deliveries are treated as duplicates. `queued` deliveries older than 5 minutes are allowed to enqueue again for safe manual replay/recovery.
- Failed Queue consumer deliveries are marked `failed`, so manual replay can enqueue again. After 3 failures, logs include `notification delivery repeatedly failed` with delivery ID and attempt count.
- KV `get`/`put` is not atomic. Concurrent identical deliveries can still race. For strict exactly-once delivery, move idempotency to Durable Objects, D1 unique keys, or another atomic coordinator.

### Rate limiting

Use Cloudflare WAF or rate limiting rules in production to protect `/webhooks/linear` before requests reach the Worker. Recommended rule:

- Match URI path `/webhooks/linear`.
- Match method `POST`.
- Rate limit by source IP.
- Keep Linear signature and timestamp validation enabled in the Worker.

### Logging

Logs are structured JSON and intentionally redacted:

- Include `ts`, `level`, `msg`, and safe context such as `deliveryId`, `webhookId`, and `eventType`.
- No raw webhook body.
- No Telegram token.
- No Telegram chat ID.
- Failure logs include only safe status/context.

## Useful Commands

```sh
bun test
bun run typecheck
bunx wrangler queues create linear-notifications
bunx wrangler queues create linear-notifications-dlq
bunx wrangler kv namespace create PROCESSED_DELIVERIES
bunx wrangler secret put LINEAR_WEBHOOK_SECRET
bunx wrangler secret put TELEGRAM_BOT_TOKEN
bunx wrangler secret put TELEGRAM_CHAT_ID
bunx wrangler deploy --dry-run
bun run deploy
```

## Troubleshooting

### Deploy fails because KV ID is invalid

Replace `replace-with-kv-namespace-id` in `wrangler.jsonc` with the real ID from:

```sh
bunx wrangler kv namespace create PROCESSED_DELIVERIES
```

### Webhook returns `401 invalid signature`

Check:

- `LINEAR_WEBHOOK_SECRET` in Cloudflare matches Linear webhook secret.
- Request body is not modified before signing.
- `Linear-Signature` header is present.

### Webhook returns `401 expired timestamp`

Linear payload timestamp or `Linear-Timestamp` header is outside 60-second tolerance. Check sender clock and delayed retries.

### Webhook returns `500 notification enqueue failed`

Check Queue binding and Queue name in `wrangler.jsonc`. Worker returns `500` only when verified webhook could not be queued.

### Telegram notification does not arrive

Check:

- `TELEGRAM_BOT_TOKEN` secret exists.
- `TELEGRAM_CHAT_ID` secret exists.
- Bot has access to target chat/channel.
- Queue consumer logs for `telegram notification retry scheduled`.
