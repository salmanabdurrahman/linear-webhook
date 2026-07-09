export type LogLevel = "log" | "warn" | "error";

export type LogExtra = Record<string, unknown>;

export interface LoggerContext {
  deliveryId?: string | null;
  webhookId?: string | null;
  eventType?: string | null;
}

export function log(level: LogLevel, msg: string, extra: LogExtra = {}): void {
  console[level](JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...extra,
  }));
}

export function withLoggerContext(context: LoggerContext): (level: LogLevel, msg: string, extra?: LogExtra) => void {
  const base = cleanContext(context);

  return (level, msg, extra = {}) => log(level, msg, { ...base, ...extra });
}

function cleanContext(context: LoggerContext): LogExtra {
  const extra: LogExtra = {};

  if (context.deliveryId) {
    extra["deliveryId"] = context.deliveryId;
  }

  if (context.webhookId) {
    extra["webhookId"] = context.webhookId;
  }

  if (context.eventType) {
    extra["eventType"] = context.eventType;
  }

  return extra;
}
