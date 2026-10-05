import { EMPTY_USER_PROFILE, normalizeUserProfile, type UserProfile } from "../shared/user-profile.js";
import { writeFileAtomically } from "./atomic-file.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";

import type { ModelSelection } from "../shared/contracts.js";
import { normalizeSelection } from "./ai-settings-store.js";
import type {
  Chat,
  ChatChanges,
  ChatCollection,
  Message,
  MessagePage,
  MessagePageRequest,
  MessageSearchHit,
  MessageStatus,
} from "../shared/conversations.js";
import { WispBackendError } from "./backend-error.js";
import { normalizeUserName, type ConversationAgentContext } from "./conversation-agent.js";
import {
  normalizeChat,
  normalizeChatCollection,
  normalizeConversationId,
  normalizeMessage,
  validateConversationGraph,
} from "./conversation-normalizer.js";
import { ConversationStore, type StoredPageRequest } from "./conversation-store.js";
import { buildSnippet, MessageSearchWorker } from "./message-search.js";
import { CONVERSATION_STORAGE_POLICY } from "./storage-policy.js";
import {
  applyWorkspaceAction,
  withLastActivity,
  type ConversationRecord,
  type WorkspaceActionStatus,
} from "./workspace-actions.js";

// Version of the conversation record format. The legacy JSON store also wrote
// versions 1–3, which are upgraded when that store is migrated to SQLite.
const SCHEMA_VERSION = 4;
const REMOVED_DEMO_CONVERSATION_IDS = new Set(["chief", "sales", "inbox", "account", "talent", "expense", "offsite"]);

export type { ConversationRecord } from "./workspace-actions.js";

interface PersistedConversationState {
  schemaVersion: typeof SCHEMA_VERSION;
  initialized: boolean;
  conversations: Record<string, ConversationRecord>;
}

function emptyState(): PersistedConversationState {
  return { schemaVersion: SCHEMA_VERSION, initialized: false, conversations: {} };
}

function chatsOf(records: Readonly<Record<string, ConversationRecord>>): ChatCollection {
  return Object.fromEntries(Object.values(records).map(({ chat }) => [chat.id, chat]));
}

/** Rewrites the metadata row of every record that an action replaced. */
function putChangedConversations(
  store: ConversationStore,
  previous: Readonly<Record<string, ConversationRecord>>,
  next: Readonly<Record<string, ConversationRecord>>,
): void {
  for (const [id, record] of Object.entries(next)) {
    if (previous[id] !== record) store.putConversation(record);
  }
}

/** A message as stored by a write, and whether the write added it or updated an existing one. */
export interface MessageChange {
  message: Message;
  added: boolean;
}

export interface ConversationRepositoryOptions {
  dataDirectory: string;
  userName?: string;
  now?: () => Date;
  createId?: () => string;
}

/**
 * Conversations and their transcripts. The in-memory state is the read model;
 * SQLite is the durable store. Each mutation builds its next state, writes only
 * the rows it changed in one transaction, and adopts the next state only after
 * the commit succeeds, so a failed write never leaves memory and disk apart.
 */
export class ConversationRepository {
  private readonly dataDirectory: string;
  private readonly databasePath: string;
  private readonly legacyStatePath: string;
  private readonly workspaceRoot: string;
  private readonly sessionRoot: string;
  private readonly configRoot: string;
  private readonly deletedRoot: string;
  private profile: UserProfile = { ...EMPTY_USER_PROFILE };
  private readonly now: () => Date;
  private readonly createId: () => string;
  private state: PersistedConversationState = emptyState();
  private store: ConversationStore | undefined;
  private searchWorker: MessageSearchWorker | undefined;
  private recoveredCorruptState = false;
  private mutation = Promise.resolve();

  constructor(options: ConversationRepositoryOptions) {
    this.dataDirectory = options.dataDirectory;
    this.databasePath = path.join(options.dataDirectory, "conversations.sqlite");
    this.legacyStatePath = path.join(options.dataDirectory, "conversations.json");
    this.workspaceRoot = path.join(options.dataDirectory, "workspaces");
    this.sessionRoot = path.join(options.dataDirectory, "pi-sessions");
    this.configRoot = path.join(options.dataDirectory, "pi-config");
    this.deletedRoot = path.join(options.dataDirectory, "deleted-conversations");
    this.profile.preferredName = normalizeUserName(options.userName) ?? "";
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async load(): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      this.profile = normalizeUserProfile(
        JSON.parse(await readFile(path.join(this.dataDirectory, "user-profile.json"), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code) throw error;
        await rename(
          path.join(this.dataDirectory, "user-profile.json"),
          path.join(this.dataDirectory, `user-profile.json.corrupt-${Date.now()}`),
        );
        this.profile = { ...EMPTY_USER_PROFILE };
      }
    }
    let store: ConversationStore;
    let stored: PersistedConversationState | undefined;
    try {
      store = await this.openStore();
      if (store.isEstablished()) stored = this.parsePersistedState({ schemaVersion: SCHEMA_VERSION, ...store.read() });
    } catch {
      // Unreadable, invalid, or written by a newer app version: keep the file
      // for inspection and start with an empty store.
      await this.preserveCorruptDatabase();
      this.recoveredCorruptState = true;
      return;
    }
    if (stored) {
      this.state = stored;
      await this.ensureAllDirectories();
      return;
    }
    await this.migrateLegacyState(store);
  }

