export type SupportedLinearEventType = "Issue" | "Comment";

export interface LinearWebhookPayload {
  type?: unknown;
  action?: unknown;
  actor?: LinearNamedEntity | null;
  data?: LinearWebhookData | null;
  updatedFrom?: LinearWebhookChanges | null;
  url?: unknown;
  webhookId?: unknown;
  webhookTimestamp?: unknown;
}

interface LinearNamedEntity {
  id?: unknown;
  name?: unknown;
}

interface LinearWebhookData {
  identifier?: unknown;
  number?: unknown;
  title?: unknown;
  body?: unknown;
  description?: unknown;
  state?: LinearNamedEntity | string | null;
  assignee?: LinearNamedEntity | null;
  priority?: unknown;
  priorityLabel?: unknown;
  labels?: {
    nodes?: LinearNamedEntity[];
  } | LinearNamedEntity[] | null;
  team?: LinearNamedEntity | null;
  issue?: {
    identifier?: unknown;
    title?: unknown;
    url?: unknown;
  } | null;
}

interface LinearWebhookChanges {
  [field: string]: unknown;
}

export interface LinearWebhookMetadata {
  type: string | null;
  action: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  title: string | null;
  bodyPreview: string | null;
  actorName: string | null;
  url: string | null;
  changedFields: string[];
  state: string | null;
  assignee: string | null;
  priority: string | null;
  labels: string[];
  team: string | null;
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
  const data = payload.data;
  const issueIdentifier = stringOrNull(data?.identifier) ?? issueIdentifierFromNumber(data?.number) ?? stringOrNull(data?.issue?.identifier);
  const issueTitle = stringOrNull(data?.issue?.title) ?? stringOrNull(data?.title);

  const metadata: LinearWebhookMetadata = {
    type: stringOrNull(payload.type),
    action: stringOrNull(payload.action),
    issueIdentifier,
    issueTitle,
    title: stringOrNull(data?.title),
    bodyPreview: previewBody(data?.body ?? data?.description),
    actorName: stringOrNull(payload.actor?.name),
    url: stringOrNull(payload.url) ?? stringOrNull(data?.issue?.url),
    changedFields: changedFieldsFrom(payload.updatedFrom),
    state: nameFromEntity(data?.state),
    assignee: nameFromEntity(data?.assignee),
    priority: stringOrNull(data?.priorityLabel) ?? stringOrNull(data?.priority) ?? numberToString(data?.priority),
    labels: labelsFrom(data?.labels),
    team: nameFromEntity(data?.team),
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
  const {
    type,
    action,
    issueIdentifier,
    issueTitle,
    actorName,
    url,
    changedFields,
    state,
    assignee,
    priority,
    labels,
    team,
    webhookId,
    delivery,
    event: eventName,
  } = event.metadata;

  console.log("linear webhook received", {
    type,
    action,
    issueIdentifier,
    issueTitle,
    actorName,
    url,
    changedFields,
    state,
    assignee,
    priority,
    labels,
    team,
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

function issueIdentifierFromNumber(value: unknown): string | null {
  return typeof value === "number" && Number.isInteger(value) ? String(value) : null;
}

function numberToString(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function nameFromEntity(value: unknown): string | null {
  if (typeof value === "string") {
    return stringOrNull(value);
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  return stringOrNull((value as LinearNamedEntity).name);
}

function labelsFrom(value: LinearWebhookData["labels"]): string[] {
  const labels = Array.isArray(value) ? value : value?.nodes;

  if (!Array.isArray(labels)) {
    return [];
  }

  return labels.map(nameFromEntity).filter((label): label is string => label !== null);
}

function changedFieldsFrom(updatedFrom: LinearWebhookChanges | null | undefined): string[] {
  if (!updatedFrom || typeof updatedFrom !== "object") {
    return [];
  }

  return Object.keys(updatedFrom).filter((field) => field.length > 0).sort();
}
