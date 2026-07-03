import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { hmacSha256Hex, normalizeSignature, timingSafeEqualHex } from "../src/crypto";
import app, { handleLinearWebhook, isTimestampFresh } from "../src/index";
import { parseLinearWebhookEvent } from "../src/linear";
import { formatTelegramMessage } from "../src/telegram";

const originalFetch = globalThis.fetch;

type KvStore = Pick<KVNamespace, "get" | "put" | "delete">;

function createMemoryKv(initial: Record<string, string> = {}): KVNamespace {
  const values = new Map(Object.entries(initial));

  return {
    get: ((key: string) => Promise.resolve(values.get(key) ?? null)) as KVNamespace["get"],
    put: (key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      values.delete(key);
      return Promise.resolve();
    },
  } as KvStore as KVNamespace;
}

describe("wrangler config", () => {
  it("uses a supported compatibility date", async () => {
    const config = (await Bun.file("wrangler.jsonc").json()) as { compatibility_date: string };
    const today = new Date().toISOString().slice(0, 10);

    expect(config.compatibility_date).toBe("2026-07-02");
    expect(config.compatibility_date <= today).toBe(true);
  });
});

describe("service routes", () => {
  it("returns service info", async () => {
    const response = await app.fetch(new Request("http://localhost/"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, string>;

    expect(body).toEqual({
      service: "linear-webhook",
      status: "ok",
    });
  });

  it("returns health ok", async () => {
    const response = await app.fetch(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});

describe("crypto helpers", () => {
  it("creates and compares a valid signature", async () => {
    const body = JSON.stringify({ webhookTimestamp: 1, type: "Issue" });
    const signature = await hmacSha256Hex("test-secret", body);

    expect(timingSafeEqualHex(signature, signature)).toBe(true);
    expect(normalizeSignature(`sha256=${signature}`)).toBe(signature);
  });

  it("rejects an invalid signature", async () => {
    const body = JSON.stringify({ webhookTimestamp: 1, type: "Issue" });
    const signature = await hmacSha256Hex("test-secret", body);

    expect(timingSafeEqualHex("00".repeat(32), signature)).toBe(false);
  });

  it("accepts timestamps within tolerance", () => {
    expect(isTimestampFresh(1_000, 61_000)).toBe(true);
  });

  it("rejects expired timestamps", () => {
    expect(isTimestampFresh(999, 61_000)).toBe(false);
  });

  it("rejects future timestamps outside tolerance", () => {
    expect(isTimestampFresh(121_001, 61_000)).toBe(false);
  });
});

describe("linear webhook", () => {
  const secret = "test-secret";

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("accepts a valid signed issue payload", async () => {
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Issue" });
    const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body), {
      "Linear-Delivery": "delivery-1",
      "Linear-Event": "Issue",
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, boolean>).toEqual({ received: true });
  });

  it("accepts a valid signed comment payload", async () => {
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Comment" });
    const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body), {
      "Linear-Delivery": "delivery-2",
      "Linear-Event": "Comment",
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, boolean>).toEqual({ received: true });
  });

  it("returns ok for unsupported events to avoid retries", async () => {
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Project" });
    const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body), {
      "Linear-Delivery": "delivery-3",
      "Linear-Event": "Project",
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, boolean>).toEqual({ received: true, ignored: true });
  });

  it("extracts safe Linear metadata without raw body", () => {
    const headers = new Headers({
      "Linear-Delivery": "delivery-4",
      "Linear-Event": "Issue",
    });
    const event = parseLinearWebhookEvent(
      {
        type: "Issue",
        action: "create",
        actor: { name: "Ada Lovelace" },
        url: "https://linear.app/example/issue/SAL-1",
        webhookId: "webhook-1",
        webhookTimestamp: Date.now(),
      },
      headers,
    );

    expect(event).toEqual({
      supported: true,
      metadata: {
        type: "Issue",
        action: "create",
        issueIdentifier: null,
        issueTitle: null,
        title: null,
        bodyPreview: null,
        actorName: "Ada Lovelace",
        url: "https://linear.app/example/issue/SAL-1",
        changedFields: [],
        state: null,
        assignee: null,
        priority: null,
        labels: [],
        team: null,
        webhookId: "webhook-1",
        delivery: "delivery-4",
        event: "Issue",
      },
    });
  });

  it("logs metadata only after validation", async () => {
    const consoleLog = spyOn(console, "log").mockImplementation(() => undefined);
    const body = JSON.stringify({
      webhookTimestamp: Date.now(),
      type: "Issue",
      action: "create",
      data: { secret: "do-not-log" },
    });

    try {
      const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body), {
        "Linear-Delivery": "delivery-5",
        "Linear-Event": "Issue",
      });

      expect(response.status).toBe(200);
      expect(consoleLog).toHaveBeenCalledWith("linear webhook received", {
        type: "Issue",
        action: "create",
        issueIdentifier: null,
        issueTitle: null,
        actorName: null,
        url: null,
        changedFields: [],
        state: null,
        assignee: null,
        priority: null,
        labels: [],
        team: null,
        webhookId: null,
        delivery: "delivery-5",
        event: "Issue",
        supported: true,
      });
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
    const request = new Request("http://localhost/webhooks/linear", {
      method: "POST",
      headers: { "Linear-Signature": await hmacSha256Hex(secret, body) },
      body,
    });
    const response = await handleLinearWebhook(request, {
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
    const queue = {
      send: (job: unknown) => {
        sentJobs.push(job);
        return Promise.resolve();
      },
    } as unknown as Queue;
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
    expect((await response.json()) as Record<string, boolean>).toEqual({ received: true, queued: true });
    expect(sentJobs).toHaveLength(1);
    expect(await store.get("delivery-queued")).toBe("queued");
  });

  it("records sent deliveries without queue binding", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))) as unknown as typeof fetch;
    const store = createMemoryKv();
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Issue", webhookId: "webhook-direct" });
    const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body), {}, {
      TELEGRAM_BOT_TOKEN: "telegram-token",
      TELEGRAM_CHAT_ID: "chat-1",
      PROCESSED_DELIVERIES: store,
    });

    expect(response.status).toBe(200);
    expect(await store.get("webhook-direct")).toBe("sent");
  });

  it("skips duplicate deliveries before enqueue", async () => {
    const queue = {
      send: () => {
        throw new Error("should not enqueue duplicate");
      },
    } as unknown as Queue;
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Issue" });
    const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body), {
      "Linear-Delivery": "delivery-duplicate",
      "Linear-Event": "Issue",
    }, {
      NOTIFICATION_QUEUE: queue,
      PROCESSED_DELIVERIES: createMemoryKv({ "delivery-duplicate": "sent" }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, boolean>).toEqual({ received: true, duplicate: true });
  });

  it("uses webhook ids for duplicate detection when Linear-Delivery is missing", async () => {
    const queue = {
      send: () => {
        throw new Error("should not enqueue duplicate");
      },
    } as unknown as Queue;
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Issue", webhookId: "webhook-duplicate" });
    const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body), {}, {
      NOTIFICATION_QUEUE: queue,
      PROCESSED_DELIVERIES: createMemoryKv({ "webhook-duplicate": "queued" }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, boolean>).toEqual({ received: true, duplicate: true });
  });

  it("retries queue consumer failures without leaking Telegram config", async () => {
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => undefined);
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 500 }))) as unknown as typeof fetch;
    const message = {
      body: {
        deliveryId: "delivery-retry",
        event: parseLinearWebhookEvent({ type: "Issue", webhookTimestamp: Date.now() }, new Headers()),
      },
      ack() {},
    };

    try {
      await expect(app.queue({ messages: [message] } as unknown as MessageBatch<never>, {
        TELEGRAM_BOT_TOKEN: "telegram-token",
        TELEGRAM_CHAT_ID: "chat-1",
        PROCESSED_DELIVERIES: createMemoryKv({ "delivery-retry": "queued" }),
      })).rejects.toThrow("telegram notification failed");
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain("telegram-token");
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain("chat-1");
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("sends Telegram notification for valid issue payload", async () => {
    const fetchCalls: RequestInfo[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetchCalls.push(input as RequestInfo);
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as typeof fetch;

    const body = JSON.stringify({
      webhookTimestamp: Date.now(),
      type: "Issue",
      action: "create",
      actor: { name: "Ada Lovelace" },
      data: { title: "Fix bug", body: "Long body" },
      url: "https://linear.app/example/issue/SAL-1",
    });
    const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body), {
      "Linear-Delivery": "delivery-6",
      "Linear-Event": "Issue",
    }, {
      TELEGRAM_BOT_TOKEN: "telegram-token",
      TELEGRAM_CHAT_ID: "chat-1",
    });

    expect(response.status).toBe(200);
    const telegramUrl = new URL(String(fetchCalls[0]));
    expect(telegramUrl.origin).toBe("https://api.telegram.org");
    expect(telegramUrl.pathname.endsWith("/sendMessage")).toBe(true);
  });

  it("sends Telegram notification for valid comment payload", async () => {
    let requestBody = "";
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body);
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as typeof fetch;

    const body = JSON.stringify({
      webhookTimestamp: Date.now(),
      type: "Comment",
      action: "create",
      actor: { name: "Grace Hopper" },
      data: { body: "Comment body" },
      url: "https://linear.app/example/comment/1",
    });
    const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body), {
      "Linear-Delivery": "delivery-7",
      "Linear-Event": "Comment",
    }, {
      TELEGRAM_BOT_TOKEN: "telegram-token",
      TELEGRAM_CHAT_ID: "chat-1",
    });

    expect(response.status).toBe(200);
    expect(requestBody).toContain("Comment body");
    expect(requestBody).toContain("💬 Grace Hopper commented on Linear issue");
    expect(requestBody).not.toContain("Type:");
    expect(requestBody).not.toContain("Action:");
    expect(requestBody).not.toContain("Delivery:");
    expect(requestBody).not.toContain("delivery-7");
  });

  it("keeps malformed optional Linear metadata null-safe", () => {
    const event = parseLinearWebhookEvent({
      type: "Issue",
      action: "update",
      data: {
        title: "Safe parse",
        labels: [null, "bug", { name: "safe" }] as unknown as [{ name?: unknown }],
      },
    }, new Headers());

    expect(event.metadata.labels).toEqual(["bug", "safe"]);
  });

  it("extracts rich Linear issue metadata", () => {
    const event = parseLinearWebhookEvent({
      type: "Issue",
      action: "create",
      actor: { name: "Ada Lovelace" },
      data: {
        identifier: "SAL-13",
        title: "Improve reports",
        state: { name: "In Progress" },
        assignee: { name: "Grace Hopper" },
        priorityLabel: "High",
        labels: { nodes: [{ name: "notifications" }] },
        team: { name: "Product" },
      },
    }, new Headers());

    expect(event.metadata).toMatchObject({
      issueIdentifier: "SAL-13",
      issueTitle: "Improve reports",
      actorName: "Ada Lovelace",
      state: "In Progress",
      assignee: "Grace Hopper",
      priority: "High",
      labels: ["notifications"],
      team: "Product",
    });
  });

  it("extracts issue metadata from comment payloads", () => {
    const event = parseLinearWebhookEvent({
      type: "Comment",
      action: "create",
      actor: { name: "Grace Hopper" },
      data: {
        body: "Implemented locally.\n\n- Added templates",
        issue: {
          identifier: "SAL-13",
          title: "Improve reports",
          url: "https://linear.app/example/issue/SAL-13",
        },
      },
    }, new Headers());

    expect(event.metadata.issueIdentifier).toBe("SAL-13");
    expect(event.metadata.issueTitle).toBe("Improve reports");
    expect(event.metadata.bodyPreview).toBe("Implemented locally. - Added templates");
    expect(event.metadata.url).toBe("https://linear.app/example/issue/SAL-13");
  });

  it("formats compact comment notifications", () => {
    const event = parseLinearWebhookEvent({
      type: "Comment",
      action: "create",
      actor: { name: "Grace Hopper" },
      data: {
        body: "Implemented locally.",
        issue: { identifier: "SAL-13", title: "Improve reports" },
      },
      url: "https://linear.app/example/comment/1",
    }, new Headers());

    expect(formatTelegramMessage(event)).toBe([
      "💬 Grace Hopper commented on SAL-13",
      "Improve reports",
      "",
      "Implemented locally.",
      "",
      "Open: https://linear.app/example/comment/1",
    ].join("\n"));
  });

  it("formats compact issue update notifications with changed fields", () => {
    const event = parseLinearWebhookEvent({
      type: "Issue",
      action: "update",
      actor: { name: "Ada Lovelace" },
      data: {
        identifier: "SAL-13",
        title: "Improve reports",
        description: "Long PRD content should not appear when changed fields exist",
      },
      updatedFrom: { description: "old", state: { name: "Todo" } },
      url: "https://linear.app/example/issue/SAL-13",
    }, new Headers());

    const message = formatTelegramMessage(event);

    expect(message).toBe([
      "📝 SAL-13 updated",
      "Improve reports",
      "",
      "By Ada Lovelace",
      "Changed: description, state",
      "",
      "Open: https://linear.app/example/issue/SAL-13",
    ].join("\n"));
    expect(message).not.toContain("Long PRD content");
  });

  it("uses issue update preview only when changed fields are missing", () => {
    const event = parseLinearWebhookEvent({
      type: "Issue",
      action: "update",
      data: {
        identifier: "SAL-13",
        title: "Improve reports",
        description: "Short fallback description",
      },
    }, new Headers());

    expect(formatTelegramMessage(event)).toContain("Preview: Short fallback description");
  });

  it("does not leak secrets when Telegram request fails", async () => {
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => undefined);
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 401 }))) as unknown as typeof fetch;
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Issue" });

    try {
      const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body), {}, {
        TELEGRAM_BOT_TOKEN: "telegram-token",
        TELEGRAM_CHAT_ID: "chat-1",
      });

      expect(response.status).toBe(200);
      expect(consoleWarn).toHaveBeenCalledWith("telegram notification failed", { status: 401 });
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain("telegram-token");
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain("chat-1");
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("accepts valid event when Telegram config is missing", async () => {
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => undefined);
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Issue" });

    try {
      const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body));

      expect(response.status).toBe(200);
      expect(consoleWarn).toHaveBeenCalledWith("telegram notification skipped: missing config", {
        missingConfig: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
      });
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain("telegram-token");
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("rejects an invalid signature", async () => {
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Issue" });
    const response = await postLinearWebhook(body, "00".repeat(32));

    expect(response.status).toBe(401);
  });

  it("rejects a missing signature", async () => {
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Issue" });
    const response = await app.fetch(
      new Request("http://localhost/webhooks/linear", {
        method: "POST",
        body,
      }),
      { LINEAR_WEBHOOK_SECRET: secret },
    );

    expect(response.status).toBe(401);
  });

  it("rejects a missing webhook secret", async () => {
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Issue" });
    const response = await app.fetch(
      new Request("http://localhost/webhooks/linear", {
        method: "POST",
        headers: { "Linear-Signature": await hmacSha256Hex(secret, body) },
        body,
      }),
    );

    expect(response.status).toBe(401);
  });

  it("rejects a future webhook timestamp", async () => {
    const body = JSON.stringify({ webhookTimestamp: Date.now() + 61_000, type: "Issue" });
    const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body));

    expect(response.status).toBe(401);
  });

  it("rejects an old webhook timestamp", async () => {
    const body = JSON.stringify({ webhookTimestamp: Date.now() - 61_000, type: "Issue" });
    const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body));

    expect(response.status).toBe(401);
  });

  it("does not log rejected payloads", async () => {
    const consoleLog = spyOn(console, "log").mockImplementation(() => undefined);
    const body = JSON.stringify({ webhookTimestamp: Date.now() - 61_000, type: "Issue" });

    try {
      const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body));

      expect(response.status).toBe(401);
      expect(consoleLog).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
    }
  });

  it("validates signature before parsing JSON", async () => {
    const response = await postLinearWebhook("not json", "00".repeat(32));

    expect(response.status).toBe(401);
  });

  it("returns bad request for invalid JSON after signature validation", async () => {
    const body = "not json";
    const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body));

    expect(response.status).toBe(400);
  });

  async function postLinearWebhook(
    body: string,
    signature: string,
    headers: Record<string, string> = {},
    env: Record<string, unknown> = {},
  ): Promise<Response> {
    return app.fetch(
      new Request("http://localhost/webhooks/linear", {
        method: "POST",
        headers: { "Linear-Signature": signature, ...headers },
        body,
      }),
      { LINEAR_WEBHOOK_SECRET: secret, ...env },
    );
  }
});
