const SENSITIVE_KEY = /(api.?key|authorization|credential|password|prompt|secret|token|content|text)/i;
const SECRET_VALUE = /(bearer\s+[a-z0-9._~+/-]+|sk-[a-z0-9_-]{8,})/gi;
const MAX_FIELD_LENGTH = 256;

export interface LogSink {
  info(value: string): void;
  warn(value: string): void;
}

export class StructuredLogger {
  private readonly sink: LogSink;

  constructor(sink: LogSink = console) {
    this.sink = sink;
  }

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.sink.info(serialize(event, fields));
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.sink.warn(serialize(event, fields));
  }
}

export function redactLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(value),
  ]));
}

function serialize(event: string, fields: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    event: safeString(event),
    ...redactLogFields(fields),
  });
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return safeString(value).replaceAll(SECRET_VALUE, "[REDACTED]");
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(redactValue);
  if (value && typeof value === "object") return redactLogFields(value as Record<string, unknown>);
  return String(value).slice(0, MAX_FIELD_LENGTH);
}

function safeString(value: string): string {
  return value.replaceAll(/[\r\n\t]+/g, " ").slice(0, MAX_FIELD_LENGTH);
}
