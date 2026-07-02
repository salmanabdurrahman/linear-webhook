import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { hmacSha256Hex, normalizeSignature, timingSafeEqualHex } from "../src/crypto";
import app, { handleLinearWebhook, isTimestampFresh } from "../src/index";
import { parseLinearWebhookEvent } from "../src/linear";

const originalFetch = globalThis.fetch;

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
        title: null,
        bodyPreview: null,
        actorName: "Ada Lovelace",
        url: "https://linear.app/example/issue/SAL-1",
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
        actorName: null,
        url: null,
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
    expect(requestBody).toContain("delivery-7");
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
    env: Record<string, string> = {},
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