  getUserProfile(): UserProfile {
    return { ...this.profile };
  }

  async saveUserProfile(value: unknown): Promise<UserProfile> {
    let profile: UserProfile;
    try {
      profile = normalizeUserProfile(value);
    } catch {
      throw new WispBackendError("invalid_request", "The user profile is invalid.");
    }
    return this.enqueue(async () => {
      await writeFileAtomically(path.join(this.dataDirectory, "user-profile.json"), JSON.stringify(profile));
      this.profile = profile;
      return this.getUserProfile();
    });
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

  /** Uncloned stored chat; see `readChats`. */
  readChat(conversationId: string): Readonly<Chat> | undefined {
    return this.state.conversations[conversationId]?.chat;
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
              ...(chat.kind === "wisp" && chat.tone ? { tone: chat.tone } : {}),
              userName: this.profile.preferredName || undefined,
              userProfile: this.getUserProfile(),
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
      ...(record.chat.kind === "wisp" && record.chat.tone ? { tone: record.chat.tone } : {}),
      userName: this.profile.preferredName || undefined,
      userProfile: this.getUserProfile(),
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
      const next: PersistedConversationState = {
        schemaVersion: SCHEMA_VERSION,
        initialized: true,
        conversations: Object.fromEntries(
          Object.values(normalized).map((chat) => [
            chat.id,
            {
              chat: withLastActivity(chat),
              sessionId: chat.kind === "circle" ? null : normalizeConversationId(this.createId()),
              modelOverride: null,
              piSessionId: null,
              piSessionFile: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ]),
        ),
      };
      validateConversationGraph(chatsOf(next.conversations));
      await this.ensureAllDirectories(next.conversations);
      await this.commit(next, (store) => store.replaceAll(next));
    });
  }

  async create(chatValue: unknown, modelOverride?: ModelSelection | null): Promise<void> {
    await this.enqueue(async () => {
      const chat = withLastActivity(normalizeChat(chatValue));
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
        // Always present so a new record has the same shape as one read back from disk.
        modelOverride: normalizedOverride,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const result = applyWorkspaceAction(this.state.conversations, { type: "create", record });
      this.throwForActionStatus(result.status);
      validateConversationGraph(chatsOf(result.records));
      await this.ensureDirectories(record);
      await this.commit({ ...this.state, conversations: result.records, initialized: true }, (store) => {
        store.putConversation(record);
        store.putMessages(chat.id, record.chat.messages);
        store.setInitialized(true);
      });
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
      validateConversationGraph(chatsOf(result.records));
      const previous = this.state.conversations;
      await this.commit({ ...this.state, conversations: result.records }, (store) =>
        putChangedConversations(store, previous, result.records),
      );
    });
  }

  async appendMessage(conversationId: string, message: Message): Promise<MessageChange> {
    return this.enqueue(() => this.applyAppend(conversationId, message));
  }

  /**
   * Saves a message the user wrote. It may replace the user's own earlier
   * version of it, never a reply or notice; the check runs in the write queue
   * so nothing can change the stored message in between.
   */
  async appendOutgoingMessage(conversationId: string, message: Message): Promise<MessageChange> {
    return this.enqueue(async () => {
      const existing = message.id ? await this.lookupMessage(conversationId, message.id) : undefined;
      if (message.type !== "outgoing" || (existing && existing.type !== "outgoing")) {
        throw new WispBackendError("invalid_request", "Only messages you wrote can be saved from the app.");
      }
      return this.applyAppend(conversationId, message);
    });
  }

  /** Updates an outgoing message's delivery status and resolves the stored message, or undefined when there is none. */
  async setOutgoingStatus(
    conversationId: string,
    messageId: string,
    status: MessageStatus,
  ): Promise<Message | undefined> {
    return this.enqueue(async () => {
      const stored = await this.lookupMessage(conversationId, messageId);
      if (stored?.type !== "outgoing") return undefined;
      return (await this.applyAppend(conversationId, { ...stored, id: messageId, status })).message;
    });
  }

