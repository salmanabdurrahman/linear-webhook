import app from "../src/index";

export type StoredDeliveryStatus = "queued" | "sent" | "failed";
export type KvStore = Pick<KVNamespace, "get" | "put" | "delete">;

export function createMemoryKv(initial: Record<string, string> = {}): KVNamespace {
  const values = new Map(Object.entries(initial));

  return {
    get: ((key: string) => Promise.resolve(values.get(key) ?? null)) as KVNamespace["get"],
    put: (key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      values.delete(key);
      return Promise.resolve();
    },
  } as KvStore as KVNamespace;
}

export function deliveryStatus(value: string | null): StoredDeliveryStatus | null {
  if (!value) {
    return null;
  }

  if (value === "queued" || value === "sent" || value === "failed") {
    return value;
  }

  return (JSON.parse(value) as { status: StoredDeliveryStatus }).status;
}

export async function postLinearWebhook(
  body: string,
  signature: string,
  headers: Record<string, string> = {},
  env: Record<string, unknown> = {},
): Promise<Response> {
  return app.fetch(
    new Request("http://localhost/webhooks/linear", {
      method: "POST",
      headers: { "Linear-Signature": signature, ...headers },
      body,
    }),
    { LINEAR_WEBHOOK_SECRET: "test-secret", ...env },
  );
}
