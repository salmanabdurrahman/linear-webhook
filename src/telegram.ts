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
  const lines = [
    "Linear webhook event",
    `Type: ${metadata.type ?? "unknown"}`,
    `Action: ${metadata.action ?? "unknown"}`,
  ];

  if (metadata.title) {
    lines.push(`Title: ${metadata.title}`);
  }

  if (metadata.bodyPreview) {
    lines.push(`Body: ${metadata.bodyPreview}`);
  }

  if (metadata.actorName) {
    lines.push(`Actor: ${metadata.actorName}`);
  }

  if (metadata.url) {
    lines.push(`URL: ${metadata.url}`);
  }

  if (metadata.delivery) {
    lines.push(`Delivery: ${metadata.delivery}`);
  }

  return lines.join("\n");
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
