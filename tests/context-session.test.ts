import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };
import { ContextSession } from "../backend/context-session.js";
import { DEFAULT_CONTEXT_POLICY } from "../shared/context-policy.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-context-test-"));
  directories.push(directory);
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const manager = SessionManager.create(directory, directory);
  manager.appendMessage({ role: "user", content: "We selected option two: use SQLite", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "SQLite selected; migration remains pending." }],
    api: "openai-completions",
    provider: "openrouter",
    model: "test",
    usage: {
      input: 14000,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 14010,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const state = { messages: manager.buildSessionContext().messages };
  const session = {
    sessionManager: manager,
    state,
    get messages() {
      return state.messages;
    },
    refreshContext() {
      state.messages = manager.buildSessionContext().messages;
    },
    isIdle: true,
    getContextUsage: () => ({ tokens: 14010 }),
    compact: vi.fn(async () => ({ summary: "SQLite selected. Migration pending." })),
  };
  const settingsPath = path.join(directory, "settings.json");
  const onRenewed = vi.fn();
  const control = new ContextSession(
    session as unknown as AgentSession,
    settingsPath,
    onRenewed,
    () => new Date(Date.now() + 25 * 3600000),
  );
  await control.load();
  return { control, session, settingsPath, manager, onRenewed };
}
describe("context continuity", () => {
  it("summarizes before a return after inactivity, with continuity instructions", async () => {
    const { control, session } = await fixture();
    await control.beforePrompt();
    expect(session.compact).toHaveBeenCalledWith(expect.stringMatching(/decisions.*preferences.*pending work/));
    session.compact.mockRejectedValueOnce(new Error("provider failed"));
    await expect(control.beforePrompt()).rejects.toThrow("provider failed");
    expect(session.state.messages).toHaveLength(2);
  });
  it("does not interrupt active work", async () => {
    const { control, session } = await fixture();
    session.isIdle = false;
    await expect(control.command({ action: "compact" })).rejects.toThrow(/finish/);
    await expect(control.command({ action: "new_topic" })).rejects.toThrow(/finish/);
    expect(session.compact).not.toHaveBeenCalled();
    expect(session.state.messages).toHaveLength(2);
  });
  it("persists memory and policy separately, including across a new topic and restart", async () => {
    const { control, session, manager, settingsPath, onRenewed } = await fixture();
    await control.command({
      action: "save",
      policy: { ...DEFAULT_CONTEXT_POLICY, idleHours: 48 },
      memory: "Use Portuguese",
    });
    await control.command({ action: "new_topic" });
    expect(session.state.messages).toHaveLength(0);
    expect(control.view().summary).toBeNull();
    expect(control.view().tokens).toBe(0);
    expect(control.search("SQLite")).toContain("migration remains pending");
    expect(onRenewed).toHaveBeenCalledWith("new_topic", expect.any(String));
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const restored = SessionManager.open(manager.getSessionFile()!);
    expect(restored.buildSessionContext().messages).toHaveLength(0);
    expect(restored.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
    const reloaded = new ContextSession(session as unknown as AgentSession, settingsPath, vi.fn());
    await reloaded.load();
    expect(reloaded.view()).toMatchObject({ memory: "Use Portuguese", policy: { idleHours: 48 } });
  });
  it("bounds history search results and excludes tool payloads", async () => {
    const { control } = await fixture();
    expect(control.search("missing word")).toMatch(/No matching/);
    expect(control.search(" ")).toMatch(/Enter words/);
    expect(control.search("SQLite").length).toBeLessThan(6500);
  });
});
