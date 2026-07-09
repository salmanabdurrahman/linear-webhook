import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { hmacSha256Hex } from "../src/crypto";
import app, { handleLinearWebhook } from "../src/index";
import { createMemoryKv, deliveryStatus, postLinearWebhook } from "./helpers";

const originalFetch = globalThis.fetch;

describe("wrangler config", () => {
  it("uses a supported compatibility date", async () => {
    const config = (await Bun.file("wrangler.jsonc").json()) as {
      compatibility_date: string;
      queues: { consumers: Array<{ dead_letter_queue?: string; max_retries?: number; queue: string }> };
    };
    const today = new Date().toISOString().slice(0, 10);

    expect(config.compatibility_date).toBe("2026-07-02");
    expect(config.compatibility_date <= today).toBe(true);
  });

  it("configures a dead letter queue for notification retries", async () => {
    const config = (await Bun.file("wrangler.jsonc").json()) as {
      queues: { consumers: Array<{ dead_letter_queue?: string; max_retries?: number; queue: string }> };
    };

    expect(config.queues.consumers).toContainEqual({
      queue: "linear-notifications",
      max_retries: 5,
      dead_letter_queue: "linear-notifications-dlq",
    });
  });
});

describe("service routes", () => {
  it("returns service info", async () => {
    const response = await app.fetch(new Request("http://localhost/"));

    expect(response.status).toBe(200);
    expect(await response.json() as Record<string, string>).toEqual({ service: "linear-webhook", status: "ok" });
  });

  it("returns dependency-aware health", async () => {
    const response = await app.fetch(new Request("http://localhost/health"), {
      NOTIFICATION_QUEUE: { send: () => Promise.resolve() } as unknown as Queue,
      PROCESSED_DELIVERIES: createMemoryKv(),
    });

    expect(response.status).toBe(200);
    expect(await response.json() as Record<string, unknown>).toEqual({
      status: "ok",
      bindings: {
        notificationQueue: { configured: true, status: "ok" },
        processedDeliveries: { configured: true, status: "ok" },
      },
    });
  });

  it("returns degraded health when required bindings are missing", async () => {
    const response = await app.fetch(new Request("http://localhost/health"));

    expect(response.status).toBe(503);
    expect(await response.json() as Record<string, unknown>).toEqual({
      status: "degraded",
      bindings: {
        notificationQueue: { configured: false, status: "missing" },
        processedDeliveries: { configured: false, status: "missing" },
      },
    });
  });
});

