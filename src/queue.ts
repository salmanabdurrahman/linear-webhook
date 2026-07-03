import type { ParsedLinearWebhookEvent } from "./linear";
import { sendTelegramNotification, type TelegramConfig } from "./telegram";

export interface NotificationJob {
  deliveryId: string | null;
  event: ParsedLinearWebhookEvent;
}

const DELIVERY_TTL_SECONDS = 60 * 60 * 24 * 7;

export function getDeliveryId(event: ParsedLinearWebhookEvent): string | null {
  return event.metadata.delivery ?? event.metadata.webhookId;
}

export async function isDuplicateDelivery(store: KVNamespace | undefined, deliveryId: string | null): Promise<boolean> {
  if (!store || !deliveryId) {
    return false;
  }

  return (await store.get(deliveryId)) !== null;
}

export async function markDeliveryQueued(store: KVNamespace | undefined, deliveryId: string | null): Promise<void> {
  await markDelivery(store, deliveryId, "queued");
}

export async function markDeliverySent(store: KVNamespace | undefined, deliveryId: string | null): Promise<void> {
  await markDelivery(store, deliveryId, "sent");
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
  if (store && job.deliveryId && (await store.get(job.deliveryId)) === "sent") {
    console.log("duplicate notification job skipped", { deliveryId: job.deliveryId });
    return;
  }

  const result = await sendTelegramNotification(config, job.event);

  if (!result.sent) {
    console.warn("telegram notification retry scheduled");
    throw new Error("telegram notification failed");
  }

  await markDeliverySent(store, job.deliveryId);
}

async function markDelivery(store: KVNamespace | undefined, deliveryId: string | null, status: "queued" | "sent"): Promise<void> {
  if (!store || !deliveryId) {
    return;
  }

  await store.put(deliveryId, status, { expirationTtl: DELIVERY_TTL_SECONDS });
}
