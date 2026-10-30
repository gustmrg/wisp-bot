import type { RuntimeEventEntry, RuntimeEventLogView, RuntimeEventSource } from "../shared/runtime-events.js";

const DEFAULT_MAX_EVENTS = 1_000;
const MAX_STRING_CHARACTERS = 2_000;
const MAX_PAYLOAD_CHARACTERS = 16_000;
const MAX_DEPTH = 12;
/** Keys whose values are credentials wherever they appear; their values are never recorded. */
const SECRET_KEY =
  /^(api[-_]?key|apikey|authorization|proxy-authorization|cookie|set-cookie|password|secret|client[-_]?secret|(access|refresh|id|bearer)?[-_]?token)$/i;

export interface RuntimeEventLogOptions {
  maxEvents?: number;
  now?: () => Date;
}

interface ConversationLog {
  events: RuntimeEventEntry[];
  dropped: boolean;
}

/**
 * The raw events of the conversations someone is debugging (SWE-215). Only
 * conversations with recording turned on keep events, each up to a limit,
 * and only in memory: a restart or turning recording off forgets them.
 */
export class RuntimeEventLog {
  private readonly maxEvents: number;
  private readonly now: () => Date;
  private readonly logs = new Map<string, ConversationLog>();
  private sequence = 0;

  constructor(options: RuntimeEventLogOptions = {}) {
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.now = options.now ?? (() => new Date());
  }

  isRecording(conversationId: string): boolean {
    return this.logs.has(conversationId);
  }

  setRecording(conversationId: string, recording: boolean): RuntimeEventLogView {
    if (!recording) this.logs.delete(conversationId);
    else if (!this.logs.has(conversationId)) this.logs.set(conversationId, { events: [], dropped: false });
    return this.read(conversationId);
  }

  /** Keeps a runtime's event when its conversation is recording; otherwise does nothing, cheaply. */
  record(conversationId: string, runtime: RuntimeEventSource, event: unknown, wispId?: string): void {
    const log = this.logs.get(conversationId);
    if (!log) return;
    const type = (event as { type?: unknown } | null)?.type;
    log.events.push({
      sequence: ++this.sequence,
      ...(wispId ? { wispId } : {}),
      runtime,
      type: typeof type === "string" && type ? type.slice(0, 120) : "unknown",
      receivedAt: this.now().toISOString(),
      payload: debugPayload(event),
    });
    if (log.events.length > this.maxEvents) {
      log.events.splice(0, log.events.length - this.maxEvents);
      log.dropped = true;
    }
  }

  read(conversationId: string, after?: number): RuntimeEventLogView {
    const log = this.logs.get(conversationId);
    const events = log?.events ?? [];
    return {
      conversationId,
      recording: Boolean(log),
      events: after === undefined ? [...events] : events.filter(({ sequence }) => sequence > after),
      dropped: log?.dropped ?? false,
    };
  }

  /** Forgets a conversation that was deleted. */
  forget(conversationId: string): void {
    this.logs.delete(conversationId);
  }
}

/**
 * A runtime event as plain JSON: credentials replaced, long strings and deep
 * nesting cut, cycles and functions dropped, and the whole bounded, so a
 * misbehaving runtime cannot fill the server's memory or leak a key.
 */
export function debugPayload(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === "string") {
      return current.length > MAX_STRING_CHARACTERS
        ? `${current.slice(0, MAX_STRING_CHARACTERS)}… (${current.length} characters)`
        : current;
    }
    if (typeof current === "number") return Number.isFinite(current) ? current : String(current);
    if (typeof current === "bigint") return current.toString();
    if (current === null || typeof current === "boolean") return current;
    if (typeof current !== "object") return undefined;
    if (seen.has(current)) return "[circular]";
    if (depth >= MAX_DEPTH) return "[nested too deep]";
    seen.add(current);
    try {
      if (current instanceof Error) return { name: current.name, message: visit(current.message, depth + 1) };
      if (current instanceof Date) return current.toISOString();
      if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer) return `[${current.byteLength} bytes]`;
      if (Array.isArray(current)) return current.map((item) => visit(item, depth + 1) ?? null);
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) {
        if (SECRET_KEY.test(key) && item !== null && item !== undefined && item !== "") {
          result[key] = "[redacted]";
          continue;
        }
        const next = visit(item, depth + 1);
        if (next !== undefined) result[key] = next;
      }
      return result;
    } finally {
      seen.delete(current);
    }
  };
  const payload = visit(value, 0);
  const json = JSON.stringify(payload) ?? "null";
  if (json.length <= MAX_PAYLOAD_CHARACTERS) return payload;
  return { truncated: true, characters: json.length, preview: json.slice(0, MAX_PAYLOAD_CHARACTERS) };
}
