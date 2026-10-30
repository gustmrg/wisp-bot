import { cp, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { ConversationRepository } from "../backend/conversation-repository.js";
import { seedConversations } from "./helpers/seed-conversations.js";
import { IntactDatabaseError } from "../backend/sqlite-backup.js";
import { CONVERSATION_STORAGE_POLICY } from "../backend/storage-policy.js";
import { DEFAULT_CONTEXT_POLICY } from "../shared/context-policy.js";
import type { Chat, CircleChat, Message, Wisp } from "../shared/conversations.js";
import { DEFAULT_WISP_APPEARANCE } from "../shared/wisp-appearance.js";

async function reload(directory: string): Promise<ConversationRepository> {
  const repository = new ConversationRepository({ dataDirectory: directory });
  await repository.load();
  return repository;
}

/** Raw rows as stored, bypassing the repository. */
function storedRows(directory: string, sql: string, ...parameters: string[]): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path.join(directory, "conversations.sqlite"));
  try {
    return db.prepare(sql).all(...parameters);
  } finally {
    db.close();
  }
}

function chat(id: string, circle = false): Chat {
  const base = {
    id,
    name: id,
    label: "Test",
    description: "A test conversation",
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    messages: [{ id: `${id}:message:0`, type: "incoming", text: "Hello" }],
  };
  return circle ? { ...base, kind: "circle", memberIds: [] } : { ...base, kind: "wisp" };
}

function newWisp(id: string): Wisp {
  return { id, name: id, role: "Test", soul: "A test Wisp", appearance: DEFAULT_WISP_APPEARANCE };
}

function circle(id: string, memberIds: string[] = []): CircleChat {
  return {
    id,
    kind: "circle",
    name: id,
    label: "Circle",
    description: "",
    memberIds,
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    messages: [],
  };
}

