import * as v from "valibot";

export type SupportedLinearEventType = "Issue" | "Comment";

const LinearNamedEntitySchema = v.object({
  id: v.optional(v.unknown()),
  name: v.optional(v.unknown()),
});

const LinearIssueReferenceSchema = v.object({
  identifier: v.optional(v.unknown()),
  title: v.optional(v.unknown()),
  url: v.optional(v.unknown()),
});

const LinearLabelsSchema = v.union([
  v.object({ nodes: v.optional(v.array(LinearNamedEntitySchema)) }),
  v.array(v.unknown()),
  v.null(),
]);

const LinearWebhookDataSchema = v.object({
  identifier: v.optional(v.unknown()),
  number: v.optional(v.unknown()),
  title: v.optional(v.unknown()),
  body: v.optional(v.unknown()),
  description: v.optional(v.unknown()),
  state: v.optional(v.union([LinearNamedEntitySchema, v.string(), v.null()])),
  assignee: v.optional(v.nullable(LinearNamedEntitySchema)),
  priority: v.optional(v.unknown()),
  priorityLabel: v.optional(v.unknown()),
  labels: v.optional(LinearLabelsSchema),
  team: v.optional(v.nullable(LinearNamedEntitySchema)),
  issue: v.optional(v.nullable(LinearIssueReferenceSchema)),
});

const LinearWebhookChangesSchema = v.record(v.string(), v.unknown());

export const LinearWebhookPayloadSchema = v.object({
  type: v.optional(v.unknown()),
  action: v.optional(v.unknown()),
  actor: v.optional(v.nullable(LinearNamedEntitySchema)),
  data: v.optional(v.nullable(LinearWebhookDataSchema)),
  updatedFrom: v.optional(v.nullable(LinearWebhookChangesSchema)),
  url: v.optional(v.unknown()),
  webhookId: v.optional(v.unknown()),
  webhookTimestamp: v.optional(v.unknown()),
});

export type LinearWebhookPayload = v.InferOutput<typeof LinearWebhookPayloadSchema>;

type LinearNamedEntity = v.InferOutput<typeof LinearNamedEntitySchema>;
type LinearWebhookData = v.InferOutput<typeof LinearWebhookDataSchema>;
type LinearWebhookChanges = v.InferOutput<typeof LinearWebhookChangesSchema>;

export interface LinearPayloadValidationFailure {
  ok: false;
  errorType: "invalid_payload";
}

export interface LinearPayloadValidationSuccess {
  ok: true;
  payload: LinearWebhookPayload;
}

export type LinearPayloadValidationResult = LinearPayloadValidationFailure | LinearPayloadValidationSuccess;

export function validateLinearWebhookPayload(value: unknown): LinearPayloadValidationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errorType: "invalid_payload" };
  }

  const result = v.safeParse(LinearWebhookPayloadSchema, value);

  if (!result.success) {
    return { ok: false, errorType: "invalid_payload" };
  }

  return { ok: true, payload: result.output };
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
