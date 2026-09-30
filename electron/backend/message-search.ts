import { Worker } from "node:worker_threads";

import type { Message } from "../../shared/conversations.js";
import { messageSearchFragments } from "../../shared/message-search.js";
import { WispBackendError } from "./backend-error.js";

export const MESSAGE_SEARCH_LIMIT = 50;
const SEARCH_TIMEOUT_MS = 10_000;
const SNIPPET_RADIUS = 60;

/** A stored message the index matched, before normalization. */
export interface RawSearchHit {
  conversationId: string;
  messageId: string;
  body: string;
}

// Runs on a worker thread with its own read-only connection (WAL allows
// concurrent readers), so a broad query never blocks the main process or
// streaming replies. Kept as source text so it runs unchanged in Electron,
// packaged builds, and tests without a separately compiled entry point.
// Matches are taken newest first straight from the index and only then looked
// up; joining first and sorting every match is orders of magnitude slower.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let statements;
function prepare() {
  const db = new DatabaseSync(workerData.databasePath, { readOnly: true });
  return {
    hits: db.prepare("SELECT rowid AS seq FROM message_search WHERE message_search MATCH ? ORDER BY rowid DESC LIMIT ?"),
    row: db.prepare("SELECT conversation_id, id, body FROM messages WHERE seq = ?"),
  };
}
parentPort.on("message", ({ id, query, limit }) => {
  try {
    statements ??= prepare();
    const results = [];
    for (const { seq } of statements.hits.all(query, limit)) {
      const row = statements.row.get(seq);
      if (row) results.push({ conversationId: row.conversation_id, messageId: row.id, body: row.body });
    }
    parentPort.postMessage({ id, results });
  } catch (error) {
    parentPort.postMessage({ id, error: String((error && error.message) || error) });
  }
});
`;

interface PendingSearch {
  resolve: (hits: ReadonlyArray<RawSearchHit>) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Runs full-text queries against the conversation store on a worker thread. */
export class MessageSearchWorker {
  private worker: Worker | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, PendingSearch>();

  constructor(
    private readonly databasePath: string,
    private readonly timeoutMs = SEARCH_TIMEOUT_MS,
  ) {}

  /** Newest matches first. `query` is user text; it is always matched as a literal phrase. */
  search(query: string, limit = MESSAGE_SEARCH_LIMIT): Promise<ReadonlyArray<RawSearchHit>> {
    const worker = this.ensureWorker();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A stuck query takes its worker with it; the next search starts a fresh one.
        this.stop(new WispBackendError("internal_error", "Message search took too long.", true));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, query: quotePhrase(query), limit });
    });
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.stop(new WispBackendError("disposed", "Message search has stopped."));
    await worker?.terminate();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { databasePath: this.databasePath } });
    worker.unref();
    worker.on("message", (response: { id: number; results?: RawSearchHit[]; error?: string }) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.results) pending.resolve(response.results);
      else pending.reject(new WispBackendError("internal_error", "Message search failed.", true));
    });
    const fail = (): void => {
      if (this.worker === worker) this.stop(new WispBackendError("internal_error", "Message search failed.", true));
    };
    worker.on("error", fail);
    worker.on("exit", fail);
    this.worker = worker;
    return worker;
  }

  private stop(error: WispBackendError): void {
    const worker = this.worker;
    this.worker = undefined;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    void worker?.terminate();
  }
}

/** Wraps user text as one FTS5 phrase so operators such as OR, NEAR, or * are matched literally. */
export function quotePhrase(query: string): string {
  return `"${query.trim().replaceAll('"', '""')}"`;
}

/**
 * A short excerpt of the fragment that contains `query`, compared the way the
 * index compares (case- and accent-insensitively), with ellipses where cut.
 */
export function buildSnippet(message: Message, query: string): string {
  const needle = fold(query.trim()).folded;
  const fragments = messageSearchFragments(message).filter((fragment) => fragment.trim());
  for (const fragment of fragments) {
    const { folded, origin } = fold(fragment);
    const at = needle ? folded.indexOf(needle) : -1;
    if (at === -1) continue;
    const start = origin[at]!;
    const last = origin[at + needle.length - 1]!;
    const end = last + (fragment.codePointAt(last)! > 0xffff ? 2 : 1);
    return excerpt(fragment, Math.max(0, start - SNIPPET_RADIUS), Math.min(fragment.length, end + SNIPPET_RADIUS));
  }
  // The index and this comparison fold a few characters differently; fall back to the opening text.
  const first = fragments[0] ?? "";
  return excerpt(first, 0, Math.min(first.length, SNIPPET_RADIUS * 2));
}

function excerpt(text: string, from: number, to: number): string {
  const body = text.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`;
}

// Case- and accent-folded text, with the original index of each folded unit.
function fold(text: string): { folded: string; origin: number[] } {
  let folded = "";
  const origin: number[] = [];
  let index = 0;
  for (const char of text) {
    const piece = char
      .normalize("NFD")
      .replace(/\p{Mn}/gu, "")
      .toLowerCase();
    for (let unit = 0; unit < piece.length; unit += 1) origin.push(index);
    folded += piece;
    index += char.length;
  }
  return { folded, origin };
}
