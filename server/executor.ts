import { createHash } from "node:crypto";
import type { AgentRegistry } from "../backend/agent-registry.js";
import { sanitizeBackendError } from "../backend/backend-error.js";
import type { SendMessageRequest, SequencedConversationAgentEvent } from "../shared/contracts.js";
import type { Message } from "../shared/conversations.js";
import { HttpError } from "./errors.js";
import type { ServerDatabase } from "./storage/database.js";
import type { SqliteConversationRepository } from "./storage/conversation-repository.js";

export type RequestStatus = "queued" | "running" | "completed" | "cancelled" | "failed" | "interrupted";
export interface RequestAdmission {
  requestId: string;
  status: RequestStatus;
  revision: number;
  errorCode?: string;
}

/** Only this executor hands queued commands to Pi. Uncertain running work is never replayed. */
export class DurableExecutor {
  private readonly active = new Map<string, Promise<void>>();
  private readonly activeRequests = new Map<string, string>();
  private readonly cancellations = new Set<string>();
  private stopped = false;
  private maintenance = false;
  private readonly checkpoints = new Map<
    string,
    {
      event: SequencedConversationAgentEvent & { type: "assistant_text_delta" };
      text: string;
      delta: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private readonly database: ServerDatabase,
    private readonly repository: SqliteConversationRepository,
    private readonly registry: AgentRegistry,
  ) {}

  recover(): void {
    this.database.transaction(() => {
      const rows = this.database.sql.prepare("SELECT conversation_id,id FROM requests WHERE status='running'").all();
      for (const row of rows) {
        this.terminal(row.conversation_id as string, row.id as string, "interrupted", "interrupted");
        const messages = this.repository.messages(row.conversation_id as string).messages;
        for (const message of messages)
          if (message.status === "streaming" || (message.id === row.id && message.type === "outgoing"))
            this.repository.appendMessageSync(
              row.conversation_id as string,
              { ...message, status: "failed" } as Message,
            );
      }
      this.database.sql
        .prepare("UPDATE approvals SET state='expired',decided_at=? WHERE state='pending'")
        .run(new Date().toISOString());
    });
    this.pump();
  }

  admit(request: SendMessageRequest): RequestAdmission {
    if (this.stopped || this.maintenance)
      throw new HttpError(503, "unavailable", "The server is in maintenance. Try again later.", true);
    const payload = JSON.stringify({
      conversationId: request.conversationId,
      requestId: request.requestId,
      text: request.text,
    });
    const payloadHash = createHash("sha256").update(payload).digest("hex");
    const result = this.database.transaction(() => {
      const existing = this.database.sql
        .prepare("SELECT payload_hash,status,revision,error_code FROM requests WHERE conversation_id=? AND id=?")
        .get(request.conversationId, request.requestId);
      if (existing) {
        if (existing.payload_hash !== payloadHash)
          throw new HttpError(409, "conflict", "This request ID was already used for another message.");
        return {
          requestId: request.requestId,
          status: existing.status as RequestStatus,
          revision: Number(existing.revision),
        };
      }
      this.repository.getAgentContext(request.conversationId);
      if (this.registry.getModelView(request.conversationId).status === "configuration_required")
        throw new HttpError(409, "configuration_required", "Configure a provider and model before sending a message.");
      if (this.pending(request.conversationId) >= 8)
        throw new HttpError(429, "capacity_exceeded", "This conversation already has eight pending requests.", true);
      this.repository.appendMessageSync(request.conversationId, {
        id: request.requestId,
        type: "outgoing",
        text: request.text,
        status: "queued",
        createdAt: new Date().toISOString(),
      });
      const revision = this.repository.revision(request.conversationId);
      this.database.sql
        .prepare(
          "INSERT INTO requests(conversation_id,id,payload_hash,payload,status,revision,updated_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          request.conversationId,
          request.requestId,
          payloadHash,
          payload,
          "queued",
          revision,
          new Date().toISOString(),
        );
      const accepted = { requestId: request.requestId, status: "queued" as const, revision };
      this.database.appendEvent("request_changed", accepted, {
        conversationId: request.conversationId,
        requestId: request.requestId,
        revision,
      });
      return accepted;
    });
    queueMicrotask(() => this.pump());
    return result;
  }