  /** A stored message by ID, read from the database. */
  getMessage(conversationId: string, messageId: string): Promise<Message | undefined> {
    this.require(conversationId);
    return this.lookupMessage(conversationId, messageId);
  }

  /** One page of a conversation's transcript, read from the database. */
  async getMessagePage(request: MessagePageRequest): Promise<MessagePage> {
    this.require(request.conversationId);
    const store = await this.openStore();
    const page = store.readPage(request.conversationId, storedPageRequest(request));
    if (request.page === "around" && page.messages.length === 0) {
      throw new WispBackendError("not_found", "The message was not found.");
    }
    return {
      messages: page.messages.map((message) => normalizeMessage(message)),
      olderCursor: page.olderCursor === null ? null : String(page.olderCursor),
      newerCursor: page.newerCursor === null ? null : String(page.newerCursor),
    };
  }

  /** Newest matching messages first; `query` is matched as literal text. */
  async searchMessages(query: string): Promise<ReadonlyArray<MessageSearchHit>> {
    await this.openStore();
    this.searchWorker ??= new MessageSearchWorker(this.databasePath);
    const hits = await this.searchWorker.search(query);
    return hits.flatMap(({ conversationId, messageId, body }) => {
      if (!this.state.conversations[conversationId]) return [];
      let message: Message;
      try {
        message = normalizeMessage(JSON.parse(body));
      } catch {
        return [];
      }
      return [
        {
          conversationId,
          messageId,
          snippet: buildSnippet(message, query),
          ...(message.createdAt ? { createdAt: message.createdAt } : {}),
        },
      ];
    });
  }

  /** Records the answer and resolves the stored prompt. */
  async answerPrompt(conversationId: string, messageId: string, answer: string): Promise<Message> {
    return this.enqueue(async () => {
      const result = applyWorkspaceAction(this.state.conversations, {
        type: "answer-prompt",
        conversationId,
        messageId,
        answer,
        updatedAt: this.now().toISOString(),
      });
      this.throwForActionStatus(result.status);
      const record = result.records[conversationId]!;
      const prompt = record.chat.messages.find(({ id }) => id === messageId)!;
      await this.commit({ ...this.state, conversations: result.records }, (store) => {
        store.putConversation(record);
        store.putMessages(conversationId, [prompt]);
      });
      return prompt;
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
      const record = result.records[conversationId]!;
      await this.commit({ ...this.state, conversations: result.records }, (store) => store.putConversation(record));
    });
  }

  async setModelOverride(conversationId: string, model: ModelSelection | null): Promise<void> {
    await this.enqueue(async () => {
      const record = this.require(conversationId);
      if (!record.sessionId) throw new WispBackendError("invalid_request", "Circles do not own agent sessions.");
      const normalized = normalizeSelection(model);
      if (model !== null && !normalized)
        throw new WispBackendError("invalid_request", "The model selection is invalid.");
      await this.commitRecord({ ...record, modelOverride: normalized, updatedAt: this.now().toISOString() });
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
      await this.commitRecord({ ...record, piSessionId, piSessionFile, updatedAt: this.now().toISOString() });
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
      const previous = this.state.conversations;
      await this.commit({ ...this.state, conversations: result.records }, (store) => {
        store.deleteConversation(conversationId);
        // Circles that listed the deleted Wisp lose it as a member.
        putChangedConversations(store, previous, result.records);
      });
      if (record.sessionId) await this.archiveDirectories(record.sessionId).catch(() => undefined);
      return structuredClone(record);
    });
  }

  /** Waits for pending writes, then closes the database. A later write reopens it. */
  async close(): Promise<void> {
    await this.mutation;
    await this.searchWorker?.dispose();
    this.searchWorker = undefined;
    this.store?.close();
    this.store = undefined;
  }

  private async applyAppend(conversationId: string, message: Message): Promise<MessageChange> {
    const messageId = message.id ?? this.createId();
    const added = (await this.openStore()).getMessage(conversationId, messageId) === undefined;
    const result = applyWorkspaceAction(this.state.conversations, {
      type: "append-message",
      conversationId,
      message: { ...message, id: messageId },
      updatedAt: this.now().toISOString(),
    });
    this.throwForActionStatus(result.status);
    const record = result.records[conversationId]!;
    const stored = record.chat.messages.find(({ id }) => id === messageId)!;
    await this.commit({ ...this.state, conversations: result.records }, (store) => {
      store.putConversation(record);
      store.deleteOldestMessages(conversationId, result.droppedOldestMessages ?? 0);
      store.putMessages(conversationId, [stored]);
    });
    return { message: stored, added };
  }

  private async lookupMessage(conversationId: string, messageId: string): Promise<Message | undefined> {
    const body = (await this.openStore()).getMessage(conversationId, messageId);
    return body === undefined ? undefined : normalizeMessage(body);
  }

