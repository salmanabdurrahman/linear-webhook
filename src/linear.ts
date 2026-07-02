export type SupportedLinearEventType = "Issue" | "Comment";

export interface LinearWebhookPayload {
  type?: unknown;
  action?: unknown;
  actor?: {
    name?: unknown;
  } | null;
  url?: unknown;
  webhookId?: unknown;
  webhookTimestamp?: unknown;
}

export interface LinearWebhookMetadata {
  type: string | null;
  action: string | null;
  actorName: string | null;
  url: string | null;
  webhookId: string | null;
  delivery: string | null;
  event: string | null;
}

export interface ParsedLinearWebhookEvent {
  metadata: LinearWebhookMetadata;
  supported: boolean;
}

const supportedEventTypes = new Set<SupportedLinearEventType>(["Issue", "Comment"]);

export function parseLinearWebhookEvent(
  payload: LinearWebhookPayload,
  headers: Headers,
): ParsedLinearWebhookEvent {
  const metadata: LinearWebhookMetadata = {
    type: stringOrNull(payload.type),
    action: stringOrNull(payload.action),
    actorName: stringOrNull(payload.actor?.name),
    url: stringOrNull(payload.url),
    webhookId: stringOrNull(payload.webhookId),
    delivery: headers.get("Linear-Delivery"),
    event: headers.get("Linear-Event"),
  };

  return {
    metadata,
    supported: isSupportedLinearEvent(metadata.type),
  };
}

export function logLinearWebhookEvent(event: ParsedLinearWebhookEvent): void {
  console.log("linear webhook received", {
    ...event.metadata,
    supported: event.supported,
  });
}

function isSupportedLinearEvent(type: string | null): type is SupportedLinearEventType {
  return type !== null && supportedEventTypes.has(type as SupportedLinearEventType);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
