import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";

import type { ModelSelection } from "../../shared/contracts.js";
import { normalizeSelection } from "./ai-settings-store.js";
import type { Chat, ChatChanges, ChatCollection, Message } from "../../shared/conversations.js";
import { writeFileAtomically } from "./atomic-file.js";
import { WispBackendError } from "./backend-error.js";
import { normalizeUserName, type ConversationAgentContext } from "./conversation-agent.js";
import {
  normalizeChat,
  normalizeChatCollection,
  normalizeConversationId,
  validateConversationGraph,
} from "./conversation-normalizer.js";
import { CONVERSATION_STORAGE_POLICY } from "./storage-policy.js";
import { applyWorkspaceAction, type ConversationRecord, type WorkspaceActionStatus } from "./workspace-actions.js";

const SCHEMA_VERSION = 4;
const REMOVED_DEMO_CONVERSATION_IDS = new Set(["chief", "sales", "inbox", "account", "talent", "expense", "offsite"]);

export type { ConversationRecord } from "./workspace-actions.js";

interface PersistedConversationState {
  schemaVersion: typeof SCHEMA_VERSION;
  initialized: boolean;
  conversations: Record<string, ConversationRecord>;
}

export interface ConversationRepositoryOptions {
  dataDirectory: string;
  userName?: string;
  now?: () => Date;
  createId?: () => string;
}

export class ConversationRepository {
  private readonly statePath: string;
  private readonly workspaceRoot: string;
  private readonly sessionRoot: string;
  private readonly configRoot: string;
  private readonly deletedRoot: string;
  private readonly userName: string | undefined;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private state: PersistedConversationState = {
    schemaVersion: SCHEMA_VERSION,
    initialized: false,
    conversations: {},
  };
  private recoveredCorruptState = false;
  private mutation = Promise.resolve();

