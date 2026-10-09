import { isTimeZone, systemTimeZone } from "../shared/time-zone.js";
import { EMPTY_USER_PROFILE, normalizeUserProfile, type UserProfile } from "../shared/user-profile.js";
import { writeFileAtomically } from "./atomic-file.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
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
  OutgoingMessage,
  Wisp,
  WispChanges,
  WispCollection,
  WispId,
} from "../shared/conversations.js";
import type { QueuedMessage } from "../shared/message-queue.js";
import type { ScheduledMessage } from "../shared/scheduled-messages.js";
import { WispBackendError } from "./backend-error.js";
import { TRANSCRIPTION_CACHE_DIRECTORY } from "./transcription-cache.js";
import { normalizeUserName, type ConversationAgentContext } from "./conversation-agent.js";
import {
  asRecord,
  normalizeChat,
  normalizeConversationId,
  normalizeMessage,
  normalizeWisp,
  validateConversationGraph,
} from "./conversation-normalizer.js";
import { ConversationStore, type StoredPageRequest } from "./conversation-store.js";
import { splitLegacyChat } from "./legacy-conversations.js";
import { normalizeQueuedMessage } from "./message-queue.js";
import { normalizeScheduledMessage } from "./message-schedule.js";
import { buildSnippet, MessageSearchWorker } from "./message-search.js";
import { CONVERSATION_STORAGE_POLICY } from "./storage-policy.js";
import { ARCHIVE_MANIFEST_FILE, type ArchiveManifest } from "../shared/storage.js";
import {
  applyWorkspaceAction,
  withLastActivity,
  type ConversationRecord,
  type ParticipantSession,
  type WispRecord,
  type WorkspaceActionResult,
  type WorkspaceActionStatus,
  type WorkspaceRecords,
} from "./workspace-actions.js";

// Version of the conversation record format. The legacy JSON store wrote
// versions 1–3; SQLite stored version 4 until Wisps were stored apart from
// conversations. Older records are upgraded when they are read.
const SCHEMA_VERSION = 5;
const REMOVED_DEMO_CONVERSATION_IDS = new Set(["chief", "sales", "inbox", "account", "talent", "expense", "offsite"]);
const NEW_WISP_PREVIEW = "Ready for the first task.";

export type { ConversationRecord, WispRecord } from "./workspace-actions.js";

interface PersistedConversationState extends WorkspaceRecords {
  schemaVersion: typeof SCHEMA_VERSION;
  initialized: boolean;
  wisps: Record<string, WispRecord>;
  conversations: Record<string, ConversationRecord>;
}

function emptyState(): PersistedConversationState {
  return { schemaVersion: SCHEMA_VERSION, initialized: false, wisps: {}, conversations: {} };
}

function chatsOf(records: Readonly<Record<string, ConversationRecord>>): ChatCollection {
  return Object.fromEntries(Object.values(records).map(({ chat }) => [chat.id, chat]));
}

function wispsOf(records: Readonly<Record<string, WispRecord>>): WispCollection {
  return Object.fromEntries(Object.values(records).map(({ wisp }) => [wisp.id, wisp]));
}

function validateRecords(records: WorkspaceRecords): void {
  validateConversationGraph(chatsOf(records.conversations), wispsOf(records.wisps));
}

