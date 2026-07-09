import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { parseLinearWebhookEvent } from "../src/linear";
import {
  deliverNotificationJob,
  getDeliveryId,
  isDuplicateDelivery,
  markDeliveryFailed,
  markDeliveryQueued,
  markDeliverySent,
  parseDeliveryRecord,
} from "../src/queue";
import { createMemoryKv, deliveryStatus } from "./helpers";

const originalFetch = globalThis.fetch;

function issueEvent(delivery = "delivery-1") {
  return parseLinearWebhookEvent({ type: "Issue", webhookTimestamp: Date.now(), webhookId: "webhook-1" }, new Headers({ "Linear-Delivery": delivery }));
}

describe("queue helpers", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("derives delivery ids from Linear-Delivery before webhook id", () => {
    expect(getDeliveryId(issueEvent("delivery-primary"))).toBe("delivery-primary");
    expect(getDeliveryId(parseLinearWebhookEvent({ type: "Issue", webhookId: "webhook-fallback" }, new Headers()))).toBe("webhook-fallback");
  });

  it("tracks queued, sent, and failed delivery states", async () => {
    const store = createMemoryKv();

    await markDeliveryQueued(store, "delivery-state", 1);
    expect(deliveryStatus(await store.get("delivery-state"))).toBe("queued");

    await markDeliverySent(store, "delivery-state", 2);
    expect(deliveryStatus(await store.get("delivery-state"))).toBe("sent");

    await markDeliveryFailed(store, "delivery-state", 3);
    expect(deliveryStatus(await store.get("delivery-state"))).toBe("failed");
  });

  it("detects sent and fresh queued duplicates but allows stale queued replay", async () => {
    expect(await isDuplicateDelivery(createMemoryKv({ sent: "sent" }), "sent", 10)).toBe(true);
    expect(await isDuplicateDelivery(createMemoryKv({ fresh: JSON.stringify({ status: "queued", updatedAt: 10 }) }), "fresh", 11)).toBe(true);
    expect(await isDuplicateDelivery(createMemoryKv({ stale: JSON.stringify({ status: "queued", updatedAt: 10 }) }), "stale", 301_011)).toBe(false);
  });

  it("parses delivery record edge cases", () => {
    expect(parseDeliveryRecord(null)).toBeNull();
    expect(parseDeliveryRecord("not-json")).toBeNull();
    expect(parseDeliveryRecord(JSON.stringify({ status: "sent" }))).toBeNull();
    expect(parseDeliveryRecord(JSON.stringify({ status: "bad", updatedAt: 1 }))).toBeNull();
    expect(parseDeliveryRecord(JSON.stringify({ status: "failed", updatedAt: "bad" }))).toBeNull();
    expect(parseDeliveryRecord("sent")).toMatchObject({ status: "sent" });
    expect(parseDeliveryRecord("queued")).toEqual({ status: "queued", updatedAt: 0 });
    expect(parseDeliveryRecord("failed")).toEqual({ status: "failed", updatedAt: 0 });
    expect(parseDeliveryRecord(JSON.stringify({ status: "failed", updatedAt: 123, attempts: 2 }))).toEqual({ status: "failed", updatedAt: 123, attempts: 2 });
  });

  it("skips already sent delivery jobs", async () => {
    const store = createMemoryKv({ "delivery-sent": "sent" });
    globalThis.fetch = (() => {
      throw new Error("should not send duplicate");
    }) as unknown as typeof fetch;

    await deliverNotificationJob({ deliveryId: "delivery-sent", event: issueEvent("delivery-sent") }, {
      botToken: "telegram-token",
      chatId: "chat-1",
    }, store);
  });

  it("marks successful delivery jobs as sent", async () => {
    const store = createMemoryKv({ "delivery-ok": "queued" });
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))) as unknown as typeof fetch;

    await deliverNotificationJob({ deliveryId: "delivery-ok", event: issueEvent("delivery-ok") }, {
      botToken: "telegram-token",
      chatId: "chat-1",
    }, store);

    expect(deliveryStatus(await store.get("delivery-ok"))).toBe("sent");
  });

  it("marks failed delivery jobs, increments attempts, and throws for retry", async () => {
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createMemoryKv({ "delivery-fail": JSON.stringify({ status: "failed", updatedAt: 1, attempts: 2 }) });
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 500 }))) as unknown as typeof fetch;

    try {
      await expect(deliverNotificationJob({ deliveryId: "delivery-fail", event: issueEvent("delivery-fail") }, {
        botToken: "telegram-token",
        chatId: "chat-1",
      }, store)).rejects.toThrow("telegram notification failed");
      expect(parseDeliveryRecord(await store.get("delivery-fail"))).toMatchObject({ status: "failed", attempts: 3 });
      expect(consoleWarn).toHaveBeenCalledWith("notification delivery repeatedly failed", { deliveryId: "delivery-fail", attempts: 3 });
    } finally {
      consoleWarn.mockRestore();
    }
  });
});
