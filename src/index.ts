import { Elysia } from "elysia";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { hmacSha256Hex, normalizeSignature, timingSafeEqualHex } from "./crypto";
import { logLinearWebhookEvent, parseLinearWebhookEvent, type LinearWebhookPayload } from "./linear";
import { sendTelegramNotification } from "./telegram";

interface Env {
  LINEAR_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

const TIMESTAMP_TOLERANCE_MS = 60_000;

export const app = new Elysia({ adapter: CloudflareAdapter })
  .get("/", () => ({
    service: "linear-webhook",
    status: "ok",
  }))
  .get("/health", () => "ok")
  .compile();

export async function handleLinearWebhook(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
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

  let payload: LinearWebhookPayload;

  try {
    payload = JSON.parse(rawBody) as LinearWebhookPayload;
  } catch {
    return new Response("invalid payload", { status: 400 });
  }

  if (!isTimestampFresh(payload.webhookTimestamp, Date.now())) {
    return new Response("expired timestamp", { status: 401 });
  }

  const event = parseLinearWebhookEvent(payload, request.headers);
  logLinearWebhookEvent(event);

  if (!event.supported) {
    return Response.json({ received: true, ignored: true });
  }

  const sendNotification = sendTelegramNotification({ botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }, event).catch(
    () => {
      console.warn("telegram notification failed");
    },
  );

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

    return app.fetch(request);
  },
};

export default worker;

function isTimestampFresh(timestamp: unknown, now: number): boolean {
  return typeof timestamp === "number" && Math.abs(now - timestamp) <= TIMESTAMP_TOLERANCE_MS;
}
