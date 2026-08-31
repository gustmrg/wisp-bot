import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ToolAuthorizationBroker } from "../electron/backend/tool-authorization-broker.js";
import { ToolPolicyStore } from "../electron/backend/tool-policy-store.js";
import { registerToolPolicyHandlers } from "../electron/ipc/register-tool-policy-handlers.js";
import { WISP_IPC_CHANNELS } from "../shared/contracts.js";

describe("tool policy IPC", () => {
  it("validates settings and forwards only a bound approval response", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-policy-ipc-"));
    const broker = new ToolAuthorizationBroker(
      new ToolPolicyStore(path.join(directory, "policy.json")),
      () => undefined,
      { createId: () => "approval-1", selectWindowId: () => 10 },
    );
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler)),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    };
    const registration = registerToolPolicyHandlers(ipcMain as never, broker, () => true);
    const save = handlers.get(WISP_IPC_CHANNELS.saveToolPolicy)!;
    await expect(save({ sender: { id: 10 } }, {
      autoReview: true,
      rules: [{ id: "rule-1", action: "create_file", behavior: "allow" }],
    })).resolves.toMatchObject({ ok: true });
    await expect(save({ sender: { id: 10 } }, {
      autoReview: true,
      rules: [{ id: "bad id", action: "create_file", behavior: "allow" }],
    })).resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } });

    await broker.savePolicy({ autoReview: true, rules: [] });
    const authorization = broker.authorize({
      conversationId: "one",
      toolCallId: "tool-1",
      toolName: "write",
      category: "create_file",
      summary: "Create notes.txt",
    });
    const resolve = handlers.get(WISP_IPC_CHANNELS.resolveToolApproval)!;
    await expect(resolve({ sender: { id: 11 } }, {
      approvalId: "approval-1",
      conversationId: "one",
      toolCallId: "tool-1",
      decision: "allow_once",
    })).resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } });
    await expect(resolve({ sender: { id: 10 } }, {
      approvalId: "approval-1",
      conversationId: "one",
      toolCallId: "tool-1",
      decision: "allow_once",
    })).resolves.toMatchObject({ ok: true });
    await expect(authorization).resolves.toBeUndefined();
    registration.dispose();
  });
});