  constructor(options: ConversationRepositoryOptions) {
    this.statePath = path.join(options.dataDirectory, "conversations.json");
    this.workspaceRoot = path.join(options.dataDirectory, "workspaces");
    this.sessionRoot = path.join(options.dataDirectory, "pi-sessions");
    this.configRoot = path.join(options.dataDirectory, "pi-config");
    this.deletedRoot = path.join(options.dataDirectory, "deleted-conversations");
    this.userName = normalizeUserName(options.userName);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async load(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    let parsed: unknown;
    try {
      if (Buffer.byteLength(contents, "utf8") > CONVERSATION_STORAGE_POLICY.maxBlobBytes) {
        throw new Error("Conversation state exceeds the local storage limit.");
      }
      parsed = JSON.parse(contents);
      this.state = this.parsePersistedState(parsed);
    } catch (error) {
      await this.preserveCorruptState();
      this.recoveredCorruptState = true;
      this.state = { schemaVersion: SCHEMA_VERSION, initialized: false, conversations: {} };
      await this.ensureAllDirectories();
      return;
    }

    const persistedSchemaVersion = this.schemaVersionOf(parsed);
    const needsSchemaUpgrade = persistedSchemaVersion !== SCHEMA_VERSION;
    if (persistedSchemaVersion === 1 || persistedSchemaVersion === 2) await this.removeBundledDemoConversations();
    await this.ensureAllDirectories();
    if (needsSchemaUpgrade) {
      await this.preserveMigrationSource(persistedSchemaVersion);
      await this.persist();
    }
  }

  isInitialized(): boolean {
    return this.state.initialized;
  }

  didRecoverCorruptState(): boolean {
    return this.recoveredCorruptState;
  }

  list(): ReadonlyArray<ConversationRecord> {
    return Object.values(this.state.conversations).map((record) => structuredClone(record));
  }

  getChats(): ChatCollection {
    return Object.fromEntries(this.list().map(({ chat }) => [chat.id, chat]));
  }

  getChat(conversationId: string): Chat | undefined {
    const record = this.state.conversations[conversationId];
    return record ? structuredClone(record.chat) : undefined;
  }

  /**
   * Uncloned view of the stored chats. Records are replaced, never mutated, so
   * the objects stay valid snapshots; callers must treat them as read-only.
   * Use this on hot paths that copy anyway (IPC serialization, validation).
   */
  readChats(): Readonly<ChatCollection> {
    return Object.fromEntries(Object.values(this.state.conversations).map(({ chat }) => [chat.id, chat]));
  }

  listAgentContexts(): ReadonlyArray<ConversationAgentContext> {
    return this.list().flatMap(({ chat, sessionId }) =>
      sessionId
        ? [
            {
              conversationId: chat.id,
              sessionId,
              modelOverride: this.state.conversations[chat.id]?.modelOverride ?? null,
              name: chat.name,
              label: chat.label,
              description: chat.description,
              ...(this.userName ? { userName: this.userName } : {}),
              workspaceDirectory: path.join(this.workspaceRoot, sessionId),
              sessionDirectory: path.join(this.sessionRoot, sessionId),
              configDirectory: path.join(this.configRoot, sessionId),
              piSessionId: this.state.conversations[chat.id]?.piSessionId ?? null,
              piSessionFile: this.state.conversations[chat.id]?.piSessionFile ?? null,
              savePiSessionIdentity: (identity) => this.savePiSessionIdentity(chat.id, identity),
            },
          ]
        : [],
    );
  }

  getAgentContext(conversationId: string): ConversationAgentContext {
    const record = this.require(conversationId);
    if (!record.sessionId) throw new WispBackendError("invalid_request", "Circles do not own agent sessions.");
    return {
      conversationId,
      sessionId: record.sessionId,
      modelOverride: record.modelOverride ?? null,
      name: record.chat.name,
      label: record.chat.label,
      description: record.chat.description,
      ...(this.userName ? { userName: this.userName } : {}),
      workspaceDirectory: path.join(this.workspaceRoot, record.sessionId),
      sessionDirectory: path.join(this.sessionRoot, record.sessionId),
      configDirectory: path.join(this.configRoot, record.sessionId),
      piSessionId: record.piSessionId,
      piSessionFile: record.piSessionFile,
      savePiSessionIdentity: (identity) => this.savePiSessionIdentity(conversationId, identity),
    };
  }

  getPiSessionContext(conversationId: string): {
    sessionId: string;
    piSessionId: string | null;
    piSessionFile: string | null;
    workspaceDirectory: string;
  } | null {
    const record = this.require(conversationId);
    if (!record.sessionId) return null;
    return {
      sessionId: record.sessionId,
      piSessionId: record.piSessionId,
      piSessionFile: record.piSessionFile,
      workspaceDirectory: path.join(this.workspaceRoot, record.sessionId),
    };
  }

  async initialize(chats: unknown): Promise<void> {
    await this.enqueue(async () => {
      if (this.state.initialized) return;
      const normalized = normalizeChatCollection(chats);
      const timestamp = this.now().toISOString();
      this.state = {
        schemaVersion: SCHEMA_VERSION,
        initialized: true,
        conversations: Object.fromEntries(
          Object.values(normalized).map((chat) => [
            chat.id,
            {
              chat,
              sessionId: chat.kind === "circle" ? null : normalizeConversationId(this.createId()),
              piSessionId: null,
              piSessionFile: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ]),
        ),
      };
      validateConversationGraph(this.readChats());
      await this.ensureAllDirectories();
      await this.persist();
    });
  }

  async create(chatValue: unknown, modelOverride?: ModelSelection | null): Promise<void> {
    await this.enqueue(async () => {
      const chat = normalizeChat(chatValue);
      const normalizedOverride = normalizeSelection(modelOverride);
      if (chat.kind === "circle" && modelOverride) {
        throw new WispBackendError("invalid_request", "Circles do not own agent sessions.");
      }
      if (modelOverride && !normalizedOverride) {
        throw new WispBackendError("invalid_request", "The model selection is invalid.");
      }
      const timestamp = this.now().toISOString();
      const record: ConversationRecord = {
        chat,
        sessionId: chat.kind === "circle" ? null : normalizeConversationId(this.createId()),
        piSessionId: null,
        piSessionFile: null,
        ...(normalizedOverride ? { modelOverride: normalizedOverride } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const result = applyWorkspaceAction(this.state.conversations, { type: "create", record });
      this.throwForActionStatus(result.status);
      this.state = { ...this.state, conversations: result.records, initialized: true };
      validateConversationGraph(this.readChats());
      await this.ensureDirectories(record);
      await this.persist();
    });
  }

  async update(conversationId: string, changes: ChatChanges): Promise<void> {
    await this.enqueue(async () => {
      const updatedAt = this.now().toISOString();
      let result =
        changes.kind === "circle" && changes.memberIds !== undefined
          ? applyWorkspaceAction(this.state.conversations, {
              type: "replace-circle-members",
              conversationId,
              memberIds: changes.memberIds,
              updatedAt,
            })
          : applyWorkspaceAction(this.state.conversations, {
              type: "update",
              conversationId,
              changes,
              updatedAt,
            });
      this.throwForActionStatus(result.status);
      if (changes.kind === "circle" && changes.memberIds !== undefined) {
        const { memberIds: _memberIds, ...remainingChanges } = changes;
        if (Object.keys(remainingChanges).length > 1) {
          result = applyWorkspaceAction(result.records, {
            type: "update",
            conversationId,
            changes: remainingChanges,
            updatedAt,
          });
          this.throwForActionStatus(result.status);
        }
      }
      this.state = { ...this.state, conversations: result.records };
      validateConversationGraph(this.readChats());
      await this.persist();
    });
  }

  async appendMessage(conversationId: string, message: Message): Promise<void> {
    await this.enqueue(async () => {
      const messageId = message.id ?? this.createId();
      const result = applyWorkspaceAction(this.state.conversations, {
        type: "append-message",
        conversationId,
        message: { ...message, id: messageId },
        updatedAt: this.now().toISOString(),
      });
      this.throwForActionStatus(result.status);
      this.state = { ...this.state, conversations: result.records };
      await this.persist();
    });
  }

  async answerPrompt(conversationId: string, messageId: string, answer: string): Promise<void> {
    await this.enqueue(async () => {
      const result = applyWorkspaceAction(this.state.conversations, {
        type: "answer-prompt",
        conversationId,
        messageId,
        answer,
        updatedAt: this.now().toISOString(),
      });
      this.throwForActionStatus(result.status);
      this.state = { ...this.state, conversations: result.records };
      await this.persist();
    });
  }

  async markRead(conversationId: string): Promise<void> {
    await this.enqueue(async () => {
      const result = applyWorkspaceAction(this.state.conversations, {
        type: "mark-read",
        conversationId,
        updatedAt: this.now().toISOString(),
      });
      this.throwForActionStatus(result.status);
      if (result.status === "unchanged") return;
      this.state = { ...this.state, conversations: result.records };
      await this.persist();
    });
  }

  async setModelOverride(conversationId: string, model: ModelSelection | null): Promise<void> {
    await this.enqueue(async () => {
      const record = this.require(conversationId);
      if (!record.sessionId) throw new WispBackendError("invalid_request", "Circles do not own agent sessions.");
      const normalized = normalizeSelection(model);
      if (model !== null && !normalized)
        throw new WispBackendError("invalid_request", "The model selection is invalid.");
      this.replaceRecord({ ...record, modelOverride: normalized, updatedAt: this.now().toISOString() });
      await this.persist();
    });
  }

  async savePiSessionIdentity(
    conversationId: string,
    identity: { sessionId: string; sessionFile: string | null },
  ): Promise<void> {
    await this.enqueue(async () => {
      const record = this.require(conversationId);
      if (record.sessionId === null)
        throw new WispBackendError("invalid_request", "Circles do not own agent sessions.");
      const piSessionId = normalizeConversationId(identity.sessionId);
      const piSessionFile =
        identity.sessionFile === null ? null : this.normalizePiSessionFile(record.sessionId, identity.sessionFile);
      if (record.piSessionId === piSessionId && record.piSessionFile === piSessionFile) return;
      this.replaceRecord({ ...record, piSessionId, piSessionFile, updatedAt: this.now().toISOString() });
      await this.persist();
    });
  }

  async delete(conversationId: string): Promise<ConversationRecord> {
    return this.enqueue(async () => {
      const result = applyWorkspaceAction(this.state.conversations, {
        type: "delete",
        conversationId,
        updatedAt: this.now().toISOString(),
      });
      this.throwForActionStatus(result.status);
      const record = result.deletedRecord;
      if (!record) throw new WispBackendError("not_found", "The conversation was not found.");
      this.state = { ...this.state, conversations: result.records };
      await this.persist();
      if (record.sessionId) await this.archiveDirectories(record.sessionId).catch(() => undefined);
      return structuredClone(record);
    });
  }

  private replaceRecord(record: ConversationRecord): void {
    this.state = { ...this.state, conversations: { ...this.state.conversations, [record.chat.id]: record } };
  }

  private require(conversationId: string): ConversationRecord {
    const record = this.state.conversations[conversationId];
    if (!record) throw new WispBackendError("not_found", "The conversation was not found.");
    return record;
  }

  private throwForActionStatus(status: WorkspaceActionStatus): void {
    if (status === "applied" || status === "unchanged") return;
    if (status === "already_exists") {
      throw new WispBackendError("already_exists", "A conversation with this ID already exists.");
    }
    if (status === "kind_mismatch") {
      throw new WispBackendError("invalid_request", "The conversation kind cannot be changed.");
    }
    if (status === "invalid_member") {
      throw new WispBackendError("invalid_request", "Circle members must reference existing Wisps.");
    }
    if (status === "protected") {
      throw new WispBackendError("invalid_request", "This conversation is protected and cannot be deleted.");
    }
    if (status === "prompt_not_found") {
      throw new WispBackendError("not_found", "The prompt is no longer available.");
    }
    throw new WispBackendError("not_found", "The conversation was not found.");
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      // Mutations replace state and records instead of editing them in place,
      // so keeping the previous reference is enough to roll back a failed write
      // without deep-copying every conversation on each change.
      const previousState = this.state;
      try {
        return await operation();
      } catch (error) {
        this.state = previousState;
        throw error;
      }
    };
    const result = this.mutation.then(run, run);
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persist(): Promise<void> {
    const serialized = `${JSON.stringify(this.state)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > CONVERSATION_STORAGE_POLICY.maxBlobBytes) {
      throw new WispBackendError("invalid_request", "Conversation storage exceeds the local limit.");
    }
    await writeFileAtomically(this.statePath, serialized);
  }

  private parsePersistedState(value: unknown): PersistedConversationState {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid state");
    const raw = value as Record<string, unknown>;
    if (![1, 2, 3, SCHEMA_VERSION].includes(raw.schemaVersion as number) || typeof raw.initialized !== "boolean")
      throw new Error("Invalid state");
    if (!raw.conversations || typeof raw.conversations !== "object" || Array.isArray(raw.conversations))
      throw new Error("Invalid state");
    const conversations: Record<string, ConversationRecord> = {};
    for (const [id, value] of Object.entries(raw.conversations as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid state");
      const record = value as Record<string, unknown>;
      const chat = normalizeChat(record.chat);
      if (chat.id !== id || !this.isTimestamp(record.createdAt) || !this.isTimestamp(record.updatedAt))
        throw new Error("Invalid state");
      if (chat.kind === "circle" ? record.sessionId !== null : typeof record.sessionId !== "string")
        throw new Error("Invalid state");
      const sessionId = record.sessionId === null ? null : normalizeConversationId(record.sessionId);
      conversations[id] = {
        chat,
        sessionId,
        modelOverride: normalizeSelection(record.modelOverride),
        piSessionId: typeof record.piSessionId === "string" ? normalizeConversationId(record.piSessionId) : null,
        piSessionFile:
          typeof record.piSessionFile === "string" && sessionId
            ? this.normalizePiSessionFile(sessionId, record.piSessionFile)
            : null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    }
    const state = { schemaVersion: SCHEMA_VERSION, initialized: raw.initialized, conversations } as const;
    validateConversationGraph(
      Object.fromEntries(Object.entries(conversations).map(([id, record]) => [id, record.chat])),
    );
    return state;
  }

  private schemaVersionOf(value: unknown): number {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid state");
    const version = (value as Record<string, unknown>).schemaVersion;
    if (typeof version !== "number") throw new Error("Invalid state");
    return version;
  }

  private isTimestamp(value: unknown): value is string {
    return typeof value === "string" && value.length <= 100 && !Number.isNaN(Date.parse(value));
  }

  private async preserveMigrationSource(schemaVersion: number): Promise<void> {
    const suffix = this.now().toISOString().replaceAll(":", "-");
    await copyFile(this.statePath, `${this.statePath}.schema-v${schemaVersion}-backup-${suffix}`);
  }

  private async preserveCorruptState(): Promise<void> {
    const suffix = this.now().toISOString().replaceAll(":", "-");
    await rename(this.statePath, `${this.statePath}.corrupt-${suffix}`);
  }

  private normalizePiSessionFile(sessionId: string, filePath: string): string {
    const sessionDirectory = path.resolve(this.sessionRoot, sessionId);
    const resolved = path.resolve(filePath);
    const relative = path.relative(sessionDirectory, resolved);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new WispBackendError("invalid_request", "The Pi session path is invalid.");
    }
    return resolved;
  }

  private async ensureAllDirectories(): Promise<void> {
    await Promise.all(Object.values(this.state.conversations).map((record) => this.ensureDirectories(record)));
  }

  private async removeBundledDemoConversations(): Promise<void> {
    const removed = Object.entries(this.state.conversations).filter(([id]) => REMOVED_DEMO_CONVERSATION_IDS.has(id));
    this.state = {
      ...this.state,
      conversations: Object.fromEntries(
        Object.entries(this.state.conversations).filter(([id]) => !REMOVED_DEMO_CONVERSATION_IDS.has(id)),
      ),
    };
    await Promise.allSettled(
      removed.flatMap(([, record]) => (record.sessionId ? [this.archiveDirectories(record.sessionId)] : [])),
    );
  }

  private async ensureDirectories(record: ConversationRecord): Promise<void> {
    if (!record.sessionId) return;
    await Promise.all([
      mkdir(path.join(this.workspaceRoot, record.sessionId), { recursive: true }),
      mkdir(path.join(this.sessionRoot, record.sessionId), { recursive: true }),
      mkdir(path.join(this.configRoot, record.sessionId), { recursive: true }),
    ]);
  }

  private async archiveDirectories(sessionId: string): Promise<void> {
    const archive = path.join(this.deletedRoot, `${sessionId}-${this.now().toISOString().replaceAll(":", "-")}`);
    await mkdir(archive, { recursive: true });
    await Promise.all([
      rename(path.join(this.workspaceRoot, sessionId), path.join(archive, "workspace")).catch(() => undefined),
      rename(path.join(this.sessionRoot, sessionId), path.join(archive, "pi-session")).catch(() => undefined),
      rename(path.join(this.configRoot, sessionId), path.join(archive, "pi-config")).catch(() => undefined),
    ]);
  }
}
