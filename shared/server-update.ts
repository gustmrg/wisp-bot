/**
 * The record of the last setup run on a Wisp server, kept by the server's
 * setup in `~/.config/wisp/update.json` and read back over SSH with
 * `wispctl update-status`, so the desktop app can tell what became of an
 * update whose answer it never got (SWE-313). It holds no credentials.
 */
export interface ServerUpdateRecord {
  /** Chosen by whoever started the setup; the desktop app passes one with `--update-id`. */
  id: string;
  /** The version installed before, when there was one. */
  fromVersion?: string;
  targetVersion: string;
  state: ServerUpdateState;
  /** Why it failed or was interrupted. */
  error?: string;
  /** The version the server answered with once it ran again. */
  runningVersion?: string;
  /** The setup's process, to tell one still running from one that died. */
  pid: number;
  startedAt: string;
  updatedAt: string;
}

/**
 * accepted: the setup started. preparing: it installs and checks the target
 * version; the running server is untouched. activating: it stops the server,
 * keeps a copy of its data, opens the data with the target version, and
 * starts the service on it. completed: the server answered at the target
 * version. failed: the setup stopped with an error. rolled-back: the target
 * version could not open the data, so the copy and the previous version were
 * restored (ADR 046). interrupted: its process ended before finishing, for
 * example when the machine restarted.
 */
export type ServerUpdateState =
  | "accepted"
  | "preparing"
  | "activating"
  | "completed"
  | "failed"
  | "rolled-back"
  | "interrupted";

export const UNFINISHED_UPDATE_STATES: ReadonlySet<ServerUpdateState> = new Set([
  "accepted",
  "preparing",
  "activating",
]);

/** Update IDs are UUIDs: they reach a remote shell, so nothing else is accepted. */
export const UPDATE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STATES = new Set<ServerUpdateState>([
  "accepted",
  "preparing",
  "activating",
  "completed",
  "failed",
  "rolled-back",
  "interrupted",
]);

/** A record read from a file or another process, or undefined when it is not one. */
export function parseServerUpdateRecord(value: unknown): ServerUpdateRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const text = (key: string, max = 200): string | undefined =>
    typeof record[key] === "string" && (record[key] as string).length <= max ? (record[key] as string) : undefined;
  const id = text("id");
  const targetVersion = text("targetVersion", 64);
  const state = text("state") as ServerUpdateState | undefined;
  const startedAt = text("startedAt");
  const updatedAt = text("updatedAt");
  if (!id || !UPDATE_ID_PATTERN.test(id) || !targetVersion || !state || !STATES.has(state)) return undefined;
  if (!startedAt || !updatedAt || !Number.isSafeInteger(record.pid)) return undefined;
  const fromVersion = text("fromVersion", 64);
  const runningVersion = text("runningVersion", 64);
  const error = text("error", 2000);
  return {
    id,
    targetVersion,
    state,
    pid: record.pid as number,
    startedAt,
    updatedAt,
    ...(fromVersion ? { fromVersion } : {}),
    ...(runningVersion ? { runningVersion } : {}),
    ...(error ? { error } : {}),
  };
}