  request(conversationId: string, requestId: string): RequestAdmission {
    const row = this.database.sql
      .prepare("SELECT status,revision,error_code FROM requests WHERE conversation_id=? AND id=?")
      .get(conversationId, requestId);
    if (!row) throw new HttpError(404, "not_found", "The request was not found.");
    return {
      requestId,
      status: row.status as RequestStatus,
      revision: Number(row.revision),
      ...(row.error_code ? { errorCode: row.error_code as string } : {}),
    };
  }
  pending(id?: string): number {
    return Number(
      (id
        ? this.database.sql
            .prepare(
              "SELECT COUNT(*) AS count FROM requests WHERE conversation_id=? AND status IN ('queued','running')",
            )
            .get(id)
        : this.database.sql.prepare("SELECT COUNT(*) AS count FROM requests WHERE status IN ('queued','running')").get()
      )?.count ?? 0,
    );
  }
  assertIdle(id: string): void {
    if (this.pending(id) || this.active.has(id))
      throw new HttpError(409, "conflict", "Wait for this conversation to finish before changing it.");
  }
  async abort(id: string): Promise<void> {
    this.repository.getAgentContext(id);
    this.database.transaction(() => {
      for (const row of this.database.sql
        .prepare("SELECT id FROM requests WHERE conversation_id=? AND status='queued'")
        .all(id))
        this.terminal(id, row.id as string, "cancelled");
    });
    const current = this.activeRequests.get(id);
    if (current) this.cancellations.add(this.key(id, current));
    await this.registry.abort(id);
  }
  setMaintenance(value: boolean): void {
    this.maintenance = value;
    if (!value) this.pump();
  }
  async quiesce(timeoutMs = 30_000): Promise<void> {
    this.maintenance = true;
    if (this.active.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(this.active.values()),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new HttpError(409, "conflict", "Running agents did not become idle before the maintenance deadline."),
                ),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    this.flushAll();
  }
  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.stopped = true;
    try {
      await this.quiesce(timeoutMs);
    } catch {
      await Promise.allSettled([...this.active.keys()].map((id) => this.abort(id)));
      await Promise.allSettled(this.active.values());
    }
    this.flushAll();
  }
  handleEvent(event: SequencedConversationAgentEvent): void {
    if (event.type === "conversation_error")
      event = {
        ...event,
        error: {
          ...event.error,
          message:
            event.error.code === "configuration_required"
              ? "Configure a provider and model before sending a message."
              : "The model request failed. Check the provider configuration and try again.",
        },
      };
    if (event.type === "assistant_text_delta") {
      const key = this.key(event.conversationId, event.messageId);
      let checkpoint = this.checkpoints.get(key);
      if (!checkpoint) {
        const existing = this.repository
          .messages(event.conversationId)
          .messages.find((message) => message.id === event.messageId);
        checkpoint = {
          event,
          text: existing && "text" in existing ? existing.text : "",
          delta: "",
          timer: setTimeout(() => this.flush(key), 250),
        };
        this.checkpoints.set(key, checkpoint);
      }
      checkpoint.event = event;
      checkpoint.text += event.delta;
      checkpoint.delta += event.delta;
      if (Buffer.byteLength(checkpoint.delta) >= 8192) this.flush(key);
      return;
    }
    this.database.transaction(() => {
      if ("messageId" in event) this.flush(this.key(event.conversationId, event.messageId));
      if (event.type === "assistant_message_started") {
        const outgoing = this.repository
          .messages(event.conversationId)
          .messages.find((message) => message.id === event.requestId);
        if (outgoing?.type === "outgoing")
          this.repository.appendMessageSync(event.conversationId, { ...outgoing, status: "complete" });
        this.repository.appendMessageSync(event.conversationId, {
          id: event.messageId,
          type: "incoming",
          text: "",
          status: "streaming",
          createdAt: event.createdAt,
        });
      }
      if (event.type === "assistant_message_completed" || event.type === "assistant_message_cancelled") {
        const message = this.repository
          .messages(event.conversationId)
          .messages.find((item) => item.id === event.messageId);
        const cancelled = event.type === "assistant_message_cancelled";
        this.repository.appendMessageSync(event.conversationId, {
          id: event.messageId,
          type: "incoming",
          text: message && "text" in message ? message.text : cancelled ? "Stopped." : "",
          status: cancelled ? "cancelled" : "complete",
          ...(message?.createdAt ? { createdAt: message.createdAt } : {}),
        });
        if (cancelled) this.cancellations.add(this.key(event.conversationId, event.requestId));
        this.terminal(event.conversationId, event.requestId, cancelled ? "cancelled" : "completed");
      }
      if (event.type === "conversation_error" && event.requestId) {
        const messageId = `${event.requestId}:assistant`;
        this.flush(this.key(event.conversationId, messageId));
        const current = this.repository.messages(event.conversationId).messages.find((item) => item.id === messageId);
        const cancelled = this.cancellations.has(this.key(event.conversationId, event.requestId));
        this.repository.appendMessageSync(event.conversationId, {
          id: messageId,
          type: "incoming",
          text: current && "text" in current && current.text ? current.text : event.error.message,
          status: cancelled ? "cancelled" : "failed",
          retryable: event.error.retryable,
          createdAt: current?.createdAt ?? event.createdAt,
        });
        this.terminal(event.conversationId, event.requestId, cancelled ? "cancelled" : "failed", event.error.code);
      }
      if (event.type === "conversation_context_renewed")
        this.repository.appendMessageSync(event.conversationId, {
          id: `context:${event.createdAt}`,
          type: "time",
          text: event.kind === "compacted" ? "Context summarized · History preserved" : "New topic · History preserved",
          createdAt: event.createdAt,
        });
      if (event.type === "tool_approval_requested")
        this.database.sql
          .prepare("INSERT OR IGNORE INTO approvals(id,request,state) VALUES (?,?,'pending')")
          .run(event.request.approvalId, JSON.stringify(event.request));
      if (event.type === "tool_approval_resolved")
        this.database.sql
          .prepare("UPDATE approvals SET state=?,decided_at=? WHERE id=? AND state='pending'")
          .run(event.decision, new Date().toISOString(), event.approvalId);
      this.database.appendEvent("agent", event, {
        conversationId: event.conversationId,
        ...("requestId" in event && event.requestId ? { requestId: event.requestId } : {}),
      });
    });
  }
  private pump(): void {
    if (this.stopped || this.maintenance) return;
    for (const row of this.database.sql
      .prepare("SELECT conversation_id,id,payload FROM requests WHERE status='queued' ORDER BY ordinal")
      .all()) {
      if (this.active.size >= 4) break;
      const id = row.conversation_id as string;
      if (this.active.has(id)) continue;
      const request = JSON.parse(row.payload as string) as SendMessageRequest;
      this.database.transaction(() => {
        this.database.sql
          .prepare(
            "UPDATE requests SET status='running',updated_at=? WHERE conversation_id=? AND id=? AND status='queued'",
          )
          .run(new Date().toISOString(), id, request.requestId);
        this.database.appendEvent("request_changed", this.request(id, request.requestId), {
          conversationId: id,
          requestId: request.requestId,
        });
      });
      this.activeRequests.set(id, request.requestId);
      const operation = Promise.resolve()
        .then(() => this.registry.send(request))
        .then(
          () => {
            this.database.transaction(() =>
              this.terminal(
                id,
                request.requestId,
                this.cancellations.has(this.key(id, request.requestId)) ? "cancelled" : "completed",
              ),
            );
          },
          (error) => {
            const safe = sanitizeBackendError(error);
            this.database.transaction(() => {
              this.terminal(
                id,
                request.requestId,
                this.cancellations.has(this.key(id, request.requestId)) ? "cancelled" : "failed",
                safe.code,
              );
              this.registry.publishExternalEvent({
                type: "conversation_error",
                conversationId: id,
                requestId: request.requestId,
                createdAt: new Date().toISOString(),
                error: safe,
              });
            });
          },
        )
        .finally(() => {
          this.cancellations.delete(this.key(id, request.requestId));
          this.active.delete(id);
          this.activeRequests.delete(id);
          this.pump();
        });
      this.active.set(id, operation);
    }
  }
  private terminal(id: string, requestId: string, status: RequestStatus, errorCode?: string): void {
    const current = this.database.sql
      .prepare("SELECT status FROM requests WHERE conversation_id=? AND id=?")
      .get(id, requestId);
    if (!current || !["queued", "running"].includes(current.status as string)) return;
    const outgoing = this.repository.messages(id).messages.find((message) => message.id === requestId);
    if (outgoing?.type === "outgoing")
      this.repository.appendMessageSync(id, {
        ...outgoing,
        status: status === "completed" ? "complete" : status === "cancelled" ? "cancelled" : "failed",
      });
    const revision = this.repository.touch(id);
    this.database.sql
      .prepare("UPDATE requests SET status=?,revision=?,updated_at=?,error_code=? WHERE conversation_id=? AND id=?")
      .run(status, revision, new Date().toISOString(), errorCode ?? null, id, requestId);
    this.database.appendEvent(
      "request_changed",
      { requestId, status, revision, ...(errorCode ? { errorCode } : {}) },
      { conversationId: id, requestId, revision },
    );
  }
  private key(conversationId: string, id: string): string {
    return `${conversationId}\0${id}`;
  }
  private flush(key: string): void {
    const checkpoint = this.checkpoints.get(key);
    if (!checkpoint) return;
    const messageId = checkpoint.event.messageId;
    clearTimeout(checkpoint.timer);
    this.checkpoints.delete(key);
    this.database.transaction(() => {
      const existing = this.repository
        .messages(checkpoint.event.conversationId)
        .messages.find((message) => message.id === messageId);
      this.repository.appendMessageSync(checkpoint.event.conversationId, {
        id: messageId,
        type: "incoming",
        text: checkpoint.text,
        status: "streaming",
        ...(existing?.createdAt ? { createdAt: existing.createdAt } : {}),
      });
      this.database.appendEvent(
        "agent",
        { ...checkpoint.event, delta: checkpoint.delta },
        { conversationId: checkpoint.event.conversationId, requestId: checkpoint.event.requestId },
      );
    });
  }
  private flushAll(): void {
    for (const id of this.checkpoints.keys()) this.flush(id);
  }
}
