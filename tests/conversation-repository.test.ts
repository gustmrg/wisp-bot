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
