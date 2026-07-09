import type { ParsedLinearWebhookEvent } from "./linear";
import { sendTelegramNotification, type TelegramConfig } from "./telegram";

export interface NotificationJob {
  deliveryId: string | null;
  event: ParsedLinearWebhookEvent;
}

export type DeliveryStatus = "queued" | "sent" | "failed";

interface DeliveryRecord {
  status: DeliveryStatus;
  updatedAt: number;
  attempts?: number;
}

const DELIVERY_TTL_SECONDS = 60 * 60 * 24 * 7;
const QUEUED_REPLAY_AFTER_MS = 5 * 60 * 1000;
const QUEUE_FAILURE_ALERT_THRESHOLD = 3;

export function getDeliveryId(event: ParsedLinearWebhookEvent): string | null {
  return event.metadata.delivery ?? event.metadata.webhookId;
}

export async function isDuplicateDelivery(store: KVNamespace | undefined, deliveryId: string | null, now = Date.now()): Promise<boolean> {
  if (!store || !deliveryId) {
    return false;
  }

  const record = parseDeliveryRecord(await store.get(deliveryId));

  if (!record) {
    return false;
  }

  if (record.status === "sent") {
    return true;
  }

  if (record.status === "queued") {
    if (now - record.updatedAt <= QUEUED_REPLAY_AFTER_MS) {
      return true;
    }

    console.warn("stale queued delivery replay allowed", { deliveryId });
  }

  return false;
}

export async function markDeliveryQueued(store: KVNamespace | undefined, deliveryId: string | null, now = Date.now()): Promise<void> {
  await markDelivery(store, deliveryId, { status: "queued", updatedAt: now });
}

export async function markDeliverySent(store: KVNamespace | undefined, deliveryId: string | null, now = Date.now()): Promise<void> {
  await markDelivery(store, deliveryId, { status: "sent", updatedAt: now });
}

export async function markDeliveryFailed(store: KVNamespace | undefined, deliveryId: string | null, now = Date.now()): Promise<void> {
  if (!store || !deliveryId) {
    return;
  }

  const previous = parseDeliveryRecord(await store.get(deliveryId));
  const attempts = (previous?.attempts ?? 0) + 1;

  await markDelivery(store, deliveryId, { status: "failed", updatedAt: now, attempts });

  if (attempts >= QUEUE_FAILURE_ALERT_THRESHOLD) {
    console.warn("notification delivery repeatedly failed", { deliveryId, attempts });
  }
}

export async function clearDelivery(store: KVNamespace | undefined, deliveryId: string | null): Promise<void> {
  if (!store || !deliveryId) {
    return;
  }

  await store.delete(deliveryId);
}

export async function deliverNotificationJob(
  job: NotificationJob,
  config: TelegramConfig,
  store: KVNamespace | undefined,
): Promise<void> {
  const record = store && job.deliveryId ? parseDeliveryRecord(await store.get(job.deliveryId)) : null;

  if (record?.status === "sent") {
    console.log("duplicate notification job skipped", { deliveryId: job.deliveryId });
    return;
  }

  const result = await sendTelegramNotification(config, job.event);

  if (!result.sent) {
    await markDeliveryFailed(store, job.deliveryId);
    console.warn("telegram notification retry scheduled");
    throw new Error("telegram notification failed");
  }

  await markDeliverySent(store, job.deliveryId);
}

async function markDelivery(store: KVNamespace | undefined, deliveryId: string | null, record: DeliveryRecord): Promise<void> {
  if (!store || !deliveryId) {
    return;
  }

  await store.put(deliveryId, JSON.stringify(record), { expirationTtl: DELIVERY_TTL_SECONDS });
}

export function parseDeliveryRecord(value: string | null): DeliveryRecord | null {
  if (!value) {
    return null;
  }

  if (value === "sent") {
    return { status: "sent", updatedAt: Date.now() };
  }

  if (value === "queued" || value === "failed") {
    return { status: value, updatedAt: 0 };
  }

  try {
    const parsed = JSON.parse(value) as Partial<DeliveryRecord>;

    if (
      (parsed.status === "queued" || parsed.status === "sent" || parsed.status === "failed") &&
      typeof parsed.updatedAt === "number"
    ) {
      return {
        status: parsed.status,
        updatedAt: parsed.updatedAt,
        attempts: typeof parsed.attempts === "number" ? parsed.attempts : undefined,
      };
    }
  } catch {
    return null;
  }

  return null;
}
