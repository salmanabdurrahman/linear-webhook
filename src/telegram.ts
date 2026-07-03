import type { ParsedLinearWebhookEvent } from "./linear";

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

export async function sendTelegramNotification(
  config: TelegramConfig,
  event: ParsedLinearWebhookEvent,
  fetchFn: typeof fetch = fetch,
): Promise<TelegramSendResult> {
  const missingConfig = getMissingTelegramConfig(config);

  if (missingConfig.length > 0) {
    console.warn("telegram notification skipped: missing config", { missingConfig });
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
    console.warn("telegram notification failed", { status: response.status });
    return { sent: false, skipped: false, error: "telegram request failed" };
  }

  return { sent: true, skipped: false };
}

export function formatTelegramMessage(event: ParsedLinearWebhookEvent): string {
  const { metadata } = event;
  const lines = [formatHeading(event)];
  const title = metadata.issueTitle ?? metadata.title;

  if (title) {
    lines.push(title);
  }

  if (metadata.type === "Comment") {
    addBlankLine(lines);

    if (metadata.bodyPreview) {
      lines.push(metadata.bodyPreview);
    }
  } else if (metadata.type === "Issue" && metadata.action === "update") {
    addBlankLine(lines);

    if (metadata.actorName) {
      lines.push(`By ${metadata.actorName}`);
    }

    if (metadata.changedFields.length > 0) {
      lines.push(`Changed: ${metadata.changedFields.join(", ")}`);
    } else if (metadata.bodyPreview) {
      lines.push(`Preview: ${metadata.bodyPreview}`);
    }
  } else {
    addBlankLine(lines);

    if (metadata.actorName) {
      lines.push(`By ${metadata.actorName}`);
    }

    const details = formatIssueDetails(event);
    if (details.length > 0) {
      lines.push(`Details: ${details.join(", ")}`);
    }

    if (metadata.bodyPreview) {
      lines.push(metadata.bodyPreview);
    }
  }

  if (metadata.url) {
    addBlankLine(lines);
    lines.push(`Open: ${metadata.url}`);
  }

  return trimBlankLines(lines).join("\n");
}

function formatHeading(event: ParsedLinearWebhookEvent): string {
  const { metadata } = event;
  const issueLabel = metadata.issueIdentifier ?? metadata.issueTitle ?? "Linear issue";

  if (metadata.type === "Comment") {
    const actor = metadata.actorName ?? "Someone";
    return `💬 ${actor} commented on ${issueLabel}`;
  }

  if (metadata.type === "Issue") {
    if (metadata.action === "update") {
      return `📝 ${issueLabel} updated`;
    }

    if (metadata.action === "create") {
      return `✨ ${issueLabel} created`;
    }

    return `📝 ${issueLabel}`;
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

  return details;
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

  if (normalized.length <= MAX_PREVIEW_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_PREVIEW_LENGTH - 1)}…`;
}
