import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ConversationRepository } from "../electron/backend/conversation-repository.js";
import type { Chat } from "../shared/conversations.js";

function chat(id: string, isCircle = false): Chat {
  return {
    id,
    name: id,
    label: "Test",
    description: "A test conversation",
    shape: "circle",
    isCircle,
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    timestamp: "Now",
    messages: [{ type: "incoming", text: "Hello" }],
  };
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
    expect(restored.getAgentContext("first")).toEqual(expect.objectContaining({
      piSessionId: "pi-history-id",
      piSessionFile,
    }));
    await expect(restored.savePiSessionIdentity("first", {
      sessionId: "unsafe-history",
      sessionFile: path.join(directory, "outside.jsonl"),
    })).rejects.toMatchObject({ code: "invalid_request" });
    expect(restored.getAgentContext("first").piSessionId).toBe("pi-history-id");
  });

  it("upgrades Phase 3 records without losing their stable application session", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-schema-upgrade-"));
    await writeFile(path.join(directory, "conversations.json"), JSON.stringify({
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
    }), "utf8");
    const repository = new ConversationRepository({ dataDirectory: directory });

    await repository.load();

    expect(repository.getAgentContext("first")).toEqual(expect.objectContaining({
      sessionId: "stable-app-session",
      piSessionId: null,
      piSessionFile: null,
    }));
    const persisted = JSON.parse(await readFile(path.join(directory, "conversations.json"), "utf8")) as { schemaVersion: number };
    expect(persisted.schemaVersion).toBe(2);
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
    });
    await repository.appendMessage("first", {
      id: "request-1:assistant",
      type: "incoming",
      text: "Complete response",
      status: "complete",
    });

    const matching = repository.getChats().first?.messages.filter(({ id }) => id === "request-1:assistant");
    expect(matching).toEqual([expect.objectContaining({ text: "Complete response", status: "complete" })]);
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

  it("rolls back in-memory state when persistence cannot complete", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-write-failure-"));
    const blockedPath = path.join(directory, "not-a-directory");
    await writeFile(blockedPath, "blocked", "utf8");
    const repository = new ConversationRepository({ dataDirectory: blockedPath });

    await expect(repository.initialize({ first: chat("first") })).rejects.toBeDefined();

    expect(repository.isInitialized()).toBe(false);
    expect(repository.getChats()).toEqual({});
  });
});
