import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { parseLinearWebhookEvent } from "../src/linear";
import { formatTelegramMessage, previewText, sendTelegramNotification } from "../src/telegram";

const originalFetch = globalThis.fetch;

describe("telegram notifications", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
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

  it("formats compact issue create notifications", () => {
    const event = parseLinearWebhookEvent({
      type: "Issue",
      action: "create",
      actor: { name: "Ada Lovelace" },
      data: {
        identifier: "SAL-13",
        title: "Improve reports",
        state: { name: "Todo" },
        assignee: { name: "Grace Hopper" },
        priorityLabel: "Medium",
        labels: { nodes: [{ name: "notifications" }] },
        team: { name: "Product" },
        description: "Initial implementation plan.",
      },
      url: "https://linear.app/example/issue/SAL-13",
    }, new Headers());

    expect(formatTelegramMessage(event)).toBe([
      "✨ SAL-13 created",
      "Improve reports",
      "",
      "By Ada Lovelace",
      "Details: state Todo, assignee Grace Hopper, priority Medium, labels notifications, team Product",
      "Initial implementation plan.",
      "",
      "Open: https://linear.app/example/issue/SAL-13",
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

  it("limits long fields and previews deterministically", () => {
    const event = parseLinearWebhookEvent({
      type: "Issue",
      action: "create",
      actor: { name: "A".repeat(600) },
      data: {
        identifier: "SAL-13",
        title: "T".repeat(600),
        description: "B".repeat(5_000),
        labels: { nodes: [{ name: "L".repeat(600) }] },
      },
      url: `https://linear.app/example/issue/SAL-13/${"u".repeat(600)}`,
    }, new Headers());

    const message = formatTelegramMessage(event);

    expect(message.length).toBeLessThanOrEqual(3_900);
    expect(message).toContain(`${"T".repeat(239)}…`);
    expect(message).toContain(`${"B".repeat(179)}…`);
    expect(previewText(" hello\nworld ")).toBe("hello world");
  });

  it("sends Telegram notification with safe request body", async () => {
    let requestBody = "";
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body);
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as typeof fetch;
    const event = parseLinearWebhookEvent({ type: "Comment", actor: { name: "Grace" }, data: { body: "Comment body" } }, new Headers());

    await expect(sendTelegramNotification({ botToken: "telegram-token", chatId: "chat-1" }, event)).resolves.toEqual({ sent: true, skipped: false });
    expect(requestBody).toContain("Comment body");
    expect(requestBody).not.toContain("telegram-token");
  });

  it("returns safe errors for missing config and failed Telegram requests", async () => {
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => undefined);
    const event = parseLinearWebhookEvent({ type: "Issue" }, new Headers());

    try {
      await expect(sendTelegramNotification({}, event)).resolves.toEqual({ sent: false, skipped: true, error: "missing telegram config" });
      globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 401 }))) as unknown as typeof fetch;
      await expect(sendTelegramNotification({ botToken: "telegram-token", chatId: "chat-1" }, event)).resolves.toEqual({ sent: false, skipped: false, error: "telegram request failed" });
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain("telegram-token");
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain("chat-1");
    } finally {
      consoleWarn.mockRestore();
    }
  });
});
