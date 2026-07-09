import { describe, expect, it } from "bun:test";
import { buildCurlCommand, parseArgs, shellQuote } from "../scripts/sign-payload";

describe("sign-payload script", () => {
  it("parses defaults and overrides", () => {
    expect(parseArgs([], "env-secret")).toEqual({
      secret: "env-secret",
      url: "http://localhost:8787/webhooks/linear",
      type: "Issue",
      action: "create",
    });

    expect(parseArgs(["--secret", "cli-secret", "--url", "http://localhost:8787/hook", "--type", "Comment", "--action", "update"], "env-secret")).toEqual({
      secret: "cli-secret",
      url: "http://localhost:8787/hook",
      type: "Comment",
      action: "update",
    });
  });

  it("rejects unknown or incomplete args", () => {
    expect(() => parseArgs(["--url"], undefined)).toThrow("Unknown or incomplete argument: --url");
    expect(() => parseArgs(["--bad"], undefined)).toThrow("Unknown or incomplete argument: --bad");
  });

  it("shell-quotes single quotes safely", () => {
    expect(shellQuote("can't break")).toBe("'can'\\''t break'");
  });

  it("builds well-formed curl command", async () => {
    const command = await buildCurlCommand({
      secret: "test-secret",
      url: "http://localhost:8787/webhooks/linear?name=can't-break",
      type: "Comment",
      action: "create",
    }, 123);

    expect(command).toStartWith("curl -i '");
    expect(command).toContain("-X POST");
    expect(command).toContain("-H 'Content-Type: application/json'");
    expect(command).toContain("-H 'Linear-Signature: sha256=");
    expect(command).toContain("-H 'Linear-Delivery: local-delivery'");
    expect(command).toContain("-H 'Linear-Event: Comment'");
    expect(command).toContain("can'\\''t-break");
    expect(command).toContain('"webhookTimestamp":123');
    expect(command).toContain('"type":"Comment"');
  });
});
