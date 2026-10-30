/**
 * The raw events a Wisp's runtime emits, as the runtime events view of a
 * conversation's **Usage** tab shows them. Recording is a debugging aid: it
 * starts off and is turned on per conversation. The events are kept in a file
 * per conversation in the data directory of the computer or server that runs
 * the Wisp, where an agent on that machine can read them.
 */

/** The runtime that emitted an event: Pi's agent events, Claude Code's SDK messages, or the fake agent's. */
export type RuntimeEventSource = "pi" | "claude-code" | "fake";

export interface RuntimeEventEntry {
  /** Increases with every event the conversation records, across restarts. */
  sequence: number;
  /** The Wisp whose runtime emitted it; in a circle, one of its members. */
  wispId?: string;
  runtime: RuntimeEventSource;
  /** The event's own `type`, or `unknown` when it has none. */
  type: string;
  receivedAt: string;
  /** The event as JSON, with long strings shortened and credentials removed. */
  payload: unknown;
}

export interface RuntimeEventLogView {
  conversationId: string;
  recording: boolean;
  /** Oldest first; only the events after the request's `after`, when it has one. */
  events: RuntimeEventEntry[];
  /** Whether older events were dropped to keep the log within its limit. */
  dropped: boolean;
}

export interface RuntimeEventLogRequest {
  conversationId: string;
  /** Returns only events with a greater `sequence`. */
  after?: number;
}

/** Where **Save to workspace** put the log, relative to the workspace root. */
export interface SavedRuntimeEvents {
  path: string;
  size: number;
}

export interface RuntimeEventRecordingRequest {
  conversationId: string;
  recording: boolean;
}
