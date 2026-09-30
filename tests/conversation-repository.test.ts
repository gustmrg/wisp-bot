import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ConversationRepository } from "../electron/backend/conversation-repository.js";
import type { Chat } from "../shared/conversations.js";

function chat(id: string, circle = false): Chat {
  const base = {
    id,
    name: id,
    label: "Test",
    description: "A test conversation",
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    timestamp: "Now",
    messages: [{ type: "incoming", text: "Hello" }],
  };
  return circle ? { ...base, kind: "circle", memberIds: [] } : { ...base, kind: "wisp", shape: "circle" };
}

describe("ConversationRepository", () => {
  it("imports legacy conversations once and keeps stable message and session IDs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-repository-"));
    let nextId = 0;
    const repository = new ConversationRepository({
      dataDirectory: directory,
      createId: () => `generated-${++nextId}`,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    await repository.load();
    await repository.initialize({ first: chat("first") });
    const firstRecord = repository.list()[0];
    await repository.initialize({ second: chat("second") });

    expect(repository.getChats()).toHaveProperty("first");
    expect(repository.getChats()).not.toHaveProperty("second");
    expect(repository.list()[0]?.sessionId).toBe(firstRecord?.sessionId);
    expect(repository.getChats().first?.messages[0]?.id).toBe("first:message:0");
    const context = repository.getAgentContext("first");
    await expect(readdir(context.workspaceDirectory)).resolves.toEqual([]);
    await expect(readdir(context.sessionDirectory)).resolves.toEqual([]);
    await expect(readdir(context.configDirectory)).resolves.toEqual([]);

    const piSessionFile = path.join(context.sessionDirectory, "history.jsonl");
    await repository.savePiSessionIdentity("first", {
      sessionId: "pi-history-id",
      sessionFile: piSessionFile,
    });
    const restored = new ConversationRepository({ dataDirectory: directory });
    await restored.load();
    expect(restored.getAgentContext("first")).toEqual(
      expect.objectContaining({
        piSessionId: "pi-history-id",
        piSessionFile,
      }),
    );
    await expect(
      restored.savePiSessionIdentity("first", {
        sessionId: "unsafe-history",
        sessionFile: path.join(directory, "outside.jsonl"),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(restored.getAgentContext("first").piSessionId).toBe("pi-history-id");
  });

  it("includes the configured user name in every agent context", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-user-context-"));
    const repository = new ConversationRepository({ dataDirectory: directory, userName: "  John\nDoe  " });
    await repository.initialize({ first: chat("first"), second: chat("second") });

    expect(repository.getAgentContext("first")).toEqual(expect.objectContaining({ userName: "John Doe" }));
    expect(repository.listAgentContexts()).toEqual([
      expect.objectContaining({ conversationId: "first", userName: "John Doe" }),
      expect.objectContaining({ conversationId: "second", userName: "John Doe" }),
    ]);
  });

  it("persists a creation-time model override with the new Wisp and restores it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-create-override-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.load();
    await repository.create(chat("plain"), null);
    const override = { providerId: "anthropic", modelId: "claude-sonnet-4-5", maxOutputTokens: 2048 };
    await repository.create(chat("custom"), override);

    expect(repository.getAgentContext("plain").modelOverride).toBeNull();
    expect(repository.getAgentContext("custom").modelOverride).toEqual(override);

    const restored = new ConversationRepository({ dataDirectory: directory });
    await restored.load();
    expect(restored.getAgentContext("custom").modelOverride).toEqual(override);
    expect(restored.getAgentContext("plain").modelOverride).toBeNull();
  });

  it("rejects creation-time model overrides that are invalid or belong to circles", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-create-override-invalid-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.load();

    await expect(
      repository.create(chat("bad"), { providerId: "", modelId: "claude-sonnet-4-5" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      repository.create(chat("circle", true), { providerId: "anthropic", modelId: "m" }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    expect(repository.getChats()).not.toHaveProperty("bad");
    expect(repository.getChats()).not.toHaveProperty("circle");
  });

  it("upgrades Phase 3 records without losing their stable application session", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-schema-upgrade-"));
    await writeFile(
      path.join(directory, "conversations.json"),
      JSON.stringify({
        schemaVersion: 1,
        initialized: true,
        conversations: {
          first: {
            chat: chat("first"),
            sessionId: "stable-app-session",
            createdAt: "2026-08-30T12:00:00.000Z",
            updatedAt: "2026-08-30T12:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    const repository = new ConversationRepository({ dataDirectory: directory });

    await repository.load();

    expect(repository.getAgentContext("first")).toEqual(
      expect.objectContaining({
        sessionId: "stable-app-session",
        piSessionId: null,
        piSessionFile: null,
      }),
    );
    const persisted = JSON.parse(await readFile(path.join(directory, "conversations.json"), "utf8")) as {
      schemaVersion: number;
    };
    expect(persisted.schemaVersion).toBe(4);
    const backup = (await readdir(directory)).find((name) => name.includes(".schema-v1-backup-"));
    expect(backup).toBeDefined();
    expect(JSON.parse(await readFile(path.join(directory, backup!), "utf8"))).toMatchObject({ schemaVersion: 1 });
  });

  it("removes previously persisted bundled demo conversations", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-demo-removal-"));
    await writeFile(
      path.join(directory, "conversations.json"),
      JSON.stringify({
        schemaVersion: 2,
        initialized: true,
        conversations: {
          chief: {
            chat: chat("chief"),
            sessionId: "demo-session",
            piSessionId: null,
            piSessionFile: null,
            createdAt: "2026-08-30T12:00:00.000Z",
            updatedAt: "2026-08-30T12:00:00.000Z",
          },
          custom: {
            chat: chat("custom"),
            sessionId: "custom-session",
            piSessionId: null,
            piSessionFile: null,
            createdAt: "2026-08-30T12:00:00.000Z",
            updatedAt: "2026-08-30T12:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    const repository = new ConversationRepository({ dataDirectory: directory });

    await repository.load();

    expect(repository.getChats()).toEqual({ custom: expect.objectContaining({ id: "custom" }) });
    const persisted = JSON.parse(await readFile(path.join(directory, "conversations.json"), "utf8")) as {
      schemaVersion: number;
      conversations: Record<string, unknown>;
    };
    expect(persisted.schemaVersion).toBe(4);
    expect(persisted.conversations).not.toHaveProperty("chief");
  });

  it("upserts stable message IDs without duplicating streamed lifecycle updates", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-message-upsert-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({ first: chat("first") });

    await repository.appendMessage("first", {
      id: "request-1:assistant",
      type: "incoming",
      text: "Partial",
      status: "streaming",
      createdAt: "2026-08-31T23:10:00.000Z",
    });
    await repository.appendMessage("first", {
      id: "request-1:assistant",
      type: "incoming",
      text: "Complete response",
      status: "complete",
      createdAt: "2026-08-31T23:10:00.000Z",
    });

    const matching = repository.getChats().first?.messages.filter(({ id }) => id === "request-1:assistant");
    expect(matching).toEqual([
      expect.objectContaining({
        text: "Complete response",
        status: "complete",
        createdAt: "2026-08-31T23:10:00.000Z",
      }),
    ]);
  });

  it("preserves a corrupt state file before recovering", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-corrupt-"));
    const statePath = path.join(directory, "conversations.json");
    await writeFile(statePath, "{ definitely not json", "utf8");
    const repository = new ConversationRepository({
      dataDirectory: directory,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });

    await repository.load();

    expect(repository.didRecoverCorruptState()).toBe(true);
    expect(repository.isInitialized()).toBe(false);
    const preserved = (await readdir(directory)).find((name) => name.includes(".corrupt-"));
    expect(preserved).toBeDefined();
    await expect(readFile(path.join(directory, preserved!), "utf8")).resolves.toBe("{ definitely not json");
  });

  it("rewrites schema-3 boolean records as discriminated variants", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-kind-migration-"));
    const statePath = path.join(directory, "conversations.json");
    const { kind: _kind, ...currentWisp } = chat("chief");
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 3,
        initialized: true,
        conversations: {
          chief: {
            chat: { ...currentWisp, isCircle: false },
            sessionId: "stable-session",
            piSessionId: null,
            piSessionFile: null,
            createdAt: "2026-08-30T12:00:00.000Z",
            updatedAt: "2026-08-30T12:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    const repository = new ConversationRepository({ dataDirectory: directory });

    await repository.load();

    expect(repository.getChats().chief).toMatchObject({ kind: "wisp", systemRole: "chief" });
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      schemaVersion: number;
      conversations: Record<string, { chat: Record<string, unknown> }>;
    };
    expect(persisted.schemaVersion).toBe(4);
    expect(persisted.conversations.chief?.chat).not.toHaveProperty("isCircle");
    expect(persisted.conversations.chief?.chat).toHaveProperty("kind", "wisp");
  });

  it("archives workspace and session data on explicit deletion", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-delete-"));
    const repository = new ConversationRepository({
      dataDirectory: directory,
      createId: () => "stable-session",
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    await repository.initialize({ first: chat("first") });

    await repository.delete("first");

    expect(repository.getChats()).toEqual({});
    const archives = await readdir(path.join(directory, "deleted-conversations"));
    expect(archives).toHaveLength(1);
    const contents = await readdir(path.join(directory, "deleted-conversations", archives[0]!));
    expect(contents.sort()).toEqual(["pi-config", "pi-session", "workspace"]);
  });

  it("enforces protected deletion and preserves the stored graph", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-protected-delete-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({ leader: { ...chat("leader"), systemRole: "chief" } });

    await expect(repository.delete("leader")).rejects.toMatchObject({ code: "invalid_request" });

    expect(repository.getChats().leader).toMatchObject({ id: "leader", systemRole: "chief" });
  });

  it("persists member pruning in the same deletion transaction", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-member-delete-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({
      first: chat("first"),
      second: chat("second"),
      crew: { ...chat("crew", true), memberIds: ["second", "first"] },
    });

    await repository.delete("first");

    expect(repository.getChats().crew).toMatchObject({ memberIds: ["second"] });
    const restored = new ConversationRepository({ dataDirectory: directory });
    await restored.load();
    expect(restored.getChats().crew).toMatchObject({ memberIds: ["second"] });
  });

  it("normalizes and persists an ordered circle membership replacement", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-member-update-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({
      first: chat("first"),
      second: chat("second"),
      crew: { ...chat("crew", true), memberIds: [] },
    });

    await repository.update("crew", { kind: "circle", memberIds: ["second", "first", "second"] });

    expect(repository.getChats().crew).toMatchObject({ memberIds: ["second", "first"] });
    const restored = new ConversationRepository({ dataDirectory: directory });
    await restored.load();
    expect(restored.getChats().crew).toMatchObject({ memberIds: ["second", "first"] });
  });

  it("rolls back an invalid circle membership replacement", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-member-invalid-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({ first: chat("first"), crew: { ...chat("crew", true), memberIds: ["first"] } });

    await expect(repository.update("crew", { kind: "circle", memberIds: ["missing"] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(repository.getChats().crew).toMatchObject({ memberIds: ["first"] });
  });

  it("rejects unsafe avatars and invalid circle membership as one graph", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-invalid-graph-"));
    const repository = new ConversationRepository({ dataDirectory: directory });

    await expect(
      repository.initialize({ first: { ...chat("first"), avatarImage: "data:image/png;base64,AAAA" } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      repository.initialize({
        first: chat("first"),
        crew: { ...chat("crew", true), memberIds: ["first", "first"] },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      repository.initialize({ crew: { ...chat("crew", true), memberIds: ["missing"] } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(repository.getChats()).toEqual({});
  });

  it("rolls back in-memory state when persistence cannot complete", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-write-failure-"));
    const blockedPath = path.join(directory, "not-a-directory");
    await writeFile(blockedPath, "blocked", "utf8");
    const repository = new ConversationRepository({ dataDirectory: blockedPath });

    await expect(repository.initialize({ first: chat("first") })).rejects.toBeDefined();

    expect(repository.isInitialized()).toBe(false);
    expect(repository.getChats()).toEqual({});
  });

  it("rolls back every kind of mutation when a later write fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-rollback-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.load();
    await repository.initialize({ first: chat("first") });
    const before = repository.list();
    const { sessionDirectory } = repository.getAgentContext("first");
    // Renaming the temporary file over a directory fails, so every persist rejects.
    const statePath = path.join(directory, "conversations.json");
    await rm(statePath);
    await mkdir(path.join(statePath, "blocker"), { recursive: true });

    await expect(
      repository.appendMessage("first", { id: "reply", type: "incoming", text: "Not saved" }),
    ).rejects.toBeDefined();
    await expect(
      repository.setModelOverride("first", { providerId: "anthropic", modelId: "claude-sonnet-5" }),
    ).rejects.toBeDefined();
    await expect(
      repository.savePiSessionIdentity("first", {
        sessionId: "pi-new",
        sessionFile: path.join(sessionDirectory, "history.jsonl"),
      }),
    ).rejects.toBeDefined();
    await expect(repository.update("first", { kind: "wisp", name: "Renamed" })).rejects.toBeDefined();

    expect(repository.list()).toEqual(before);
  });
});
