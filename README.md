# Linear Webhook

Cloudflare Worker that receives Linear webhooks and sends safe Telegram notifications.

## Local development

1. Install deps:

   ```sh
   bun install
   ```

2. Copy local Worker secrets:

   ```sh
   cp .dev.vars.example .dev.vars
   ```

3. Replace values in `.dev.vars` with local test values. Keep `.dev.vars` untracked.

4. Start Worker:

   ```sh
   bun run dev
   ```

Local `.dev.vars` and `.env*` files are gitignored. Do not commit real Linear webhook secrets, Telegram bot tokens, or chat ids.

## Deployed secrets

Set production secrets through Wrangler:

```sh
wrangler secret put LINEAR_WEBHOOK_SECRET
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
```

Wrangler config can define non-secret `vars`, but secrets should not be stored in `wrangler.jsonc`. Required secret names are documented here and provided through Cloudflare secret bindings at deploy/runtime.

## Manual verification

Run tests:

```sh
bun test
```

Check health locally:

```sh
curl http://localhost:8787/health
```

Generate signed local payload:

```sh
LINEAR_WEBHOOK_SECRET=test-linear-webhook-secret bun run sign:payload -- --url http://localhost:8787/webhooks/linear
```

Invalid signature check:

```sh
curl -i http://localhost:8787/webhooks/linear \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'Linear-Signature: sha256=00' \
  --data '{"webhookTimestamp":0,"type":"Issue"}'
```

Expected invalid signature result: `401`.

Valid Linear-like payload check:

```sh
LINEAR_WEBHOOK_SECRET=test-linear-webhook-secret bun run sign:payload -- --url http://localhost:8787/webhooks/linear | sh
```

Expected valid payload result: `200` with `{ "received": true }`.

Telegram failure check:

1. Use valid `LINEAR_WEBHOOK_SECRET`.
2. Set fake `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` in `.dev.vars`.
3. Send valid signed payload.
4. Confirm Worker returns `200` and logs only generic Telegram failure metadata, not secret values.

After deploy, verify delivery from Linear API webhook settings by sending a test event to deployed `/webhooks/linear` URL.
