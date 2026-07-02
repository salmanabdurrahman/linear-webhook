export type SupportedLinearEventType = "Issue" | "Comment";

export interface LinearWebhookPayload {
  type?: unknown;
  action?: unknown;
  actor?: {
    name?: unknown;
  } | null;
  data?: {
    title?: unknown;
    body?: unknown;
    description?: unknown;
  } | null;
  url?: unknown;
  webhookId?: unknown;
  webhookTimestamp?: unknown;
}

export interface LinearWebhookMetadata {
  type: string | null;
  action: string | null;
  title: string | null;
  bodyPreview: string | null;
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
    title: stringOrNull(payload.data?.title),
    bodyPreview: previewBody(payload.data?.body ?? payload.data?.description),
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
  const { type, action, actorName, url, webhookId, delivery, event: eventName } = event.metadata;

  console.log("linear webhook received", {
    type,
    action,
    actorName,
    url,
    webhookId,
    delivery,
    event: eventName,
    supported: event.supported,
  });
}

function isSupportedLinearEvent(type: string | null): type is SupportedLinearEventType {
  return type !== null && supportedEventTypes.has(type as SupportedLinearEventType);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function previewBody(value: unknown): string | null {
  const text = stringOrNull(value);

  if (!text) {
    return null;
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 179)}…`;
}
