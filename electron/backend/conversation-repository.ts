import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";

import type { AgentSettings, Chat, ChatCollection, Message } from "../../shared/conversations.js";
import { writeFileAtomically } from "./atomic-file.js";
import { WispBackendError } from "./backend-error.js";
import type { ConversationAgentContext } from "./conversation-agent.js";
import {
  normalizeChat,
  normalizeChatCollection,
  normalizeConversationId,
} from "./conversation-normalizer.js";

const SCHEMA_VERSION = 2;

export interface ConversationRecord {
  chat: Chat;
  sessionId: string | null;
  piSessionId: string | null;
  piSessionFile: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PersistedConversationState {
  schemaVersion: typeof SCHEMA_VERSION;
  initialized: boolean;
  conversations: Record<string, ConversationRecord>;
}

export interface ConversationRepositoryOptions {
  dataDirectory: string;
  now?: () => Date;
  createId?: () => string;
}

export class ConversationRepository {
  private readonly statePath: string;
  private readonly workspaceRoot: string;
  private readonly sessionRoot: string;
  private readonly configRoot: string;
  private readonly deletedRoot: string;
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
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async load(): Promise<void> {
    let needsSchemaUpgrade = false;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.statePath, "utf8"));
      this.state = this.parsePersistedState(parsed);
      needsSchemaUpgrade = (parsed as { schemaVersion?: unknown }).schemaVersion === 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      await this.preserveCorruptState();
      this.recoveredCorruptState = true;
      this.state = { schemaVersion: SCHEMA_VERSION, initialized: false, conversations: {} };
    }
    await this.ensureAllDirectories();
    if (needsSchemaUpgrade) await this.persist();
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

  listAgentContexts(): ReadonlyArray<ConversationAgentContext> {
    return this.list().flatMap(({ chat, sessionId }) => sessionId ? [{
      conversationId: chat.id,
      sessionId,
      name: chat.name,
      label: chat.label,
      description: chat.description,
      workspaceDirectory: path.join(this.workspaceRoot, sessionId),
      sessionDirectory: path.join(this.sessionRoot, sessionId),
      configDirectory: path.join(this.configRoot, sessionId),
      piSessionId: this.state.conversations[chat.id]?.piSessionId ?? null,
      piSessionFile: this.state.conversations[chat.id]?.piSessionFile ?? null,
      savePiSessionIdentity: (identity) => this.savePiSessionIdentity(chat.id, identity),
    }] : []);
  }

  getAgentContext(conversationId: string): ConversationAgentContext {
    const record = this.require(conversationId);
    if (!record.sessionId) throw new WispBackendError("invalid_request", "Circles do not own agent sessions.");
    return {
      conversationId,
      sessionId: record.sessionId,
      name: record.chat.name,
      label: record.chat.label,
      description: record.chat.description,
      workspaceDirectory: path.join(this.workspaceRoot, record.sessionId),
      sessionDirectory: path.join(this.sessionRoot, record.sessionId),
      configDirectory: path.join(this.configRoot, record.sessionId),
      piSessionId: record.piSessionId,
      piSessionFile: record.piSessionFile,
      savePiSessionIdentity: (identity) => this.savePiSessionIdentity(conversationId, identity),
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
        conversations: Object.fromEntries(Object.values(normalized).map((chat) => [chat.id, {
          chat,
          sessionId: chat.isCircle ? null : normalizeConversationId(this.createId()),
          piSessionId: null,
          piSessionFile: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        }])),
      };
      await this.ensureAllDirectories();
      await this.persist();
    });
  }

  async create(chatValue: unknown): Promise<void> {
    await this.enqueue(async () => {
      const chat = normalizeChat(chatValue);
      if (this.state.conversations[chat.id]) {
        throw new WispBackendError("already_exists", "A conversation with this ID already exists.");
      }
      const timestamp = this.now().toISOString();
      const record: ConversationRecord = {
        chat,
        sessionId: chat.isCircle ? null : normalizeConversationId(this.createId()),
        piSessionId: null,
        piSessionFile: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.state.conversations[chat.id] = record;
      this.state.initialized = true;
      await this.ensureDirectories(record);
      await this.persist();
    });
  }

  async update(conversationId: string, changes: Partial<Omit<AgentSettings, "id" | "isCircle">>): Promise<void> {
    await this.enqueue(async () => {
      const record = this.require(conversationId);
      record.chat = normalizeChat({ ...record.chat, ...changes });
      record.updatedAt = this.now().toISOString();
      await this.persist();
    });
  }

  async appendMessage(conversationId: string, message: Message): Promise<void> {
    await this.enqueue(async () => {
      const record = this.require(conversationId);
      const messageId = message.id ?? this.createId();
      const existingIndex = record.chat.messages.findIndex(({ id }) => id === messageId);
      const messages = existingIndex === -1
        ? [...record.chat.messages, { ...message, id: messageId }]
        : record.chat.messages.map((existing, index) => (
          index === existingIndex ? { ...message, id: messageId } : existing
        ));
      const normalized = normalizeChat({
        ...record.chat,
        messages,
      });
      const current = normalized.messages.find(({ id }) => id === messageId);
      record.chat = {
        ...normalized,
        preview: current && "text" in current ? current.text : normalized.preview,
        timestamp: "Now",
      };
      record.updatedAt = this.now().toISOString();
      await this.persist();
    });
  }

  async answerPrompt(conversationId: string, messageId: string, answer: string): Promise<void> {
    await this.enqueue(async () => {
      const record = this.require(conversationId);
      let found = false;
      record.chat = {
        ...record.chat,
        messages: record.chat.messages.map((message) => {
          if (message.id !== messageId || message.type !== "prompt") return message;
          found = true;
          return { ...message, answer };
        }),
      };
      if (!found) throw new WispBackendError("not_found", "The prompt is no longer available.");
      record.updatedAt = this.now().toISOString();
      await this.persist();
    });
  }

  async markRead(conversationId: string): Promise<void> {
    await this.enqueue(async () => {
      const record = this.require(conversationId);
      if (!record.chat.unread) return;
      record.chat = { ...record.chat, unread: false };
      record.updatedAt = this.now().toISOString();
      await this.persist();
    });
  }

  async savePiSessionIdentity(
    conversationId: string,
    identity: { sessionId: string; sessionFile: string | null },
  ): Promise<void> {
    await this.enqueue(async () => {
      const record = this.require(conversationId);
      if (record.sessionId === null) throw new WispBackendError("invalid_request", "Circles do not own agent sessions.");
      const piSessionId = normalizeConversationId(identity.sessionId);
      const piSessionFile = identity.sessionFile === null
        ? null
        : this.normalizePiSessionFile(record.sessionId, identity.sessionFile);
      if (record.piSessionId === piSessionId && record.piSessionFile === piSessionFile) return;
      record.piSessionId = piSessionId;
      record.piSessionFile = piSessionFile;
      record.updatedAt = this.now().toISOString();
      await this.persist();
    });
  }

  async delete(conversationId: string): Promise<ConversationRecord> {
    return this.enqueue(async () => {
      const record = this.require(conversationId);
      delete this.state.conversations[conversationId];
      for (const other of Object.values(this.state.conversations)) {
        if (other.chat.memberIds?.includes(conversationId)) {
          other.chat = { ...other.chat, memberIds: other.chat.memberIds.filter((id) => id !== conversationId) };
          other.updatedAt = this.now().toISOString();
        }
      }
      await this.persist();
      if (record.sessionId) await this.archiveDirectories(record.sessionId).catch(() => undefined);
      return structuredClone(record);
    });
  }

  private require(conversationId: string): ConversationRecord {
    const record = this.state.conversations[conversationId];
    if (!record) throw new WispBackendError("not_found", "The conversation was not found.");
    return record;
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const previousState = structuredClone(this.state);
      try {
        return await operation();
      } catch (error) {
        this.state = previousState;
        throw error;
      }
    };
    const result = this.mutation.then(run, run);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(): Promise<void> {
    await writeFileAtomically(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  private parsePersistedState(value: unknown): PersistedConversationState {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid state");
    const raw = value as Record<string, unknown>;
    if ((raw.schemaVersion !== 1 && raw.schemaVersion !== SCHEMA_VERSION) || typeof raw.initialized !== "boolean") throw new Error("Invalid state");
    if (!raw.conversations || typeof raw.conversations !== "object" || Array.isArray(raw.conversations)) throw new Error("Invalid state");
    const conversations: Record<string, ConversationRecord> = {};
    for (const [id, value] of Object.entries(raw.conversations as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid state");
      const record = value as Record<string, unknown>;
      const chat = normalizeChat(record.chat);
      if (chat.id !== id || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") throw new Error("Invalid state");
      if (chat.isCircle ? record.sessionId !== null : typeof record.sessionId !== "string") throw new Error("Invalid state");
      const sessionId = record.sessionId === null ? null : normalizeConversationId(record.sessionId);
      conversations[id] = {
        chat,
        sessionId,
        piSessionId: typeof record.piSessionId === "string"
          ? normalizeConversationId(record.piSessionId)
          : null,
        piSessionFile: typeof record.piSessionFile === "string" && sessionId
          ? this.normalizePiSessionFile(sessionId, record.piSessionFile)
          : null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    }
    return { schemaVersion: SCHEMA_VERSION, initialized: raw.initialized, conversations };
  }

  private async preserveCorruptState(): Promise<void> {
    const suffix = this.now().toISOString().replaceAll(":", "-");
    await rename(this.statePath, `${this.statePath}.corrupt-${suffix}`).catch(() => undefined);
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
    await Promise.all(this.list().map((record) => this.ensureDirectories(record)));
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
    const archive = path.join(
      this.deletedRoot,
      `${sessionId}-${this.now().toISOString().replaceAll(":", "-")}`,
    );
    await mkdir(archive, { recursive: true });
    await Promise.all([
      rename(path.join(this.workspaceRoot, sessionId), path.join(archive, "workspace")).catch(() => undefined),
      rename(path.join(this.sessionRoot, sessionId), path.join(archive, "pi-session")).catch(() => undefined),
      rename(path.join(this.configRoot, sessionId), path.join(archive, "pi-config")).catch(() => undefined),
    ]);
  }
}
