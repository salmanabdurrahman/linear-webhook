import { describe, expect, it } from "bun:test";
import { hmacSha256Hex, normalizeSignature, timingSafeEqualHex } from "../src/crypto";
import { isTimestampFresh, isWebhookBodyTooLarge, timestampFromHeader, webhookTimestamp } from "../src/index";

describe("crypto helpers", () => {
  it("creates and compares a valid signature", async () => {
    const body = JSON.stringify({ webhookTimestamp: 1, type: "Issue" });
    const signature = await hmacSha256Hex("test-secret", body);

    expect(timingSafeEqualHex(signature, signature)).toBe(true);
    expect(normalizeSignature(`sha256=${signature}`)).toBe(signature);
  });

  it("rejects invalid, malformed, and missing signatures", async () => {
    const body = JSON.stringify({ webhookTimestamp: 1, type: "Issue" });
    const signature = await hmacSha256Hex("test-secret", body);

    expect(timingSafeEqualHex("00".repeat(32), signature)).toBe(false);
    expect(timingSafeEqualHex("not-hex", signature)).toBe(false);
    expect(normalizeSignature(null)).toBeNull();
  });

  it("validates timestamp freshness boundaries", () => {
    expect(isTimestampFresh(1_000, 61_000)).toBe(true);
    expect(isTimestampFresh(999, 61_000)).toBe(false);
    expect(isTimestampFresh(121_001, 61_000)).toBe(false);
  });

  it("reads Linear-Timestamp header fallback", () => {
    const headers = new Headers({ "Linear-Timestamp": "61000" });

    expect(timestampFromHeader(headers)).toBe(61_000);
    expect(webhookTimestamp({ webhookTimestamp: "bad" }, headers)).toBe(61_000);
    expect(timestampFromHeader(new Headers({ "Linear-Timestamp": "not-a-number" }))).toBeNull();
  });

  it("detects oversized webhook content length", () => {
    expect(isWebhookBodyTooLarge(new Headers({ "Content-Length": String(100 * 1024 + 1) }))).toBe(true);
    expect(isWebhookBodyTooLarge(new Headers({ "Content-Length": String(100 * 1024) }))).toBe(false);
    expect(isWebhookBodyTooLarge(new Headers({ "Content-Length": "invalid" }))).toBe(false);
  });
});
