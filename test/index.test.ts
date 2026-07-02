import { describe, expect, it, spyOn } from "bun:test";
import { hmacSha256Hex } from "../src/crypto";
import app from "../src/index";
import { parseLinearWebhookEvent } from "../src/linear";

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

describe("linear webhook", () => {
  const secret = "test-secret";

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
  ): Promise<Response> {
    return app.fetch(
      new Request("http://localhost/webhooks/linear", {
        method: "POST",
        headers: { "Linear-Signature": signature, ...headers },
        body,
      }),
      { LINEAR_WEBHOOK_SECRET: secret },
    );
  }
});