/** Writes every Wisp and conversation record an action replaced, and deletes the ones it removed. */
function putChangedRecords(store: ConversationStore, previous: WorkspaceRecords, next: WorkspaceRecords): void {
  for (const id of Object.keys(previous.conversations)) {
    if (!next.conversations[id]) store.deleteConversation(id);
  }
  for (const id of Object.keys(previous.wisps)) {
    if (!next.wisps[id]) store.deleteWisp(id);
  }
  for (const [id, record] of Object.entries(next.wisps)) {
    if (previous.wisps[id] !== record) store.putWisp(record);
  }
  for (const [id, record] of Object.entries(next.conversations)) {
    if (previous.conversations[id] !== record) store.putConversation(record);
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
  /** The person's time zone as the app last reported it; this computer's until then. */
  private timeZone = systemTimeZone();
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
    try {
      const saved = JSON.parse(await readFile(path.join(this.dataDirectory, "user-time-zone.json"), "utf8"));
      if (isTimeZone(saved?.timeZone)) this.timeZone = saved.timeZone;
    } catch {
      // Missing or unreadable: keep this computer's time zone until the app reports one.
    }
    let store: ConversationStore;
    let stored: PersistedConversationState | undefined;
    try {
      store = await this.openStore();
      if (store.isEstablished()) stored = this.parsePersistedState(store.read());
      if (stored && store.hasJsonRecords()) {
        // Records from before they were stored as columns: rewrite them all at once.
        store.rebuild(stored, {
          scheduled: await this.readScheduledMessages(),
          queued: await this.readQueuedMessages(),
        });
      }
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

  getUserTimeZone(): string {
    return this.timeZone;
  }

  async saveUserTimeZone(timeZone: string): Promise<void> {
    if (!isTimeZone(timeZone)) throw new WispBackendError("invalid_request", "The time zone is invalid.");
    if (timeZone === this.timeZone) return;
    await this.enqueue(async () => {
      await writeFileAtomically(path.join(this.dataDirectory, "user-time-zone.json"), JSON.stringify({ timeZone }));
      this.timeZone = timeZone;
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
    return chatsOf(this.state.conversations);
  }

  /** Uncloned view of the stored Wisps; see `readChats`. */
  readWisps(): Readonly<WispCollection> {
    return wispsOf(this.state.wisps);
  }

  /** The Wisp whose own conversation this is, or undefined for a circle or an unknown conversation. */
  readConversationWisp(conversationId: string): Readonly<Wisp> | undefined {
    const chat = this.state.conversations[conversationId]?.chat;
    return chat?.kind === "wisp" ? this.state.wisps[chat.wispId]?.wisp : undefined;
  }

  listAgentContexts(): ReadonlyArray<ConversationAgentContext> {
    return Object.values(this.state.conversations).flatMap(({ chat }) =>
      chat.kind === "wisp" ? [this.getAgentContext(chat.id)] : [],
    );
  }

  /** The agent context of a Wisp's own conversation. */
  getAgentContext(conversationId: string): ConversationAgentContext {
    const { record, wispRecord, session } = this.requireWispConversation(conversationId);
    const { wisp } = wispRecord;
    return {
      conversationId,
      wispId: wisp.id,
      sessionId: session.sessionId,
      modelOverride: wispRecord.modelOverride,
      name: wisp.name,
      role: wisp.role,
      soul: wisp.soul,
      userName: this.profile.preferredName || undefined,
      userProfile: this.getUserProfile(),
      userTimeZone: () => this.timeZone,
      workspaceDirectory: path.join(this.workspaceRoot, record.storageId),
      sessionDirectory: path.join(this.sessionRoot, session.sessionId),
      configDirectory: path.join(this.configRoot, wispRecord.storageId),
      piSessionId: session.piSessionId,
      piSessionFile: session.piSessionFile,
      savePiSessionIdentity: (identity) => this.savePiSessionIdentity(conversationId, identity),
    };
  }

  /** What keys the integration grants of the Wisp whose own conversation this is. */
  getWispStorageId(conversationId: string): string {
    return this.requireWispConversation(conversationId).wispRecord.storageId;
  }

  /**
   * Each conversation's workspace folder, whatever its kind: the folder
   * belongs to the conversation, so a circle's members share one entry.
   */
  listWorkspaceFolders(): ReadonlyArray<{
    conversationId: string;
    name: string;
    kind: "wisp" | "circle";
    directory: string;
  }> {
    return Object.values(this.state.conversations).map(({ chat, storageId }) => ({
      conversationId: chat.id,
      name: chat.kind === "circle" ? chat.name : (this.state.wisps[chat.wispId]?.wisp.name ?? "Wisp"),
      kind: chat.kind,
      directory: path.join(this.workspaceRoot, storageId),
    }));
  }

  /** The workspace folder of any conversation; throws for an unknown one. */
  getWorkspaceDirectory(conversationId: string): string {
    return path.join(this.workspaceRoot, this.require(conversationId).storageId);
  }

  /** Where deleted Wisps and circles are kept until the person removes them for good. */
  getArchiveDirectory(): string {
    return this.deletedRoot;
  }

  getPiSessionContext(conversationId: string): {
    sessionId: string;
    piSessionId: string | null;
    piSessionFile: string | null;
    workspaceDirectory: string;
  } | null {
    const record = this.require(conversationId);
    if (record.chat.kind !== "wisp") return null;
    const session = record.sessions[record.chat.wispId];
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      piSessionId: session.piSessionId,
      piSessionFile: session.piSessionFile,
      workspaceDirectory: path.join(this.workspaceRoot, record.storageId),
    };
  }

  /** First run: adopts the conversations the app kept in local storage before the backend stored them. */
  async initialize(chats: unknown): Promise<void> {
    await this.enqueue(async () => {
      if (this.state.initialized) return;
      const raw = asRecord(chats);
      if (Object.keys(raw).length > CONVERSATION_STORAGE_POLICY.maxConversations) {
        throw new WispBackendError("invalid_request", "The conversation data is invalid.");
      }
      const timestamp = this.now().toISOString();
      const next: PersistedConversationState = { ...emptyState(), initialized: true };
      for (const [key, value] of Object.entries(raw)) {
        // Early versions kept their bundled demo conversations in local storage too.
        if (REMOVED_DEMO_CONVERSATION_IDS.has(key)) continue;
        const { chat, wisp } = splitLegacyChat(value);
        if (chat.id !== normalizeConversationId(key)) {
          throw new WispBackendError("invalid_request", "The conversation data is invalid.");
        }
        if (wisp) {
          next.wisps[wisp.id] = this.newWispRecord(wisp, null, timestamp);
          next.conversations[chat.id] = this.newConversationRecord(chat, timestamp, [wisp.id]);
        } else {
          next.conversations[chat.id] = this.newConversationRecord(chat, timestamp);
        }
      }
      validateRecords(next);
      await this.ensureAllDirectories(next);
      await this.commit(next, (store) => store.replaceAll(next));
    });
  }

  /** Creates a Wisp and its own conversation, which shares its ID. */
  async createWisp(
    wispValue: unknown,
    options: { notifyOnUpdatesEnabled: boolean; modelOverride?: ModelSelection | null },
  ): Promise<void> {
    await this.enqueue(async () => {
      const wisp = normalizeWisp(wispValue);
      const modelOverride = normalizeSelection(options.modelOverride);
      if (options.modelOverride && !modelOverride) {
        throw new WispBackendError("invalid_request", "The model selection is invalid.");
      }
      const timestamp = this.now().toISOString();
      const wispRecord = this.newWispRecord(wisp, modelOverride, timestamp);
      const conversation = this.newConversationRecord(
        normalizeChat({
          id: wisp.id,
          kind: "wisp",
          wispId: wisp.id,
          notifyOnUpdatesEnabled: options.notifyOnUpdatesEnabled,
          preview: NEW_WISP_PREVIEW,
          messages: [],
        }),
        timestamp,
        [wisp.id],
      );
      const result = applyWorkspaceAction(this.state, { type: "create-wisp", wisp: wispRecord, conversation });
      await this.adopt(result, { ensure: { wisps: [wispRecord], conversations: [conversation] } });
    });
  }

  async updateWisp(wispId: string, changes: WispChanges): Promise<void> {
    await this.enqueue(async () => {
      const result = applyWorkspaceAction(this.state, {
        type: "update-wisp",
        wispId,
        changes,
        updatedAt: this.now().toISOString(),
      });
      await this.adopt(result);
    });
  }

  /** Deletes a Wisp with its own conversation, removes it from circles, and archives their folders. */
  async deleteWisp(wispId: string): Promise<{ wisp: WispRecord; conversation: ConversationRecord }> {
    return this.enqueue(async () => {
      const previous = this.state;
      const result = applyWorkspaceAction(previous, {
        type: "delete-wisp",
        wispId,
        updatedAt: this.now().toISOString(),
      });
      await this.adopt(result);
      const { conversation, wisp } = result.deleted!;
      // The Wisp's sessions in circles go with it.
      const circleSessions = Object.values(previous.conversations).flatMap((record) =>
        record.chat.kind === "circle" && record.sessions[wispId] ? [record.sessions[wispId]] : [],
      );
      await this.archiveDeleted({ conversation, wisp }, circleSessions).catch(() => undefined);
      return structuredClone({ wisp: wisp!, conversation });
    });
  }

  /** Creates a circle. A Wisp's own conversation is created with the Wisp. */
  async create(chatValue: unknown): Promise<void> {
    await this.enqueue(async () => {
      const chat = withLastActivity(normalizeChat(chatValue));
      if (chat.kind !== "circle") {
        throw new WispBackendError("invalid_request", "A Wisp's conversation is created with the Wisp.");
      }
      const record = this.newConversationRecord(chat, this.now().toISOString());
      const result = applyWorkspaceAction(this.state, { type: "create", record });
      await this.adopt(result, { ensure: { conversations: [record] } });
    });
  }

  async update(conversationId: string, changes: ChatChanges): Promise<void> {
    await this.enqueue(async () => {
      const updatedAt = this.now().toISOString();
      let result =
        changes.kind === "circle" && changes.memberIds !== undefined
          ? applyWorkspaceAction(this.state, {
              type: "replace-circle-members",
              conversationId,
              memberIds: changes.memberIds,
              updatedAt,
            })
          : applyWorkspaceAction(this.state, {
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
        }
      }
      await this.adopt(result);
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
      const result = applyWorkspaceAction(this.state, {
        type: "answer-prompt",
        conversationId,
        messageId,
        answer,
        updatedAt: this.now().toISOString(),
      });
      this.throwForActionStatus(result.status);
      const record = result.records.conversations[conversationId]!;
      const prompt = record.chat.messages.find(({ id }) => id === messageId)!;
      await this.commit({ ...this.state, ...result.records }, (store) => {
        store.putConversation(record);
        store.putMessages(conversationId, [prompt]);
      });
      return prompt;
    });
  }

  async markRead(conversationId: string): Promise<void> {
    await this.enqueue(async () => {
      const result = applyWorkspaceAction(this.state, {
        type: "mark-read",
        conversationId,
        updatedAt: this.now().toISOString(),
      });
      this.throwForActionStatus(result.status);
      if (result.status === "unchanged") return;
      const record = result.records.conversations[conversationId]!;
      await this.commit({ ...this.state, ...result.records }, (store) => store.putConversation(record));
    });
  }

  async markUnread(conversationId: string): Promise<void> {
    await this.enqueue(async () => {
      const result = applyWorkspaceAction(this.state, {
        type: "mark-unread",
        conversationId,
        updatedAt: this.now().toISOString(),
      });
      this.throwForActionStatus(result.status);
      if (result.status === "unchanged") return;
      const record = result.records.conversations[conversationId]!;
      await this.commit({ ...this.state, ...result.records }, (store) => store.putConversation(record));
    });
  }

  /** Sets the model of the Wisp whose own conversation this is. */
  async setModelOverride(conversationId: string, model: ModelSelection | null): Promise<void> {
    await this.enqueue(async () => {
      const { wispRecord } = this.requireWispConversation(conversationId);
      const normalized = normalizeSelection(model);
      if (model !== null && !normalized)
        throw new WispBackendError("invalid_request", "The model selection is invalid.");
      const record: WispRecord = { ...wispRecord, modelOverride: normalized, updatedAt: this.now().toISOString() };
      await this.commit({ ...this.state, wisps: { ...this.state.wisps, [record.wisp.id]: record } }, (store) =>
        store.putWisp(record),
      );
    });
  }

  async savePiSessionIdentity(
    conversationId: string,
    identity: { sessionId: string; sessionFile: string | null },
  ): Promise<void> {
    await this.enqueue(async () => {
      const { record, wispRecord, session } = this.requireWispConversation(conversationId);
      const piSessionId = normalizeConversationId(identity.sessionId);
      const piSessionFile =
        identity.sessionFile === null ? null : this.normalizePiSessionFile(session.sessionId, identity.sessionFile);
      if (session.piSessionId === piSessionId && session.piSessionFile === piSessionFile) return;
      const next: ConversationRecord = {
        ...record,
        sessions: { ...record.sessions, [wispRecord.wisp.id]: { ...session, piSessionId, piSessionFile } },
        updatedAt: this.now().toISOString(),
      };
      await this.commit(
        { ...this.state, conversations: { ...this.state.conversations, [conversationId]: next } },
        (store) => store.putConversation(next),
      );
    });
  }

  /** Deletes a circle and archives its folders. A Wisp's own conversation goes only with the Wisp. */
  async delete(conversationId: string): Promise<ConversationRecord> {
    return this.enqueue(async () => {
      const result = applyWorkspaceAction(this.state, {
        type: "delete",
        conversationId,
        updatedAt: this.now().toISOString(),
      });
      await this.adopt(result);
      const { conversation } = result.deleted!;
      await this.archiveDeleted({ conversation }).catch(() => undefined);
      return structuredClone(conversation);
    });
  }

  /** Every scheduled message, soonest first. Malformed records are skipped. */
  async listScheduledMessages(): Promise<ScheduledMessage[]> {
    return this.enqueue(() => this.readScheduledMessages());
  }

  /** Saves a new scheduled message for an existing Wisp that holds fewer than `limit`. */
  async addScheduledMessage(message: ScheduledMessage, limit: number): Promise<void> {
    await this.enqueue(async () => {
      if (this.state.conversations[message.conversationId]?.chat.kind !== "wisp") {
        throw new WispBackendError("not_found", "The Wisp was not found.");
      }
      const scheduled = await this.readScheduledMessages();
      if (scheduled.some(({ id }) => id === message.id)) {
        throw new WispBackendError("already_exists", "This scheduled message already exists.");
      }
      if (scheduled.filter(({ conversationId }) => conversationId === message.conversationId).length >= limit) {
        throw new WispBackendError("invalid_request", "This Wisp already has too many scheduled messages.");
      }
      const store = await this.openStore();
      store.transaction(() => store.putScheduledMessage(message));
    });
  }

  /**
   * Replaces a scheduled message with what `change` returns: a new version, or
   * null to remove it. Returning undefined leaves it as it is. Resolves with
   * the message as it was before a change, or undefined when nothing changed.
   */
  async changeScheduledMessage(
    id: string,
    change: (current: ScheduledMessage) => ScheduledMessage | null | undefined,
  ): Promise<ScheduledMessage | undefined> {
    return this.enqueue(async () => {
      const current = (await this.readScheduledMessages()).find((message) => message.id === id);
      if (!current) return undefined;
      const next = change(current);
      if (next === undefined) return undefined;
      const store = await this.openStore();
      store.transaction(() => {
        if (next) store.putScheduledMessage({ ...next, id, conversationId: current.conversationId });
        else store.deleteScheduledMessage(id);
      });
      return current;
    });
  }

  /** Every queued message, oldest first. Malformed records are skipped. */
  async listQueuedMessages(): Promise<QueuedMessage[]> {
    return this.enqueue(() => this.readQueuedMessages());
  }

  /** Queues a message for an existing Wisp; with a `limit`, only while it has fewer waiting. */
  async addQueuedMessage(message: QueuedMessage, limit?: number): Promise<void> {
    await this.enqueue(async () => {
      if (this.state.conversations[message.conversationId]?.chat.kind !== "wisp") {
        throw new WispBackendError("not_found", "The Wisp was not found.");
      }
      const waiting = (await this.readQueuedMessages()).filter(
        ({ conversationId }) => conversationId === message.conversationId,
      );
      if (limit !== undefined && waiting.length >= limit) {
        throw new WispBackendError("invalid_request", "This Wisp already has too many messages waiting.");
      }
      const store = await this.openStore();
      store.transaction(() => store.putQueuedMessage(message));
    });
  }

  /** Like `changeScheduledMessage`, for a message still waiting in the queue. */
  async changeQueuedMessage(
    id: string,
    change: (current: QueuedMessage) => QueuedMessage | null,
  ): Promise<QueuedMessage | undefined> {
    return this.enqueue(async () => {
      const current = (await this.readQueuedMessages()).find((message) => message.id === id);
      if (!current) return undefined;
      const next = change(current);
      const store = await this.openStore();
      store.transaction(() => {
        if (next) store.putQueuedMessage({ ...next, id, conversationId: current.conversationId });
        else store.deleteQueuedMessage(id);
      });
      return current;
    });
  }

  /**
   * Moves a Wisp's oldest queued message into its transcript, as `toMessage`
   * writes it, in one transaction: it is never in both places, nor in neither.
   */
  async takeQueuedMessage(
    conversationId: string,
    toMessage: (queued: QueuedMessage) => OutgoingMessage & { id: string },
  ): Promise<{ queued: QueuedMessage; change: MessageChange } | undefined> {
    return this.enqueue(async () => {
      const queued = (await this.readQueuedMessages()).find((message) => message.conversationId === conversationId);
      if (!queued) return undefined;
      const change = await this.applyAppend(conversationId, toMessage(queued), (store) =>
        store.deleteQueuedMessage(queued.id),
      );
      return { queued, change };
    });
  }

  /** Messages the person sent that were handed to a Wisp but never answered, e.g. when Wisp stopped mid-turn. */
  listUnansweredRequests(): Array<{ conversationId: string; messageId: string }> {
    return Object.values(this.state.conversations).flatMap(({ chat }) =>
      chat.messages.flatMap((message) =>
        message.type === "outgoing" && message.status === "queued" && message.id
          ? [{ conversationId: chat.id, messageId: message.id }]
          : [],
      ),
    );
  }

  /** Waits for pending writes, then closes the database. A later write reopens it. */
  async close(): Promise<void> {
    await this.mutation;
    await this.searchWorker?.dispose();
    this.searchWorker = undefined;
    this.store?.close();
    this.store = undefined;
  }

  private async applyAppend(
    conversationId: string,
    message: Message,
    alsoWrite?: (store: ConversationStore) => void,
  ): Promise<MessageChange> {
    const messageId = message.id ?? this.createId();
    const added = (await this.openStore()).getMessage(conversationId, messageId) === undefined;
    const result = applyWorkspaceAction(this.state, {
      type: "append-message",
      conversationId,
      message: { ...message, id: messageId },
      updatedAt: this.now().toISOString(),
    });
    this.throwForActionStatus(result.status);
    const record = result.records.conversations[conversationId]!;
    const stored = record.chat.messages.find(({ id }) => id === messageId)!;
    await this.commit({ ...this.state, ...result.records }, (store) => {
      store.putConversation(record);
      store.deleteOldestMessages(conversationId, result.droppedOldestMessages ?? 0);
      store.putMessages(conversationId, [stored]);
      alsoWrite?.(store);
    });
    return { message: stored, added };
  }

  private async readQueuedMessages(): Promise<QueuedMessage[]> {
    return (await this.openStore()).readQueuedMessages().flatMap((value) => {
      const message = normalizeQueuedMessage(value);
      return message ? [message] : [];
    });
  }

  private async readScheduledMessages(): Promise<ScheduledMessage[]> {
    return (await this.openStore()).readScheduledMessages().flatMap((value) => {
      const message = normalizeScheduledMessage(value);
      return message ? [message] : [];
    });
  }

  private async lookupMessage(conversationId: string, messageId: string): Promise<Message | undefined> {
    const body = (await this.openStore()).getMessage(conversationId, messageId);
    return body === undefined ? undefined : normalizeMessage(body);
  }

  /**
   * Commits an action's result: creates the folders of new records first,
   * then writes every record the action changed and adopts the new state.
   */
  private async adopt(
    result: WorkspaceActionResult,
    options: { ensure?: { wisps?: ReadonlyArray<WispRecord>; conversations?: ReadonlyArray<ConversationRecord> } } = {},
  ): Promise<void> {
    this.throwForActionStatus(result.status);
    if (result.status === "unchanged") return;
    validateRecords(result.records);
    await this.ensureAllDirectories({
      wisps: Object.fromEntries((options.ensure?.wisps ?? []).map((record) => [record.wisp.id, record])),
      conversations: Object.fromEntries(
        (options.ensure?.conversations ?? []).map((record) => [record.chat.id, record]),
      ),
    });
    const previous = this.state;
    await this.commit({ ...this.state, ...result.records, initialized: true }, (store) => {
      putChangedRecords(store, previous, result.records);
      for (const record of options.ensure?.conversations ?? []) store.putMessages(record.chat.id, record.chat.messages);
      if (!previous.initialized) store.setInitialized(true);
    });
  }

  private newWispRecord(wisp: Wisp, modelOverride: ModelSelection | null, timestamp: string): WispRecord {
    return {
      wisp,
      storageId: normalizeConversationId(this.createId()),
      modelOverride,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  /** A new conversation record; each listed Wisp gets a new agent session in it. */
  private newConversationRecord(
    chat: Chat,
    timestamp: string,
    participantIds: ReadonlyArray<WispId> = [],
  ): ConversationRecord {
    return {
      chat,
      storageId: normalizeConversationId(this.createId()),
      sessions: Object.fromEntries(
        participantIds.map((wispId) => [
          wispId,
          { sessionId: normalizeConversationId(this.createId()), piSessionId: null, piSessionFile: null },
        ]),
      ),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
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

  /** A Wisp's own conversation, with the Wisp and its session there; circles have no single agent. */
  private requireWispConversation(conversationId: string): {
    record: ConversationRecord;
    wispRecord: WispRecord;
    session: ParticipantSession;
  } {
    const record = this.require(conversationId);
    if (record.chat.kind !== "wisp") {
      throw new WispBackendError("invalid_request", "Circles do not own agent sessions.");
    }
    const wispRecord = this.state.wisps[record.chat.wispId];
    const session = record.sessions[record.chat.wispId];
    if (!wispRecord || !session) throw new WispBackendError("not_found", "The Wisp was not found.");
    return { record, wispRecord, session };
  }

  private throwForActionStatus(status: WorkspaceActionStatus): void {
    if (status === "applied" || status === "unchanged") return;
    if (status === "already_exists") {
      throw new WispBackendError("already_exists", "A conversation with this ID already exists.");
    }
    if (status === "kind_mismatch") {
      throw new WispBackendError("invalid_request", "This change does not apply to this kind of conversation.");
    }
    if (status === "invalid_member") {
      throw new WispBackendError("invalid_request", "Circle members must reference existing Wisps.");
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
    let persistedSchemaVersion: number;
    try {
      if (Buffer.byteLength(contents, "utf8") > CONVERSATION_STORAGE_POLICY.maxLegacyStateBytes) {
        throw new Error("Conversation state exceeds the local storage limit.");
      }
      const parsed: unknown = JSON.parse(contents);
      persistedSchemaVersion = this.schemaVersionOf(parsed);
      if (![1, 2, 3, 4].includes(persistedSchemaVersion)) throw new Error("Invalid state");
      this.state = this.parsePersistedState(parsed);
    } catch {
      await rename(this.legacyStatePath, `${this.legacyStatePath}.corrupt-${this.fileSuffix()}`);
      this.recoveredCorruptState = true;
      this.state = emptyState();
      return;
    }
    if (persistedSchemaVersion === 1 || persistedSchemaVersion === 2) await this.removeBundledDemoConversations();
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

  /**
   * Validates stored state. Records saved before Wisps were stored apart from
   * conversations are split into a Wisp and its conversation.
   */
  private parsePersistedState(value: unknown): PersistedConversationState {
    const raw = this.stateRecord(value);
    if (typeof raw.initialized !== "boolean") throw new Error("Invalid state");
    const state: PersistedConversationState = { ...emptyState(), initialized: raw.initialized };
    for (const [id, value] of Object.entries(raw.wisps === undefined ? {} : this.stateRecord(raw.wisps))) {
      const record = this.stateRecord(value);
      const wisp = normalizeWisp(record.wisp);
      if (wisp.id !== id) throw new Error("Invalid state");
      state.wisps[id] = {
        wisp,
        storageId: normalizeConversationId(record.storageId),
        modelOverride: normalizeSelection(record.modelOverride),
        createdAt: this.timestampOf(record.createdAt),
        updatedAt: this.timestampOf(record.updatedAt),
      };
    }
    for (const [id, value] of Object.entries(this.stateRecord(raw.conversations))) {
      const record = this.stateRecord(value);
      if (record.storageId === undefined) {
        this.upgradeLegacyRecord(state, id, record);
        continue;
      }
      const chat = normalizeChat(record.chat);
      if (chat.id !== id) throw new Error("Invalid state");
      state.conversations[id] = {
        chat,
        storageId: normalizeConversationId(record.storageId),
        sessions: this.parseSessions(record.sessions),
        createdAt: this.timestampOf(record.createdAt),
        updatedAt: this.timestampOf(record.updatedAt),
      };
    }
    validateRecords(state);
    return state;
  }

  /**
   * Splits a record from before Wisps were stored apart. One ID named all of
   * a Wisp's folders, so it keeps naming them: the Wisp's settings, its
   * conversation's workspace, and its session there.
   */
  private upgradeLegacyRecord(state: PersistedConversationState, id: string, record: Record<string, unknown>): void {
    const { chat, wisp } = splitLegacyChat(record.chat);
    if (chat.id !== id) throw new Error("Invalid state");
    const createdAt = this.timestampOf(record.createdAt);
    const updatedAt = this.timestampOf(record.updatedAt);
    if (!wisp) {
      if (record.sessionId !== null) throw new Error("Invalid state");
      state.conversations[id] = {
        chat,
        storageId: normalizeConversationId(this.createId()),
        sessions: {},
        createdAt,
        updatedAt,
      };
      return;
    }
    const storageId = normalizeConversationId(record.sessionId);
    state.wisps[id] = {
      wisp,
      storageId,
      modelOverride: normalizeSelection(record.modelOverride),
      createdAt,
      updatedAt,
    };
    state.conversations[id] = {
      chat,
      storageId,
      sessions: {
        [id]: {
          sessionId: storageId,
          piSessionId: typeof record.piSessionId === "string" ? normalizeConversationId(record.piSessionId) : null,
          piSessionFile:
            typeof record.piSessionFile === "string"
              ? this.relocatedPiSessionFile(storageId, record.piSessionFile)
              : null,
        },
      },
      createdAt,
      updatedAt,
    };
  }

  private parseSessions(value: unknown): Record<WispId, ParticipantSession> {
    const sessions: Record<WispId, ParticipantSession> = {};
    for (const [wispId, entry] of Object.entries(this.stateRecord(value))) {
      const session = this.stateRecord(entry);
      const sessionId = normalizeConversationId(session.sessionId);
      sessions[normalizeConversationId(wispId)] = {
        sessionId,
        piSessionId: typeof session.piSessionId === "string" ? normalizeConversationId(session.piSessionId) : null,
        piSessionFile:
          typeof session.piSessionFile === "string"
            ? this.relocatedPiSessionFile(sessionId, session.piSessionFile)
            : null,
      };
    }
    return sessions;
  }

  private stateRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid state");
    return value as Record<string, unknown>;
  }

  private schemaVersionOf(value: unknown): number {
    const version = this.stateRecord(value).schemaVersion;
    if (typeof version !== "number") throw new Error("Invalid state");
    return version;
  }

  private timestampOf(value: unknown): string {
    if (typeof value !== "string" || value.length > 100 || Number.isNaN(Date.parse(value))) {
      throw new Error("Invalid state");
    }
    return value;
  }

  /**
   * Reads a stored session path. The data directory may have moved since it
   * was saved (a restored backup, another machine), so a path under another
   * root is re-anchored in this session's directory by file name.
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

  /** The folders each record names: a Wisp's settings, a conversation's workspace, and each session there. */
  private async ensureAllDirectories(records: WorkspaceRecords = this.state): Promise<void> {
    await Promise.all([
      ...Object.values(records.wisps).map(({ storageId }) =>
        mkdir(path.join(this.configRoot, storageId), { recursive: true }),
      ),
      ...Object.values(records.conversations).flatMap(({ storageId, sessions }) => [
        mkdir(path.join(this.workspaceRoot, storageId), { recursive: true }),
        ...Object.values(sessions).map(({ sessionId }) =>
          mkdir(path.join(this.sessionRoot, sessionId), { recursive: true }),
        ),
      ]),
    ]);
  }

  private async removeBundledDemoConversations(): Promise<void> {
    let records: WorkspaceRecords = this.state;
    const removed: Array<NonNullable<WorkspaceActionResult["deleted"]>> = [];
    const updatedAt = this.now().toISOString();
    for (const id of REMOVED_DEMO_CONVERSATION_IDS) {
      const chat = records.conversations[id]?.chat;
      if (!chat) continue;
      const result = applyWorkspaceAction(
        records,
        chat.kind === "wisp"
          ? { type: "delete-wisp", wispId: id, updatedAt }
          : { type: "delete", conversationId: id, updatedAt },
      );
      if (result.deleted) removed.push(result.deleted);
      records = result.records;
    }
    this.state = { ...this.state, wisps: { ...records.wisps }, conversations: { ...records.conversations } };
    await Promise.allSettled(removed.map((deleted) => this.archiveDeleted(deleted)));
  }

  /**
   * Moves a deleted Wisp's or circle's folders into the archive: the
   * conversation's workspace, its sessions and any `otherSessions`, and the
   * Wisp's own settings.
   */
  private async archiveDeleted(
    deleted: NonNullable<WorkspaceActionResult["deleted"]>,
    otherSessions: ReadonlyArray<ParticipantSession> = [],
  ): Promise<void> {
    const { conversation, wisp } = deleted;
    const archive = path.join(this.deletedRoot, `${wisp?.storageId ?? conversation.storageId}-${this.fileSuffix()}`);
    await mkdir(archive, { recursive: true });
    // Names the archive in Storage; the folder name is only an ID.
    const manifest: ArchiveManifest = {
      name: conversation.chat.kind === "circle" ? conversation.chat.name : (wisp?.wisp.name ?? "Wisp"),
      kind: conversation.chat.kind,
      archivedAt: this.now().toISOString(),
    };
    await writeFileAtomically(path.join(archive, ARCHIVE_MANIFEST_FILE), JSON.stringify(manifest)).catch(
      () => undefined,
    );
    const move = (from: string, to: string) => rename(from, path.join(archive, to)).catch(() => undefined);
    // Transcriptions are a cache of the user's documents, so they are deleted, not archived.
    if (wisp) {
      await rm(path.join(this.configRoot, wisp.storageId, TRANSCRIPTION_CACHE_DIRECTORY), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    const sessions = [...Object.values(conversation.sessions), ...otherSessions];
    await Promise.all([
      move(path.join(this.workspaceRoot, conversation.storageId), "workspace"),
      ...sessions.map(({ sessionId }, index) =>
        move(path.join(this.sessionRoot, sessionId), index === 0 ? "pi-session" : `pi-session-${sessionId}`),
      ),
      ...(wisp ? [move(path.join(this.configRoot, wisp.storageId), "pi-config")] : []),
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
