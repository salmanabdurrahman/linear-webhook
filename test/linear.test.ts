import { describe, expect, it, spyOn } from "bun:test";
import { logLinearWebhookEvent, parseLinearWebhookEvent, validateLinearWebhookPayload } from "../src/linear";

describe("linear webhook parsing", () => {
  it("validates payload shape without accepting arrays", () => {
    expect(validateLinearWebhookPayload([])).toEqual({ ok: false, errorType: "invalid_payload" });
    expect(validateLinearWebhookPayload({ type: "Issue", data: null })).toMatchObject({ ok: true });
  });

  it("extracts safe Linear metadata without raw body", () => {
    const event = parseLinearWebhookEvent({
      type: "Issue",
      action: "create",
      actor: { name: "Ada Lovelace" },
      url: "https://linear.app/example/issue/SAL-1",
      webhookId: "webhook-1",
      webhookTimestamp: Date.now(),
    }, new Headers({ "Linear-Delivery": "delivery-4", "Linear-Event": "Issue" }));

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

  it("logs metadata only", () => {
    const consoleLog = spyOn(console, "log").mockImplementation(() => undefined);
    const event = parseLinearWebhookEvent({ type: "Issue", action: "create", data: { body: "secret body" } }, new Headers());

    try {
      logLinearWebhookEvent(event);
      expect(consoleLog).toHaveBeenCalled();
      const logEntry = JSON.parse(consoleLog.mock.calls[0]?.[0] as string) as Record<string, unknown>;
      expect(logEntry).toEqual(expect.objectContaining({ msg: "linear webhook received", type: "Issue", eventType: "Issue", supported: true }));
      expect(JSON.stringify(consoleLog.mock.calls)).not.toContain("secret body");
    } finally {
      consoleLog.mockRestore();
    }
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
});
