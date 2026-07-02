import { describe, expect, it } from "bun:test";
import { hmacSha256Hex } from "../src/crypto";
import app from "../src/index";

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

  it("accepts a valid signed payload", async () => {
    const body = JSON.stringify({ webhookTimestamp: Date.now(), type: "Issue" });
    const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body));

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, boolean>).toEqual({ received: true });
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

  it("validates signature before parsing JSON", async () => {
    const response = await postLinearWebhook("not json", "00".repeat(32));

    expect(response.status).toBe(401);
  });

  it("returns bad request for invalid JSON after signature validation", async () => {
    const body = "not json";
    const response = await postLinearWebhook(body, await hmacSha256Hex(secret, body));

    expect(response.status).toBe(400);
  });

  async function postLinearWebhook(body: string, signature: string): Promise<Response> {
    return app.fetch(
      new Request("http://localhost/webhooks/linear", {
        method: "POST",
        headers: { "Linear-Signature": signature },
        body,
      }),
      { LINEAR_WEBHOOK_SECRET: secret },
    );
  }
});
