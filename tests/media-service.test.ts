import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConversationMediaService } from "../backend/media-service.js";
import type { Message } from "../shared/conversations.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setUp(messages: Record<string, Message>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisp-media-"));
  directories.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "shots"), { recursive: true });
  await writeFile(path.join(workspace, "shots", "page.jpg"), "jpeg bytes");
  await writeFile(path.join(root, "outside.txt"), "private");
  await symlink(path.join(root, "outside.txt"), path.join(workspace, "link.txt"));
  const service = new ConversationMediaService({
    getMessage: async (_conversationId, messageId) => messages[messageId],
    getWorkspaceDirectory: () => workspace,
  });
  const read = async (messageId: string, mediaPath: string, maxBytes?: number) => {
    const opened = await service.open({
      conversationId: "atlas",
      messageId,
      path: mediaPath,
      ...(maxBytes === undefined ? {} : { maxBytes }),
    });
    try {
      return { ...opened, file: undefined, contents: (await opened.file.readFile()).toString() };
    } finally {
      await opened.file.close();
    }
  };
  return { read };
}

const reply = (text: string): Message => ({ id: "reply", type: "incoming", text, status: "complete" });

describe("ConversationMediaService", () => {
  it("opens a file the Wisp's message shows", async () => {
    const { read } = await setUp({ reply: reply('Here it is: <media src="/workspace/shots/page.jpg" />') });
    expect(await read("reply", "shots/page.jpg")).toEqual({
      name: "page.jpg",
      mimeType: "image/jpeg",
      size: 10,
      file: undefined,
      contents: "jpeg bytes",
    });
    await expect(read("reply", "./shots/page.jpg", 4)).rejects.toMatchObject({ code: "too_large" });
  });

  it("refuses files the message does not show, the person's messages and paths outside the workspace", async () => {
    const { read } = await setUp({
      reply: reply("![](link.txt) ![](../outside.txt) ![](shots/missing.png)"),
      mine: { id: "mine", type: "outgoing", text: "![](shots/page.jpg)" },
    });
    await expect(read("reply", "shots/page.jpg")).rejects.toMatchObject({ code: "not_found" });
    await expect(read("mine", "shots/page.jpg")).rejects.toMatchObject({ code: "not_found" });
    await expect(read("unknown", "shots/page.jpg")).rejects.toMatchObject({ code: "not_found" });
    await expect(read("reply", "link.txt")).rejects.toMatchObject({ code: "not_found" });
    await expect(read("reply", "../outside.txt")).rejects.toMatchObject({ code: "not_found" });
    await expect(read("reply", "shots/missing.png")).rejects.toMatchObject({ code: "not_found" });
  });
});