describe("linear webhook integration", () => {
  const secret = "test-secret";

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("accepts valid signed issue and comment payloads", async () => {
    for (const type of ["Issue", "Comment"]) {
      const body = JSON.stringify({ webhookTimestamp: Date.now(), type });
      const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body), {
        "Linear-Delivery": `delivery-${type}`,
        "Linear-Event": type,
      });

      expect(response.status).toBe(200);
      expect(await response.json() as Record<string, boolean>).toEqual({ received: true });
    }
  });

  it("returns ok for unsupported events to avoid retries", async () => {
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Project" });
    const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body), {
      "Linear-Delivery": "delivery-project",
      "Linear-Event": "Project",
    });

    expect(response.status).toBe(200);
    expect(await response.json() as Record<string, boolean>).toEqual({ received: true, ignored: true });
  });

  it("logs metadata only after validation", async () => {
    const consoleLog = spyOn(console, "log").mockImplementation(() => undefined);
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Issue", action: "create", data: { secret: "do-not-log" } });

    try {
      const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body), {
        "Linear-Delivery": "delivery-log",
        "Linear-Event": "Issue",
      });

      expect(response.status).toBe(200);
      expect(consoleLog).toHaveBeenCalled();
      const logEntry = JSON.parse(consoleLog.mock.calls[0]?.[0] as string) as Record<string, unknown>;
      expect(logEntry).toEqual(expect.objectContaining({ msg: "linear webhook received", type: "Issue", eventType: "Issue", supported: true }));
      expect(JSON.stringify(consoleLog.mock.calls)).not.toContain("do-not-log");
    } finally {
      consoleLog.mockRestore();
    }
  });

  it("schedules Telegram notification with waitUntil in worker context", async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    let waitUntilPromise: Promise<unknown> | undefined;
    globalThis.fetch = (() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as unknown as typeof fetch;

    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Issue" });
    const response = await handleLinearWebhook(new Request("http://localhost/webhooks/linear", {
      method: "POST",
      headers: { "Linear-Signature": await hmacSha256Hex(secret, body) },
      body,
    }), {
      LINEAR_WEBHOOK_SECRET: secret,
      TELEGRAM_BOT_TOKEN: "telegram-token",
      TELEGRAM_CHAT_ID: "chat-1",
    }, {
      waitUntil(promise: Promise<unknown>) {
        waitUntilPromise = promise;
      },
      passThroughOnException() {},
    } as ExecutionContext);

    expect(response.status).toBe(200);
    expect(waitUntilPromise).toBeDefined();
    resolveFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await waitUntilPromise;
  });

  it("enqueues supported notifications and records delivery ids", async () => {
    const sentJobs: unknown[] = [];
    const queue = { send: (job: unknown) => { sentJobs.push(job); return Promise.resolve(); } } as unknown as Queue;
    const store = createMemoryKv();
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Issue", webhookId: "webhook-queued" });
    const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body), {
      "Linear-Delivery": "delivery-queued",
      "Linear-Event": "Issue",
    }, {
      NOTIFICATION_QUEUE: queue,
      PROCESSED_DELIVERIES: store,
    });

    expect(response.status).toBe(200);
    expect(await response.json() as Record<string, boolean>).toEqual({ received: true, queued: true });
    expect(sentJobs).toHaveLength(1);
    expect(deliveryStatus(await store.get("delivery-queued"))).toBe("queued");
  });

  it("acks successful queue messages and retries failed messages in the same batch", async () => {
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => undefined);
    const responses = [new Response(JSON.stringify({ ok: false }), { status: 500 }), new Response(JSON.stringify({ ok: true }), { status: 200 })];
    globalThis.fetch = (() => Promise.resolve(responses.shift() ?? new Response(JSON.stringify({ ok: true }), { status: 200 }))) as unknown as typeof fetch;
    const calls = { firstAck: 0, firstRetry: 0, secondAck: 0, secondRetry: 0 };
    const event = { supported: true, metadata: { type: "Issue", action: null, issueIdentifier: null, issueTitle: null, title: null, bodyPreview: null, actorName: null, url: null, changedFields: [], state: null, assignee: null, priority: null, labels: [], team: null, webhookId: null, delivery: null, event: null } };

    try {
      await app.queue({
        messages: [
          { body: { deliveryId: "delivery-batch-fail", event }, ack() { calls.firstAck += 1; }, retry() { calls.firstRetry += 1; } },
          { body: { deliveryId: "delivery-batch-success", event }, ack() { calls.secondAck += 1; }, retry() { calls.secondRetry += 1; } },
        ],
      } as unknown as MessageBatch<never>, {
        TELEGRAM_BOT_TOKEN: "telegram-token",
        TELEGRAM_CHAT_ID: "chat-1",
        PROCESSED_DELIVERIES: createMemoryKv({ "delivery-batch-fail": "queued", "delivery-batch-success": "queued" }),
      });

      expect(calls).toEqual({ firstAck: 0, firstRetry: 1, secondAck: 1, secondRetry: 0 });
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("rejects invalid webhook requests", async () => {
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Issue" });
    const invalidPayloadBody = JSON.stringify([]);
    const expiredBody = JSON.stringify({ webhookTimestamp: Date.now() - 61_000, type: "Issue" });

    expect((await postLinearWebhook(body, "00".repeat(32))).status).toBe(401);
    expect((await postLinearWebhook(invalidPayloadBody, await hmacSha256Hex(secret, invalidPayloadBody))).status).toBe(400);

    const expiredResponse = await postLinearWebhook(expiredBody, await hmacSha256Hex(secret, expiredBody));
    expect(expiredResponse.status).toBe(401);
    expect(await expiredResponse.text()).toBe("expired timestamp");
  });

  it("rejects oversized webhook payloads before signature validation", async () => {
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Issue" });
    const response = await app.fetch(new Request("http://localhost/webhooks/linear", {
      method: "POST",
      headers: { "Content-Length": String(100 * 1024 + 1), "Linear-Signature": await hmacSha256Hex(secret, body) },
      body,
    }), { LINEAR_WEBHOOK_SECRET: secret });

    expect(response.status).toBe(413);
    expect(await response.text()).toBe("payload too large");
  });
});
