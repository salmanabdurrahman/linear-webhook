import { Elysia } from "elysia";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { hmacSha256Hex, normalizeSignature, timingSafeEqualHex } from "./crypto";
import { logLinearWebhookEvent, parseLinearWebhookEvent, validateLinearWebhookPayload, type LinearWebhookPayload } from "./linear";
import { log, withLoggerContext } from "./logger";
import {
  clearDelivery,
  deliverNotificationJob,
  getDeliveryId,
  isDuplicateDelivery,
  markDeliveryQueued,
  markDeliverySent,
  type NotificationJob,
} from "./queue";
import { sendTelegramNotification } from "./telegram";

interface Env {
  LINEAR_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  NOTIFICATION_QUEUE?: Queue<NotificationJob>;
  PROCESSED_DELIVERIES?: KVNamespace;
}

interface HealthBindingStatus {
  configured: boolean;
  status: "ok" | "missing" | "error";
  error?: string;
}

interface HealthResponse {
  status: "ok" | "degraded";
  bindings: {
    notificationQueue: HealthBindingStatus;
    processedDeliveries: HealthBindingStatus;
  };
}

const TIMESTAMP_TOLERANCE_MS = 60_000;
const MAX_WEBHOOK_BODY_BYTES = 100 * 1024;

export const app = new Elysia({ adapter: CloudflareAdapter })
  .get("/", () => ({
    service: "linear-webhook",
    status: "ok",
  }))
  .get("/health", () => "ok")
  .compile();

export async function handleLinearWebhook(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (isWebhookBodyTooLarge(request.headers)) {
    return new Response("payload too large", { status: 413 });
  }

  const rawBody = await request.text();
  const signature = normalizeSignature(request.headers.get("Linear-Signature"));
  const secret = env.LINEAR_WEBHOOK_SECRET;

  if (!signature || !secret) {
    return new Response("invalid signature", { status: 401 });
  }

  const expectedSignature = await hmacSha256Hex(secret, rawBody);

  if (!timingSafeEqualHex(signature, expectedSignature)) {
    return new Response("invalid signature", { status: 401 });
  }

  let parsedBody: unknown;

  try {
    parsedBody = JSON.parse(rawBody) as unknown;
  } catch {
    return new Response("invalid payload", { status: 400 });
  }

  const validation = validateLinearWebhookPayload(parsedBody);

  if (!validation.ok) {
    return new Response(validation.errorType, { status: 400 });
  }

  const { payload } = validation;

  if (!isTimestampFresh(webhookTimestamp(payload, request.headers), Date.now())) {
    return new Response("expired timestamp", { status: 401 });
  }

  const event = parseLinearWebhookEvent(payload, request.headers);
  logLinearWebhookEvent(event);

  if (!event.supported) {
    return Response.json({ received: true, ignored: true });
  }

  const deliveryId = getDeliveryId(event);

  if (await isDuplicateDelivery(env.PROCESSED_DELIVERIES, deliveryId)) {
    return Response.json({ received: true, duplicate: true });
  }

  if (env.NOTIFICATION_QUEUE) {
    try {
      await markDeliveryQueued(env.PROCESSED_DELIVERIES, deliveryId);
      await env.NOTIFICATION_QUEUE.send({ deliveryId, event });
    } catch {
      await clearDelivery(env.PROCESSED_DELIVERIES, deliveryId);
      withLoggerContext({
        deliveryId,
        webhookId: event.metadata.webhookId,
        eventType: event.metadata.type,
      })("warn", "notification enqueue failed");
      return new Response("notification enqueue failed", { status: 500 });
    }

    return Response.json({ received: true, queued: true });
  }

  const sendNotification = sendTelegramNotification({ botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }, event)
    .then(async (result) => {
      if (result.sent) {
        await markDeliverySent(env.PROCESSED_DELIVERIES, deliveryId);
      }
    })
    .catch(() => {
      withLoggerContext({
        deliveryId,
        webhookId: event.metadata.webhookId,
        eventType: event.metadata.type,
      })("warn", "telegram notification failed");
    });

  if (ctx) {
    ctx.waitUntil(sendNotification);
  } else {
    await sendNotification;
  }

  return Response.json({ received: true });
}

const worker = {
  async fetch(request: Request, env: Env = {}, _ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhooks/linear") {
      return handleLinearWebhook(request, env, _ctx);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return healthResponse(env);
    }

    return app.fetch(request);
  },
  async queue(batch: MessageBatch<NotificationJob>, env: Env = {}): Promise<void> {
    for (const message of batch.messages) {
      try {
        await deliverNotificationJob(message.body, {
          botToken: env.TELEGRAM_BOT_TOKEN,
          chatId: env.TELEGRAM_CHAT_ID,
        }, env.PROCESSED_DELIVERIES);
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
};

export default worker;

export async function healthResponse(env: Env = {}): Promise<Response> {
  const bindings: HealthResponse["bindings"] = {
    notificationQueue: queueHealth(env.NOTIFICATION_QUEUE),
    processedDeliveries: await kvHealth(env.PROCESSED_DELIVERIES),
  };
  const healthy = Object.values(bindings).every((binding) => binding.status === "ok");
  const body: HealthResponse = {
    status: healthy ? "ok" : "degraded",
    bindings,
  };

  return Response.json(body, { status: healthy ? 200 : 503 });
}

function queueHealth(queue: Queue<NotificationJob> | undefined): HealthBindingStatus {
  if (!queue) {
    return { configured: false, status: "missing" };
  }

  return { configured: true, status: "ok" };
}

async function kvHealth(store: KVNamespace | undefined): Promise<HealthBindingStatus> {
  if (!store) {
    return { configured: false, status: "missing" };
  }

  try {
    await store.get("__healthcheck__");
    return { configured: true, status: "ok" };
  } catch (error) {
    log("warn", "health check kv probe failed", { error: error instanceof Error ? error.message : "unknown" });
    return { configured: true, status: "error", error: "kv get failed" };
  }
}

export function isTimestampFresh(timestamp: unknown, now: number): boolean {
  return typeof timestamp === "number" && Math.abs(now - timestamp) <= TIMESTAMP_TOLERANCE_MS;
}

export function webhookTimestamp(payload: LinearWebhookPayload, headers: Headers): number | null {
  return typeof payload.webhookTimestamp === "number" ? payload.webhookTimestamp : timestampFromHeader(headers);
}

export function timestampFromHeader(headers: Headers): number | null {
  const timestamp = headers.get("Linear-Timestamp");

  if (!timestamp) {
    return null;
  }

  const parsed = Number(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isWebhookBodyTooLarge(headers: Headers): boolean {
  const contentLength = headers.get("Content-Length");

  if (!contentLength) {
    return false;
  }

  const parsed = Number(contentLength);
  return Number.isFinite(parsed) && parsed > MAX_WEBHOOK_BODY_BYTES;
}
