import { describe, expect, it, vi } from "vitest";

import { RoutingSessionFactory } from "../backend/claude-code/routing-session-factory.js";
import type { ConversationAgentContext } from "../backend/conversation-agent.js";
import type { JobSessionFactory } from "../backend/job-runner.js";
import type { RuntimeSessionFactory } from "../backend/runtime-session.js";
import { ownConversation } from "../backend/integration-tool-source.js";

describe("RoutingSessionFactory", () => {
  const piSession = { kind: "pi" };
  const claudeSession = { kind: "claude-code" };
  const pi = {
    resolveModel: vi.fn(() => ({ id: "gpt" })),
    create: vi.fn(async () => piSession),
    createJobSession: vi.fn(async () => ({ kind: "pi-job" })),
    getToolRevision: vi.fn(async () => "rev-1"),
  } as unknown as RuntimeSessionFactory & JobSessionFactory;
  const claudeCode = {
    resolveModel: vi.fn(() => ({ id: "sonnet" })),
    create: vi.fn(async () => claudeSession),
    createJobSession: vi.fn(async () => ({ kind: "claude-code-job" })),
  };
  const factory = new RoutingSessionFactory(pi, claudeCode as never);
  const context = { conversationId: "c1" } as ConversationAgentContext;
  const claude = { providerId: "claude-code", modelId: "sonnet" };
  const openai = { providerId: "openai", modelId: "gpt" };

  it("gives Wisps on claude-code Claude Code sessions and every other Wisp Pi's", async () => {
    await expect(factory.create(context, claude)).resolves.toBe(claudeSession);
    await expect(factory.create(context, openai)).resolves.toBe(piSession);
    expect(factory.resolveModel(claude)).toEqual({ id: "sonnet" });
    expect(factory.resolveModel(openai)).toEqual({ id: "gpt" });
    await expect(factory.getToolRevision(ownConversation("c1"))).resolves.toBe("rev-1");
  });

  it("runs a Wisp's jobs on the same runtime as its conversations", async () => {
    const job = { runId: "r1", runDirectory: "/runs", tools: [], skills: [], runTools: [] };

    await expect(factory.createJobSession(context, claude, job)).resolves.toEqual({ kind: "claude-code-job" });
    await expect(factory.createJobSession(context, openai, job)).resolves.toEqual({ kind: "pi-job" });
  });

  it("tells when a model change needs another kind of session", () => {
    expect(factory.sameRuntime(openai, { providerId: "openrouter", modelId: "x" })).toBe(true);
    expect(factory.sameRuntime(claude, { ...claude, modelId: "opus" })).toBe(true);
    expect(factory.sameRuntime(openai, claude)).toBe(false);
  });
});
