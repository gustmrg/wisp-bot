import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import type { ConversationAgentContext } from "../backend/conversation-agent.js";
import type { ModelRuntimeLike } from "../backend/model-service.js";
import { SdkPiSessionFactory } from "../backend/pi-session-factory.js";
import { MAX_REPEATED_TOOL_FAILURES, repeatedFailureMessage, ToolLoopGuard } from "../backend/tool-loop-guard.js";
import { WispConversationAgent } from "../backend/wisp-conversation-agent.js";
import type { ConversationAgentEvent } from "../shared/contracts.js";
import { mcpToolAlias } from "../shared/mcp.js";
import { resetDynamicToolMetadata } from "../shared/tool-catalog.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  resetDynamicToolMetadata();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const failure = (toolName: string, text: string) => ({
  toolName,
  isError: true,
  result: { content: [{ type: "text", text }] },
});

describe("ToolLoopGuard", () => {
  it("trips on the same tool failing with the same error three times in a row", () => {
    const guard = new ToolLoopGuard();
    expect(guard.record(failure("linear", "Unauthorized"))).toBeUndefined();
    expect(guard.record(failure("linear", "Unauthorized"))).toBeUndefined();
    expect(guard.record(failure("linear", "Unauthorized"))).toEqual({ toolName: "linear", error: "Unauthorized" });
    expect(MAX_REPEATED_TOOL_FAILURES).toBe(3);
  });

  it("starts over on a success, another tool, or another error", () => {
    const guard = new ToolLoopGuard();
    const steps = [
      failure("linear", "Unauthorized"),
      failure("linear", "Unauthorized"),
      { toolName: "linear", isError: false, result: { content: [] } },
      failure("linear", "Unauthorized"),
      failure("linear", "Unauthorized"),
      failure("github", "Unauthorized"),
      failure("github", "Not found: a.md"),
      failure("github", "Not found: b.md"),
    ];
    expect(steps.map((step) => guard.record(step))).toEqual(steps.map(() => undefined));
  });

  it("ignores calls that ended without a result, as when a turn is stopped", () => {
    const guard = new ToolLoopGuard();
    guard.record(failure("read", "Missing"));
    guard.record(failure("read", "Missing"));
    expect(guard.record({ toolName: "read", isError: true })).toBeUndefined();
    expect(guard.record(failure("read", "Missing"))).toBeDefined();
  });

  it("names the tool and the error for the person", () => {
    expect(repeatedFailureMessage({ toolName: "unknown_tool", error: "Unauthorized" })).toBe(
      '"unknown_tool" failed 3 times in a row with the same error, so the Wisp stopped instead of trying again. The error: Unauthorized',
    );
  });
});

describe("a Wisp's turn in a real Pi session", () => {
  it("stops after the same tool fails the same way three times, without another model call", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-tool-loop-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { fauxAssistantMessage, fauxProvider, fauxToolCall } = await import("@earendil-works/pi-ai");
    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: null,
      modelsStorePath: path.join(directory, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const faux = fauxProvider({ provider: "wisp-test-faux", models: [{ id: "scripted" }] });
    runtime.registerNativeProvider(faux.provider);

    const tool = mcpToolAlias("linear-server", "create_issue");
    let calls = 0;
    const definition = {
      name: tool,
      label: "create_issue",
      description: "Create a Linear issue.",
      parameters: { type: "object", properties: { title: { type: "string" } } },
      execute: async () => {
        calls += 1;
        throw new Error("Unauthorized: the token was revoked.");
      },
    } as unknown as ToolDefinition;
    let modelCalls = 0;
    const respond = (message: ReturnType<typeof fauxAssistantMessage>) => () => {
      modelCalls += 1;
      return message;
    };
    const callTool = (title: string) =>
      respond(fauxAssistantMessage(fauxToolCall(tool, { title }), { stopReason: "toolUse" }));
    faux.setResponses([
      callTool("Bug"),
      callTool("Bug!"),
      callTool("Bug!!"),
      callTool("Bug!!!"),
      respond(fauxAssistantMessage("Done.")),
    ] as never);

    const factory = new SdkPiSessionFactory(runtime as unknown as ModelRuntimeLike, undefined, {
      getSnapshot: async () => ({
        definitions: [definition],
        metadata: [
          {
            name: tool,
            label: "Create issue",
            activityLabel: "Creating an issue…",
            category: "integration_call",
            group: "Linear",
            mcpServerId: "linear-server",
            sourceName: "create_issue",
          },
        ],
        activeNames: [tool],
        revision: "one",
      }),
    });
    const wisp = path.join(directory, "atlas");
    const context: ConversationAgentContext = {
      conversationId: "atlas",
      sessionId: "atlas",
      name: "Atlas",
      wispId: "atlas",
      role: "Research",
      soul: "Finds things.",
      workspaceDirectory: path.join(wisp, "workspace"),
      sessionDirectory: path.join(wisp, "sessions"),
      configDirectory: path.join(wisp, "config"),
    };
    await Promise.all(
      [context.workspaceDirectory, context.sessionDirectory, context.configDirectory].map((target) =>
        mkdir(target, { recursive: true }),
      ),
    );
    const agent = new WispConversationAgent(context, factory, { flushDelayMs: 0 });
    cleanups.push(() => agent.dispose());
    const events: ConversationAgentEvent[] = [];
    agent.subscribe((event) => events.push(event));
    await agent.start();
    await agent.applyModel({ providerId: "wisp-test-faux", modelId: "scripted" });

    await agent.send({ conversationId: "atlas", requestId: "m1", text: "Open a bug in Linear." });

    expect(calls).toBe(3);
    expect(modelCalls).toBe(3);
    const errors = events.filter((event) => event.type === "conversation_error");
    expect(errors).toEqual([
      expect.objectContaining({
        requestId: "m1",
        error: expect.objectContaining({
          message: expect.stringContaining("failed 3 times in a row with the same error, so the Wisp stopped"),
          retryable: false,
        }),
      }),
    ]);
    expect(JSON.stringify(errors)).toContain("Unauthorized: the token was revoked.");
    // A failure, not a Stop.
    expect(events.some((event) => event.type === "assistant_message_cancelled")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "conversation_status", status: "idle" });

    // The next message starts with a clean count and runs normally.
    await agent.send({ conversationId: "atlas", requestId: "m2", text: "Never mind." });
    expect(modelCalls).toBe(5);
  });
});