describe("ConversationRepository", () => {
  it("finds Pi sessions after its data directory moves, such as a restored backup", async () => {
    const original = await mkdtemp(path.join(os.tmpdir(), "wisp-original-"));
    const repository = await reload(original);
    await seedConversations(repository, { first: chat("first") });
    const { sessionDirectory } = repository.getAgentContext("first");
    await repository.savePiSessionIdentity("first", {
      sessionId: "pi-history-id",
      sessionFile: path.join(sessionDirectory, "history.jsonl"),
    });
    await repository.close();

    const moved = path.join(await mkdtemp(path.join(os.tmpdir(), "wisp-moved-")), "data");
    await cp(original, moved, { recursive: true });
    const restored = await reload(moved);
    const context = restored.getAgentContext("first");
    expect(context.piSessionFile).toBe(path.join(context.sessionDirectory, "history.jsonl"));
    expect(context.piSessionFile?.startsWith(moved)).toBe(true);
  });

  it("persists the person's name across restarts, rejects invalid input, and clears it for every Wisp", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-profile-"));
    const repository = await reload(directory);
    await seedConversations(repository, { first: chat("first"), second: chat("second") });
    await repository.saveUserProfile({ preferredName: "  Ada   Lovelace " });
    const restored = await reload(directory);
    expect(restored.getUserProfile()).toEqual({ preferredName: "Ada Lovelace" });
    for (const context of restored.listAgentContexts()) {
      expect(context.userName).toBe("Ada Lovelace");
    }
    await expect(restored.saveUserProfile({ preferredName: "x".repeat(81) })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(restored.getUserProfile()).toEqual({ preferredName: "Ada Lovelace" });
    await restored.saveUserProfile({ preferredName: "" });
    expect((await reload(directory)).getUserProfile()).toEqual({ preferredName: "" });
    expect(restored.getAgentContext("first").userName).toBeUndefined();
  });

  it("reads the name from a profile file that still holds fields earlier versions wrote", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-profile-fields-"));
    await writeFile(
      path.join(directory, "user-profile.json"),
      JSON.stringify({ preferredName: "Ada", aboutYou: "Developer", responsePreferences: "Brief" }),
    );
    expect((await reload(directory)).getUserProfile()).toEqual({ preferredName: "Ada" });
  });

  it("writes a deleted Wisp's memory into its archive and keeps the person's", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-memory-delete-"));
    const repository = await reload(directory);
    await seedConversations(repository, { first: chat("first"), second: chat("second") });
    await repository.applyMemory("first", [
      { op: "add", scope: "user", text: "Backend developer" },
      { op: "add", scope: "wisp", text: "Works on Wisp Bot." },
    ]);
    await repository.close();
    const restored = await reload(directory);

    await restored.deleteWisp("first");

    const [archive] = await readdir(path.join(directory, "deleted-conversations"));
    expect(await readFile(path.join(directory, "deleted-conversations", archive!, "MEMORY.md"), "utf8")).toBe(
      "# MEMORY.md\n\n- Works on Wisp Bot.\n",
    );
    expect(storedRows(directory, "SELECT scope, wisp_id, text FROM memory_entries")).toEqual([
      { scope: "user", wisp_id: null, text: "Backend developer" },
    ]);
  });

  it("lets the person change a Wisp's memory, as the owner, and export it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-memory-settings-"));
    const repository = await reload(directory);
    await seedConversations(repository, { first: chat("first"), second: chat("second") });

    const view = await repository.applyMemory("first", [
      { op: "add", scope: "user", text: "Prefers short answers." },
      { op: "add", scope: "wisp", text: "Works on Wisp Bot." },
    ]);
    expect(view.entries.map(({ id, scope, text, source }) => [id, scope, text, source])).toEqual([
      ["m1", "user", "Prefers short answers.", "owner"],
      ["m2", "wisp", "Works on Wisp Bot.", "owner"],
    ]);
    expect(view.usage).toEqual([
      { scope: "user", used: 22, limit: 1500 },
      { scope: "wisp", used: 18, limit: 4000 },
    ]);
    // The person's entries reach every Wisp; the Wisp's stay its own.
    expect((await repository.getMemory("second")).entries.map(({ id }) => id)).toEqual(["m1"]);
    expect(await repository.exportMemory("first", "wisp")).toEqual({
      fileName: "MEMORY.md",
      markdown: "# MEMORY.md\n\n- Works on Wisp Bot.\n",
    });

    await expect(
      repository.applyMemory("first", [{ op: "add", scope: "user", text: "Prefers short answers." }]),
    ).rejects.toMatchObject({ code: "invalid_request", message: "Memory already has this as m1." });
    await expect(repository.applyMemory("second", [{ op: "remove", id: "m2" }])).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(repository.getMemory("missing")).rejects.toMatchObject({ code: "not_found" });
  });

  it("lets the person change their own memory without a Wisp, which every Wisp then sees", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-memory-person-"));
    const repository = await reload(directory);
    await seedConversations(repository, { first: chat("first") });
    await repository.applyMemory("first", [{ op: "add", scope: "wisp", text: "Works on Wisp Bot." }]);

    const view = await repository.applyMemory(undefined, [
      { op: "add", scope: "user", text: "Prefers short answers." },
    ]);
    expect(view.entries.map(({ id, scope, text }) => [id, scope, text])).toEqual([
      ["m2", "user", "Prefers short answers."],
    ]);
    expect(view.usage).toEqual([{ scope: "user", used: 22, limit: 1500 }]);
    expect((await repository.getMemory("first")).entries.map(({ id }) => id)).toEqual(["m2", "m1"]);
    expect(await repository.exportMemory(undefined, "user")).toEqual({
      fileName: "USER.md",
      markdown: "# USER.md\n\n- Prefers short answers.\n",
    });

    await expect(repository.applyMemory(undefined, [{ op: "remove", id: "m1" }])).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(repository.exportMemory(undefined, "wisp")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refuses to start on memory saved by a newer version, leaving the database in place", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-memory-newer-"));
    const repository = await reload(directory);
    await seedConversations(repository, { first: chat("first") });
    await repository.close();
    const db = new DatabaseSync(path.join(directory, "conversations.sqlite"));
    db.exec("UPDATE memory_meta SET value = '99' WHERE key = 'schema_version'");
    db.close();

    await expect(reload(directory)).rejects.toBeInstanceOf(IntactDatabaseError);
    expect(await readdir(directory)).toContain("conversations.sqlite");
  });

  it("keeps the reported time zone across restarts and gives every Wisp the current one", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-time-zone-"));
    const repository = await reload(directory);
    await seedConversations(repository, { first: chat("first") });
    const context = repository.getAgentContext("first");
    await repository.saveUserTimeZone("Asia/Tokyo");
    expect(context.userTimeZone?.()).toBe("Asia/Tokyo");
    await expect(repository.saveUserTimeZone("Mars/Olympus")).rejects.toMatchObject({ code: "invalid_request" });
    const restored = await reload(directory);
    expect(restored.getUserTimeZone()).toBe("Asia/Tokyo");
    expect(restored.getAgentContext("first").userTimeZone?.()).toBe("Asia/Tokyo");
  });

  it("includes the configured user name in every agent context", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-user-context-"));
    const repository = new ConversationRepository({ dataDirectory: directory, userName: "  John\nDoe  " });
    await seedConversations(repository, { first: chat("first"), second: chat("second") });

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
    await repository.createWisp(newWisp("plain"), { notifyOnUpdatesEnabled: true, modelOverride: null });
    const override = { providerId: "anthropic", modelId: "claude-sonnet-4-5", maxOutputTokens: 2048 };
    await repository.createWisp(newWisp("custom"), { notifyOnUpdatesEnabled: true, modelOverride: override });

    expect(repository.getAgentContext("plain").modelOverride).toBeNull();
    expect(repository.getAgentContext("custom").modelOverride).toEqual(override);

    const restored = new ConversationRepository({ dataDirectory: directory });
    await restored.load();
    expect(restored.getAgentContext("custom").modelOverride).toEqual(override);
    expect(restored.getAgentContext("plain").modelOverride).toBeNull();
  });

  it("gives each conversation its creation time, which survives a restart and later changes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-created-at-"));
    let now = new Date("2026-10-01T10:00:00.000Z");
    const repository = new ConversationRepository({ dataDirectory: directory, now: () => now });
    await repository.load();
    await repository.createWisp(newWisp("first"), { notifyOnUpdatesEnabled: true, modelOverride: null });
    now = new Date("2026-10-02T10:00:00.000Z");
    await repository.create({ ...circle("team", ["first"]), createdAt: "2020-01-01T00:00:00.000Z" });
    now = new Date("2026-10-03T10:00:00.000Z");
    await repository.markUnread("first");

    expect(repository.getChats().first?.createdAt).toBe("2026-10-01T10:00:00.000Z");
    // The backend decides when a conversation was created, not the client.
    expect(repository.getChats().team?.createdAt).toBe("2026-10-02T10:00:00.000Z");

    const restored = await reload(directory);
    expect(restored.getChats().first?.createdAt).toBe("2026-10-01T10:00:00.000Z");
    expect(restored.getChats().team?.createdAt).toBe("2026-10-02T10:00:00.000Z");
  });

  it("rejects invalid model overrides and a Wisp's conversation created without its Wisp", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-create-override-invalid-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.load();

    await expect(
      repository.createWisp(newWisp("bad"), {
        notifyOnUpdatesEnabled: true,
        modelOverride: { providerId: "", modelId: "claude-sonnet-4-5" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      repository.create({
        id: "orphan",
        kind: "wisp",
        wispId: "orphan",
        notifyOnUpdatesEnabled: true,
        preview: "",
        messages: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    expect(repository.getChats()).toEqual({});
    expect(repository.readWisps()).toEqual({});
  });

  it("creates a Wisp with its own conversation, folders, and session, and changes it apart from them", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-create-"));
    let nextId = 0;
    const repository = new ConversationRepository({ dataDirectory: directory, createId: () => `id-${++nextId}` });
    await repository.load();
    await repository.createWisp(newWisp("atlas"), { notifyOnUpdatesEnabled: false });

    expect(repository.readWisps().atlas).toEqual(newWisp("atlas"));
    expect(repository.getChats().atlas).toMatchObject({
      kind: "wisp",
      wispId: "atlas",
      notifyOnUpdatesEnabled: false,
      preview: "Ready for the first task.",
    });
    const context = repository.getAgentContext("atlas");
    // The Wisp's settings, the conversation's workspace, and the session each have their own folder.
    expect(context).toMatchObject({
      wispId: "atlas",
      role: "Test",
      soul: "A test Wisp",
      configDirectory: path.join(directory, "wisp-config", "id-1"),
      workspaceDirectory: path.join(directory, "workspaces", "id-2"),
      sessionDirectory: path.join(directory, "wisp-sessions", "id-3"),
    });
    expect(repository.getWispStorageId("atlas")).toBe("id-1");

    await repository.updateWisp("atlas", { soul: "# Identity\nA careful researcher", color: "#123456" });
    await repository.updateWisp("atlas", { color: undefined });
    // Memory off leaves the Wisp's agent without memory; on again, the field is gone (SWE-228).
    await repository.updateWisp("atlas", { memoryOff: true });
    expect(repository.readWisps().atlas?.memoryOff).toBe(true);
    expect(repository.getAgentContext("atlas")).toMatchObject({ memoryOff: true });
    expect(repository.getAgentContext("atlas").memory).toBeUndefined();
    expect((await reload(directory)).readWisps().atlas?.memoryOff).toBe(true);
    await repository.updateWisp("atlas", { memoryOff: false });
    expect(repository.getAgentContext("atlas").memory).toBeDefined();
    const restored = await reload(directory);
    expect(restored.readWisps().atlas).toEqual({ ...newWisp("atlas"), soul: "# Identity\nA careful researcher" });
    expect(restored.getAgentContext("atlas").soul).toBe("# Identity\nA careful researcher");
    await expect(restored.updateWisp("missing", { name: "Ghost" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("upserts stable message IDs without duplicating streamed lifecycle updates", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-message-upsert-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await seedConversations(repository, { first: chat("first") });

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

  it("archives workspace and session data on explicit deletion", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-delete-"));
    const repository = new ConversationRepository({
      dataDirectory: directory,
      createId: () => "stable-session",
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    await seedConversations(repository, { first: chat("first") });
    const [storageId] = await readdir(path.join(directory, "wisp-config"));
    const cache = path.join(directory, "wisp-config", storageId!, "transcription-cache");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "entry.json"), JSON.stringify({ text: "Scanned contract" }));

    await repository.deleteWisp("first");

    expect(repository.getChats()).toEqual({});
    expect(repository.readWisps()).toEqual({});
    const archives = await readdir(path.join(directory, "deleted-conversations"));
    expect(archives).toHaveLength(1);
    const contents = await readdir(path.join(directory, "deleted-conversations", archives[0]!));
    expect(contents.sort()).toEqual(["archive.json", "wisp-config", "wisp-session", "workspace"]);
    // Storage names the archive from its manifest; the folder name is only an ID.
    expect(
      JSON.parse(await readFile(path.join(directory, "deleted-conversations", archives[0]!, "archive.json"), "utf8")),
    ).toEqual({ name: "first", kind: "wisp", archivedAt: "2026-08-30T12:00:00.000Z" });
    // Image transcriptions are deleted outright rather than archived.
    expect(await readdir(path.join(directory, "deleted-conversations", archives[0]!, "wisp-config"))).not.toContain(
      "transcription-cache",
    );
  });

  it("deletes a Wisp's conversation only with the Wisp", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-conversation-delete-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await seedConversations(repository, { first: chat("first") });

    await expect(repository.delete("first")).rejects.toMatchObject({ code: "invalid_request" });

    expect(repository.getChats().first).toMatchObject({ id: "first" });
    expect(repository.readWisps()).toHaveProperty("first");
  });

  it("gives circle members sessions in the shared workspace, and archives those of members who leave", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-circle-sessions-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await seedConversations(repository, { atlas: chat("atlas"), nova: chat("nova"), orion: chat("orion") });
    await repository.saveUserProfile({ preferredName: "Ada" });
    await repository.create({ ...circle("crew", ["atlas", "nova"]), name: "Crew", description: "Launch" });

    const context = repository.getCircleAgentContext("crew");
    expect(context).toMatchObject({ kind: "circle", conversationId: "crew", userName: "Ada" });
    expect(context.members.map(({ wispId }) => wispId)).toEqual(["atlas", "nova"]);
    const [atlas, nova] = context.members;
    expect(atlas).toMatchObject({
      conversationId: "crew",
      wispId: "atlas",
      configDirectory: repository.getAgentContext("atlas").configDirectory,
      circle: {
        name: "Crew",
        description: "Launch",
        members: [
          { id: "atlas", name: "atlas", role: "Test" },
          { id: "nova", name: "nova", role: "Test" },
        ],
      },
    });
    // One workspace for the circle, and its size, a session folder for each member.
    expect(nova!.workspaceDirectory).toBe(atlas!.workspaceDirectory);
    const circleFolders = repository.getWorkspaceDirectories("crew");
    expect(circleFolders.workspaceDirectory).toBe(atlas!.workspaceDirectory);
    expect(path.dirname(circleFolders.settingsDirectory)).toBe(path.join(directory, "circle-config"));
    expect(atlas!.workspaceSettingsDirectory).toBe(circleFolders.settingsDirectory);
    expect(nova!.workspaceSettingsDirectory).toBe(circleFolders.settingsDirectory);
    expect(repository.getWorkspaceDirectories("atlas")).toEqual({
      workspaceDirectory: repository.getAgentContext("atlas").workspaceDirectory,
      settingsDirectory: repository.getAgentContext("atlas").configDirectory,
    });
    expect(nova!.workspaceDirectory).not.toBe(repository.getAgentContext("nova").workspaceDirectory);
    expect(nova!.sessionDirectory).not.toBe(atlas!.sessionDirectory);
    await expect(readdir(atlas!.sessionDirectory)).resolves.toEqual([]);
    expect(repository.listCirclesOf("nova")).toEqual(["crew"]);
    expect(repository.listCircleSessionDirectories("nova")).toEqual([nova!.sessionDirectory]);

    await atlas!.savePiSessionIdentity!({ sessionId: "pi-atlas", sessionFile: null });
    expect(repository.getCircleAgentContext("crew").members[0]).toMatchObject({ piSessionId: "pi-atlas" });
    expect(repository.getAgentContext("atlas").piSessionId).toBeNull();

    await writeFile(path.join(nova!.sessionDirectory, "session.jsonl"), "{}\n");
    await repository.update("crew", { kind: "circle", memberIds: ["orion", "atlas"] });

    const updated = repository.getCircleAgentContext("crew");
    expect(updated.members.map(({ wispId }) => wispId)).toEqual(["orion", "atlas"]);
    expect(updated.members[1]!.sessionId).toBe(atlas!.sessionId);
    await expect(readdir(updated.members[0]!.sessionDirectory)).resolves.toEqual([]);
    expect(repository.listCirclesOf("nova")).toEqual([]);
    const [archive] = await readdir(path.join(directory, "deleted-conversations"));
    const archived = path.join(directory, "deleted-conversations", archive!);
    await expect(readFile(path.join(archived, "wisp-session", "session.jsonl"), "utf8")).resolves.toBe("{}\n");
    expect(JSON.parse(await readFile(path.join(archived, "archive.json"), "utf8"))).toMatchObject({
      name: "nova in Crew",
      kind: "circle",
    });
  });

  it("archives a circle's workspace when it is deleted", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-circle-delete-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await seedConversations(repository, { first: chat("first") });
    await repository.create(circle("crew", ["first"]));
    const { settingsDirectory } = repository.getWorkspaceDirectories("crew");
    await mkdir(settingsDirectory, { recursive: true });
    await writeFile(path.join(settingsDirectory, "workspace-settings.json"), '{"quotaBytes":1}');

    await repository.delete("crew");

    expect(Object.keys(repository.getChats())).toEqual(["first"]);
    const [archive] = await readdir(path.join(directory, "deleted-conversations"));
    // With the session its member had there (ADR 011).
    expect((await readdir(path.join(directory, "deleted-conversations", archive!))).sort()).toEqual([
      "archive.json",
      "circle-config",
      "wisp-session",
      "workspace",
    ]);
    expect(
      JSON.parse(await readFile(path.join(directory, "deleted-conversations", archive!, "archive.json"), "utf8")),
    ).toMatchObject({ name: "crew", kind: "circle" });
  });

  it("persists member pruning in the same deletion transaction", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-member-delete-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await seedConversations(repository, {
      first: chat("first"),
      second: chat("second"),
      crew: { ...chat("crew", true), memberIds: ["second", "first"] },
    });

    await repository.deleteWisp("first");

    expect(repository.getChats().crew).toMatchObject({ memberIds: ["second"] });
    const restored = new ConversationRepository({ dataDirectory: directory });
    await restored.load();
    expect(restored.getChats().crew).toMatchObject({ memberIds: ["second"] });
  });

  it("normalizes and persists an ordered circle membership replacement", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-member-update-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await seedConversations(repository, {
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
    await seedConversations(repository, {
      first: chat("first"),
      crew: { ...chat("crew", true), memberIds: ["first"] },
    });

    await expect(repository.update("crew", { kind: "circle", memberIds: ["missing"] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(repository.getChats().crew).toMatchObject({ memberIds: ["first"] });
  });

  it("rejects invalid circle membership as one graph", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-invalid-graph-"));
    const repository = new ConversationRepository({ dataDirectory: directory });

    await seedConversations(repository, { first: chat("first") });
    await expect(repository.create({ ...chat("crew", true), memberIds: ["first", "first"] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(repository.create({ ...chat("crew", true), memberIds: ["missing"] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(Object.keys(repository.getChats())).toEqual(["first"]);
  });

  it("rolls back in-memory state when persistence cannot complete", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-write-failure-"));
    const blockedPath = path.join(directory, "not-a-directory");
    await writeFile(blockedPath, "blocked", "utf8");
    const repository = new ConversationRepository({ dataDirectory: blockedPath });

    await expect(seedConversations(repository, { first: chat("first") })).rejects.toBeDefined();

    expect(repository.isInitialized()).toBe(false);
    expect(repository.getChats()).toEqual({});
  });

  it("rolls back every kind of mutation when a later write fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-rollback-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.load();
    await seedConversations(repository, { first: chat("first") });
    const before = repository.list();
    const wispsBefore = structuredClone(repository.readWisps());
    const { sessionDirectory } = repository.getAgentContext("first");
    // Every write to either table now aborts, as a full disk or I/O error would.
    const saboteur = new DatabaseSync(path.join(directory, "conversations.sqlite"));
    saboteur.exec(`
      CREATE TRIGGER fail_message_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'disk full'); END;
      CREATE TRIGGER fail_message_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'disk full'); END;
      CREATE TRIGGER fail_conversation_update BEFORE UPDATE ON conversations BEGIN SELECT RAISE(ABORT, 'disk full'); END;
      CREATE TRIGGER fail_wisp_update BEFORE UPDATE ON wisps BEGIN SELECT RAISE(ABORT, 'disk full'); END;
    `);
    saboteur.close();

    await expect(
      repository.appendMessage("first", { id: "reply", type: "incoming", text: "Not saved" }),
    ).rejects.toBeDefined();
    await expect(
      repository.setModelOverride("first", { providerId: "anthropic", modelId: "claude-sonnet-5" }),
    ).rejects.toBeDefined();
    await expect(repository.setFallback("first", "off")).rejects.toBeDefined();
    await expect(
      repository.savePiSessionIdentity("first", {
        sessionId: "pi-new",
        sessionFile: path.join(sessionDirectory, "history.jsonl"),
      }),
    ).rejects.toBeDefined();
    await expect(repository.updateWisp("first", { name: "Renamed" })).rejects.toBeDefined();
    await expect(repository.update("first", { kind: "wisp", unread: true })).rejects.toBeDefined();

    expect(repository.list()).toEqual(before);
    expect(repository.readWisps()).toEqual(wispsBefore);
    expect(repository.getAgentContext("first").modelOverride).toBeNull();
    expect(repository.getAgentContext("first").fallback).toBeNull();
    // Nothing partial reached the disk either.
    const restored = await reload(directory);
    expect(restored.list()).toEqual(before);
    expect(restored.readWisps()).toEqual(wispsBefore);
  });

  it("restores every kind of change after a restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-round-trip-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.load();
    await seedConversations(repository, { first: chat("first"), second: chat("second") });
    await repository.create(circle("circle", ["first", "second"]));
    await repository.appendMessage("first", { id: "reply", type: "incoming", text: "Streaming", status: "streaming" });
    await repository.appendMessage("first", { id: "reply", type: "incoming", text: "Done", status: "complete" });
    await repository.appendMessage("first", {
      id: "question",
      type: "prompt",
      question: "Proceed?",
      options: [{ key: "yes", label: "Yes" }],
    });
    await repository.answerPrompt("first", "question", "yes");
    await repository.updateWisp("first", { name: "Renamed" });
    await repository.update("first", { kind: "wisp", unread: true });
    await repository.markRead("first");
    await repository.setModelOverride("first", { providerId: "openrouter", modelId: "openai/gpt-oss-120b" });
    await repository.setFallback("first", { providerId: "anthropic", modelId: "claude-sonnet-5" });
    const { sessionDirectory } = repository.getAgentContext("first");
    await repository.savePiSessionIdentity("first", {
      sessionId: "pi-first",
      sessionFile: path.join(sessionDirectory, "history.jsonl"),
    });
    await repository.deleteWisp("second");
    await repository.close();

    const restarted = await reload(directory);

    expect(restarted.list()).toEqual(repository.list());
    expect(restarted.readWisps()).toEqual(repository.readWisps());
    expect(restarted.readWisps().first?.name).toBe("Renamed");
    expect(restarted.getAgentContext("first").modelOverride).toEqual({
      providerId: "openrouter",
      modelId: "openai/gpt-oss-120b",
    });
    expect(restarted.getAgentContext("first").fallback).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-5",
    });
    expect(restarted.getChats().circle).toMatchObject({ memberIds: ["first"] });
    expect(restarted.getChats().first?.messages.map(({ id }) => id)).toEqual(["first:message:0", "reply", "question"]);
  });

  it("keeps the newest messages when a conversation reaches its limit", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-message-limit-"));
    const limit = CONVERSATION_STORAGE_POLICY.maxMessagesPerConversation;
    const full: Message[] = Array.from({ length: limit }, (_, index) => ({
      id: `m${index}`,
      type: "incoming",
      text: `Message ${index}`,
    }));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await seedConversations(repository, { first: { ...chat("first"), messages: full } });

    await repository.appendMessage("first", { id: "newest", type: "outgoing", text: "Still sends" });

    for (const current of [repository, await reload(directory)]) {
      const ids = current.getChats().first!.messages.map(({ id }) => id);
      expect(ids).toHaveLength(limit);
      expect(ids[0]).toBe("m1");
      expect(ids.at(-1)).toBe("newest");
    }
  });

  it("preserves a database that is not a database and starts fresh", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-corrupt-db-"));
    await writeFile(path.join(directory, "conversations.sqlite"), "definitely not sqlite", "utf8");
    const repository = new ConversationRepository({ dataDirectory: directory });

    await repository.load();

    expect(repository.didRecoverCorruptState()).toBe(true);
    expect(repository.isInitialized()).toBe(false);
    expect((await readdir(directory)).some((name) => name.startsWith("conversations.sqlite.corrupt-"))).toBe(true);
    await seedConversations(repository, { first: chat("first") });
    expect(Object.keys((await reload(directory)).getChats())).toEqual(["first"]);
  });

  it("refuses a database from a newer app version and leaves it in place", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-newer-db-"));
    const file = path.join(directory, "conversations.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;");
    db.exec("INSERT INTO meta VALUES ('store_version', '99')");
    db.close();
    const repository = new ConversationRepository({ dataDirectory: directory });

    await expect(repository.load()).rejects.toThrow("saved by a newer version of Wisp Bot");

    expect(repository.didRecoverCorruptState()).toBe(false);
    expect((await readdir(directory)).filter((name) => name.startsWith("conversations.sqlite"))).toEqual([
      "conversations.sqlite",
    ]);
  });

  it("keeps each chat's last activity, never moving it backwards", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-last-activity-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    const earlier = { id: "earlier", type: "incoming" as const, text: "A", createdAt: "2026-09-10T10:00:00.000Z" };
    await seedConversations(repository, {
      first: { ...chat("first"), messages: [earlier] },
    });
    expect(repository.getChats().first?.lastActivityAt).toBe(earlier.createdAt);

    await repository.appendMessage("first", {
      id: "newer",
      type: "outgoing",
      text: "B",
      createdAt: "2026-09-12T08:00:00.000Z",
    });
    // A late status update for an older message must not move activity back.
    await repository.appendMessage("first", { ...earlier, status: "complete" });

    expect(repository.getChats().first?.lastActivityAt).toBe("2026-09-12T08:00:00.000Z");
    expect((await reload(directory)).getChats().first?.lastActivityAt).toBe("2026-09-12T08:00:00.000Z");
  });

  it("reads pages through the repository and reports missing conversations and messages", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-repository-pages-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await seedConversations(repository, { first: chat("first") });

    await expect(repository.getMessagePage({ conversationId: "first", page: "latest" })).resolves.toEqual({
      messages: [expect.objectContaining({ id: "first:message:0", text: "Hello", status: "complete" })],
      olderCursor: null,
      newerCursor: null,
    });
    await expect(repository.getMessagePage({ conversationId: "missing", page: "latest" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      repository.getMessagePage({ conversationId: "first", page: "around", messageId: "gone" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports whether a write added a message or updated one, with the stored message", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-message-changes-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await seedConversations(repository, { first: chat("first") });

    await expect(
      repository.appendMessage("first", { id: "reply", type: "incoming", text: "Streaming", status: "streaming" }),
    ).resolves.toMatchObject({ added: true, message: { id: "reply", text: "Streaming" } });
    await expect(
      repository.appendMessage("first", { id: "reply", type: "incoming", text: "Done", status: "complete" }),
    ).resolves.toMatchObject({ added: false, message: { id: "reply", text: "Done" } });
    await expect(
      repository.appendOutgoingMessage("first", { id: "request-1", type: "outgoing", text: "Hi" }),
    ).resolves.toMatchObject({ added: true, message: { id: "request-1" } });
    await repository.appendMessage("first", {
      id: "question",
      type: "prompt",
      question: "Proceed?",
      options: [{ key: "yes", label: "Yes" }],
    });
    await expect(repository.answerPrompt("first", "question", "yes")).resolves.toMatchObject({
      id: "question",
      answer: "yes",
    });
  });

  it("updates delivery status only for stored outgoing messages", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-outgoing-status-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await seedConversations(repository, { first: chat("first") });
    await repository.appendMessage("first", { id: "request-1", type: "outgoing", text: "Hi", status: "queued" });

    await expect(repository.setOutgoingStatus("first", "request-1", "complete")).resolves.toMatchObject({
      id: "request-1",
      status: "complete",
    });
    await expect(repository.setOutgoingStatus("first", "first:message:0", "failed")).resolves.toBeUndefined();
    await expect(repository.setOutgoingStatus("first", "missing", "failed")).resolves.toBeUndefined();

    await expect(repository.getMessage("first", "request-1")).resolves.toMatchObject({ status: "complete" });
    await expect(repository.getMessage("first", "first:message:0")).resolves.toMatchObject({ status: "complete" });
  });
});