  private commitRecord(record: ConversationRecord): Promise<void> {
    return this.commit(
      { ...this.state, conversations: { ...this.state.conversations, [record.chat.id]: record } },
      (store) => store.putConversation(record),
    );
  }

  private async commit(next: PersistedConversationState, write: (store: ConversationStore) => void): Promise<void> {
    const store = await this.openStore();
    store.transaction(() => write(store));
    this.state = next;
  }

  private async openStore(): Promise<ConversationStore> {
    if (!this.store) {
      await mkdir(this.dataDirectory, { recursive: true });
      this.store = ConversationStore.open(this.databasePath);
    }
    return this.store;
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

  /** Serializes mutations; each adopts its next state only in `commit`, after the write succeeds. */
  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * First run on SQLite: imports the legacy single-file JSON store, upgrading
   * older record versions. The JSON file is kept as the migration backup; once
   * the import commits, SQLite is authoritative.
   */
  private async migrateLegacyState(store: ConversationStore): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.legacyStatePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let parsed: unknown;
    try {
      if (Buffer.byteLength(contents, "utf8") > CONVERSATION_STORAGE_POLICY.maxLegacyStateBytes) {
        throw new Error("Conversation state exceeds the local storage limit.");
      }
      parsed = JSON.parse(contents);
      this.state = this.parsePersistedState(parsed);
    } catch {
      await rename(this.legacyStatePath, `${this.legacyStatePath}.corrupt-${this.fileSuffix()}`);
      this.recoveredCorruptState = true;
      this.state = emptyState();
      return;
    }
    const persistedSchemaVersion = this.schemaVersionOf(parsed);
    if (persistedSchemaVersion === 1 || persistedSchemaVersion === 2) await this.removeBundledDemoConversations();
    this.state = {
      ...this.state,
      conversations: Object.fromEntries(
        Object.entries(this.state.conversations).map(([id, record]) => [
          id,
          { ...record, chat: withLastActivity(record.chat) },
        ]),
      ),
    };
    await this.ensureAllDirectories();
    const state = this.state;
    store.transaction(() => store.replaceAll(state));
    await rename(this.legacyStatePath, `${this.legacyStatePath}.migrated-${this.fileSuffix()}`);
  }

  private async preserveCorruptDatabase(): Promise<void> {
    this.store?.close();
    this.store = undefined;
    this.state = emptyState();
    const preserved = `${this.databasePath}.corrupt-${this.fileSuffix()}`;
    // SQLite finds a database's write-ahead log by name, so the companions move with it.
    await rename(this.databasePath, preserved);
    for (const suffix of ["-wal", "-shm"]) {
      await rename(`${this.databasePath}${suffix}`, `${preserved}${suffix}`).catch(() => undefined);
    }
  }

  private fileSuffix(): string {
    return this.now().toISOString().replaceAll(":", "-");
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
            ? this.relocatedPiSessionFile(sessionId, record.piSessionFile)
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

  /**
   * Reads a stored session path. The data directory may have moved since it
   * was saved (a restored backup, another machine), so a path under another
   * root is re-anchored in this conversation's session directory by file name.
   */
  private relocatedPiSessionFile(sessionId: string, filePath: string): string {
    const sessionDirectory = path.resolve(this.sessionRoot, sessionId);
    const name = path.basename(filePath);
    if (path.relative(sessionDirectory, path.resolve(filePath)).startsWith("..") && name && name !== "..") {
      return this.normalizePiSessionFile(sessionId, path.join(sessionDirectory, name));
    }
    return this.normalizePiSessionFile(sessionId, filePath);
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

  private async ensureAllDirectories(
    records: Readonly<Record<string, ConversationRecord>> = this.state.conversations,
  ): Promise<void> {
    await Promise.all(Object.values(records).map((record) => this.ensureDirectories(record)));
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
    const archive = path.join(this.deletedRoot, `${sessionId}-${this.fileSuffix()}`);
    await mkdir(archive, { recursive: true });
    await Promise.all([
      rename(path.join(this.workspaceRoot, sessionId), path.join(archive, "workspace")).catch(() => undefined),
      rename(path.join(this.sessionRoot, sessionId), path.join(archive, "pi-session")).catch(() => undefined),
      rename(path.join(this.configRoot, sessionId), path.join(archive, "pi-config")).catch(() => undefined),
    ]);
  }
}

function storedPageRequest(request: MessagePageRequest): StoredPageRequest {
  switch (request.page) {
    case "latest":
      return { page: "latest" };
    case "older":
      return { page: "older", before: Number(request.cursor) };
    case "newer":
      return { page: "newer", after: Number(request.cursor) };
    case "around":
      return { page: "around", messageId: request.messageId };
  }
}
