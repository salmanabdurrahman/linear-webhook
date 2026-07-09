import type { ParsedLinearWebhookEvent } from "./linear";
import { withLoggerContext } from "./logger";

export interface TelegramConfig {
  botToken?: string;
  chatId?: string;
}

export interface TelegramSendResult {
  sent: boolean;
  skipped: boolean;
  error?: string;
}

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const MAX_PREVIEW_LENGTH = 180;
const MAX_FIELD_LENGTH = 240;
const MAX_URL_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 3_900;

export async function sendTelegramNotification(
  config: TelegramConfig,
  event: ParsedLinearWebhookEvent,
  fetchFn: typeof fetch = fetch,
): Promise<TelegramSendResult> {
  const missingConfig = getMissingTelegramConfig(config);

  const logger = withLoggerContext({
    deliveryId: event.metadata.delivery,
    webhookId: event.metadata.webhookId,
    eventType: event.metadata.type,
  });

  if (missingConfig.length > 0) {
    logger("warn", "telegram notification skipped: missing config", { missingConfig });
    return { sent: false, skipped: true, error: "missing telegram config" };
  }

  const response = await fetchFn(`${TELEGRAM_API_BASE_URL}/bot${config.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.chatId,
      text: formatTelegramMessage(event),
    }),
  });

  if (!response.ok) {
    logger("warn", "telegram notification failed", { status: response.status });
    return { sent: false, skipped: false, error: "telegram request failed" };
  }

  return { sent: true, skipped: false };
}

export function formatTelegramMessage(event: ParsedLinearWebhookEvent): string {
  const { metadata } = event;
  const lines = [formatHeading(event)];
  const title = metadata.issueTitle ?? metadata.title;

  if (title) {
    lines.push(truncateText(title, MAX_FIELD_LENGTH));
  }

  if (metadata.type === "Comment") {
    addBlankLine(lines);

    if (metadata.bodyPreview) {
      lines.push(metadata.bodyPreview);
    }
  } else if (metadata.type === "Issue" && metadata.action === "update") {
    addBlankLine(lines);

    if (metadata.actorName) {
      lines.push(truncateText(`By ${metadata.actorName}`, MAX_FIELD_LENGTH));
    }

    if (metadata.changedFields.length > 0) {
      lines.push(truncateText(`Changed: ${metadata.changedFields.join(", ")}`, MAX_FIELD_LENGTH));
    } else if (metadata.bodyPreview) {
      lines.push(`Preview: ${metadata.bodyPreview}`);
    }
  } else {
    addBlankLine(lines);

    if (metadata.actorName) {
      lines.push(truncateText(`By ${metadata.actorName}`, MAX_FIELD_LENGTH));
    }

    const details = formatIssueDetails(event);
    if (details.length > 0) {
      lines.push(truncateText(`Details: ${details.join(", ")}`, MAX_FIELD_LENGTH));
    }

    if (metadata.bodyPreview) {
      lines.push(metadata.bodyPreview);
    }
  }

  if (metadata.url) {
    addBlankLine(lines);
    lines.push(`Open: ${truncateText(metadata.url, MAX_URL_LENGTH)}`);
  }

  return truncateText(trimBlankLines(lines).join("\n"), MAX_MESSAGE_LENGTH);
}

function formatHeading(event: ParsedLinearWebhookEvent): string {
  const { metadata } = event;
  const issueLabel = metadata.issueIdentifier ?? metadata.issueTitle ?? "Linear issue";

  if (metadata.type === "Comment") {
    const actor = metadata.actorName ?? "Someone";
    return truncateText(`💬 ${actor} commented on ${issueLabel}`, MAX_FIELD_LENGTH);
  }

  if (metadata.type === "Issue") {
    if (metadata.action === "update") {
      return truncateText(`📝 ${issueLabel} updated`, MAX_FIELD_LENGTH);
    }

    if (metadata.action === "create") {
      return truncateText(`✨ ${issueLabel} created`, MAX_FIELD_LENGTH);
    }

    return truncateText(`📝 ${issueLabel}`, MAX_FIELD_LENGTH);
  }

  return "Linear webhook event";
}

function formatIssueDetails(event: ParsedLinearWebhookEvent): string[] {
  const { metadata } = event;
  const details: string[] = [];

  if (metadata.state) {
    details.push(`state ${metadata.state}`);
  }

  if (metadata.assignee) {
    details.push(`assignee ${metadata.assignee}`);
  }

  if (metadata.priority) {
    details.push(`priority ${metadata.priority}`);
  }

  if (metadata.labels.length > 0) {
    details.push(`labels ${metadata.labels.join(", ")}`);
  }

  if (metadata.team) {
    details.push(`team ${metadata.team}`);
  }

  return details.map((detail) => truncateText(detail, MAX_FIELD_LENGTH));
}

function addBlankLine(lines: string[]): void {
  if (lines[lines.length - 1] !== "") {
    lines.push("");
  }
}

function trimBlankLines(lines: string[]): string[] {
  while (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

function getMissingTelegramConfig(config: TelegramConfig): string[] {
  const missingConfig: string[] = [];

  if (!config.botToken) {
    missingConfig.push("TELEGRAM_BOT_TOKEN");
  }

  if (!config.chatId) {
    missingConfig.push("TELEGRAM_CHAT_ID");
  }

  return missingConfig;
}

export function previewText(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length === 0) {
    return null;
  }

  return truncateText(normalized, MAX_PREVIEW_LENGTH);
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}
