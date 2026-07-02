import { describe, expect, it } from "bun:test";
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
