import { Elysia } from "elysia";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";

export const app = new Elysia({ adapter: CloudflareAdapter })
  .get("/", () => ({
    service: "linear-webhook",
    status: "ok",
  }))
  .get("/health", () => "ok")
  .compile();

export default app;
