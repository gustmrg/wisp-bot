import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WispBackendError } from "../backend/backend-error.js";
import type { ConversationAgentContext } from "../backend/conversation-agent.js";
import type { EncryptionService } from "../backend/encrypted-credential-store.js";
import { createBackendRuntime } from "../backend/runtime.js";
import type { RuntimeJobSession } from "../backend/runtime-session.js";
import { ToolAuthorizationBroker } from "../backend/tool-authorization-broker.js";
import { ToolPolicyStore } from "../backend/tool-policy-store.js";
import { WispConsultationRunner, type ConsultationSessionFactory } from "../backend/wisp-consultation.js";
import { TOOLS_NEVER_IN_JOB_RUNS, WispSessionBuilder } from "../backend/wisp-session-plan.js";
import { WispToolPolicyStore } from "../backend/wisp-tool-policy-store.js";
import { WISP_TOOL_NAMES } from "../backend/wisp-tools.js";
import type { ConversationAgentEvent } from "../shared/contracts.js";
import type { WispsView } from "../shared/conversations.js";
import { DEFAULT_WISP_APPEARANCE } from "../shared/wisp-appearance.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeEncryption(): EncryptionService {
  return {
    isAvailable: () => true,
    encrypt: (plaintext: string) => Buffer.from(plaintext, "utf8").toString("base64"),
    decrypt: (ciphertext: string) => Buffer.from(ciphertext, "base64").toString("utf8"),
  };
}

describe("WispConsultationRunner", () => {
  it("runs a consultation in an isolated session, routes approvals to caller attributed to target, and disposes", async () => {
    const dir = await makeTempDir("wisp-consult-");
    const policyStore = new ToolPolicyStore(path.join(dir, "tool-policy.json"));
    await policyStore.load();
    const wispPolicies = new WispToolPolicyStore((wispId) => path.join(dir, "config", wispId));
    // Caller ("chief") has allowEverything, while target ("atlas") does NOT:
    // proves no privilege escalation from caller to consulted Wisp.
    await wispPolicies.save("chief", { files: { create_file: "allow", modify_file: "allow" }, allowEverything: true });
    await wispPolicies.save("atlas", { files: {}, allowEverything: false });

    const events: ConversationAgentEvent[] = [];
    const broker = new ToolAuthorizationBroker(policyStore, (event) => events.push(event), {
      selectWindowId: () => 1,
      wispPolicies,
    });

    const disposed = vi.fn();
    let receivedPrompt = "";
    let receivedRunDir = "";
    const sessionFactory: ConsultationSessionFactory = {
      createConsultationSession: vi.fn(async (_ctx, _sel, spec): Promise<RuntimeJobSession> => {
        receivedRunDir = spec.runDirectory;
        return {
          sessionFile: undefined,
          getActiveToolNames: () => ["read", "edit"],
          prompt: async (text, signal) => {
            receivedPrompt = text;
            // Target Wisp triggers a tool approval under its own wispId & conversationId.
            const approvalPromise = broker.authorize(
              {
                conversationId: "atlas",
                wispId: "atlas",
                toolCallId: "tc-1",
                toolName: "edit",
                category: "modify_file",
                scope: { kind: "workspace_path", value: "notes.md" },
                summary: "Edit notes.md",
              },
              signal,
            );
            // Approve the routed card (which must have appeared in caller's conversation "chief" with wispId "atlas").
            const pending = broker.listPending();
            expect(pending).toHaveLength(1);
            expect(pending[0]).toMatchObject({
              conversationId: "chief",
              wispId: "atlas",
              toolName: "edit",
            });
            await broker.resolve(
              {
                approvalId: pending[0]!.approvalId,
                conversationId: "chief",
                toolCallId: "tc-1",
                decision: "allow_once",
              },
              1,
            );
            await approvalPromise;
          },
          lastAssistantMessage: () => ({ text: "Atlas verified notes.md.", stopReason: "stop" }),
          usage: () => ({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 }),
          dispose: disposed,
        };
      }),
    };

    const runner = new WispConsultationRunner({
      sessionFactory,
      getContext: (wispId) =>
        ({
          conversationId: wispId,
          wispId,
          sessionId: `sess-${wispId}`,
          name: "Atlas",
          role: "Research",
          soul: "# Atlas",
          workspaceDirectory: path.join(dir, "ws", wispId),
          sessionDirectory: path.join(dir, "sessions", wispId),
          configDirectory: path.join(dir, "config", wispId),
          piSessionId: null,
          piSessionFile: null,
        }) as ConversationAgentContext,
      getSelection: async () => ({ providerId: "anthropic", modelId: "claude-sonnet" }),
      routeApprovals: (conversationId, run) => broker.routeApprovals(conversationId, run),
    });

    const reply = await runner.consult({
      callerConversationId: "chief",
      callerWispId: "chief",
      callerName: "Chief",
      callerRole: "Team builder",
      targetWispId: "atlas",
      message: "Check notes.md for release dates.",
    });

    expect(reply).toBe("Atlas verified notes.md.");
    expect(receivedPrompt).toContain("[Consultation from Chief (Team builder)]");
    expect(receivedPrompt).toContain("Check notes.md for release dates.");
    expect(receivedRunDir).toBe(path.join(dir, "sessions", "atlas", "consultations"));
    expect(disposed).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_approval_requested",
        conversationId: "chief",
        request: expect.objectContaining({ conversationId: "chief", wispId: "atlas" }),
      }),
    );
  });

  it("rejects self-calls, missing targets, and unconfigured targets", async () => {
    const runner = new WispConsultationRunner({
      sessionFactory: { createConsultationSession: vi.fn() },
      getContext: (wispId) => {
        if (wispId === "missing") throw new WispBackendError("not_found", "The Wisp was not found.");
        return { conversationId: wispId, wispId, name: "Atlas", sessionDirectory: "/tmp" } as ConversationAgentContext;
      },
      getSelection: async () => null,
      routeApprovals: (_id, run) => run(),
    });

    await expect(
      runner.consult({
        callerConversationId: "chief",
        callerWispId: "chief",
        callerName: "Chief",
        targetWispId: "chief",
        message: "Self",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    await expect(
      runner.consult({
        callerConversationId: "chief",
        callerWispId: "chief",
        callerName: "Chief",
        targetWispId: "missing",
        message: "Missing",
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    await expect(
      runner.consult({
        callerConversationId: "chief",
        callerWispId: "chief",
        callerName: "Chief",
        targetWispId: "atlas",
        message: "Unconfigured",
      }),
    ).rejects.toMatchObject({ code: "configuration_required" });
  });

  it("cancels cleanly when the caller's AbortSignal fires", async () => {
    const disposed = vi.fn();
    let promptSignal: AbortSignal | undefined;
    const runner = new WispConsultationRunner({
      sessionFactory: {
        createConsultationSession: async () => ({
          sessionFile: undefined,
          getActiveToolNames: () => [],
          prompt: (_text, signal) => {
            promptSignal = signal;
            return new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new WispBackendError("aborted", "cancelled")), {
                once: true,
              });
            });
          },
          lastAssistantMessage: () => undefined,
          usage: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }),
          dispose: disposed,
        }),
      },
      getContext: (wispId) =>
        ({ conversationId: wispId, wispId, name: "Atlas", sessionDirectory: "/tmp" }) as ConversationAgentContext,
      getSelection: async () => ({ providerId: "anthropic", modelId: "claude-sonnet" }),
      routeApprovals: (_id, run) => run(),
    });

    const controller = new AbortController();
    const pending = runner.consult(
      {
        callerConversationId: "chief",
        callerWispId: "chief",
        callerName: "Chief",
        targetWispId: "atlas",
        message: "Long task",
      },
      controller.signal,
    );

    await vi.waitFor(() => expect(promptSignal).toBeDefined());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(promptSignal?.aborted).toBe(true);
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("bounds consultations by timeout", async () => {
    vi.useFakeTimers();
    try {
      const disposed = vi.fn();
      const runner = new WispConsultationRunner({
        timeoutMs: 1_000,
        sessionFactory: {
          createConsultationSession: async () => ({
            sessionFile: undefined,
            getActiveToolNames: () => [],
            prompt: (_text, signal) =>
              new Promise<void>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
              }),
            lastAssistantMessage: () => undefined,
            usage: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }),
            dispose: disposed,
          }),
        },
        getContext: (wispId) =>
          ({ conversationId: wispId, wispId, name: "Atlas", sessionDirectory: "/tmp" }) as ConversationAgentContext,
        getSelection: async () => ({ providerId: "anthropic", modelId: "claude-sonnet" }),
        routeApprovals: (_id, run) => run(),
      });

      const pending = runner.consult({
        callerConversationId: "chief",
        callerWispId: "chief",
        callerName: "Chief",
        targetWispId: "atlas",
        message: "Slow question",
      });

      const assertion = expect(pending).rejects.toMatchObject({
        code: "aborted",
        message: "Atlas did not answer in time.",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(disposed).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WispSessionBuilder anti-recursion and job-run isolation", () => {
  it("excludes ask_wisp, manage_wisp tools, job tools, save_skill, and save_memory during consultations", async () => {
    const dir = await makeTempDir("wisp-builder-");
    const builder = new WispSessionBuilder({
      authorizationBroker: { authorize: vi.fn(async () => undefined) },
      jobs: {
        list: async () => [],
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        recordChange: vi.fn(),
      },
      wisps: {
        list: () => [],
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        settings: vi.fn(),
      },
    });
    const context: ConversationAgentContext = {
      conversationId: "atlas",
      wispId: "atlas",
      sessionId: "sess-atlas",
      name: "Atlas",
      role: "Research",
      soul: "# Atlas",
      workspaceDirectory: path.join(dir, "workspace"),
      sessionDirectory: path.join(dir, "session"),
      configDirectory: path.join(dir, "config"),
      piSessionId: null,
      piSessionFile: null,
    };

    const plan = await builder.plan(context, undefined, {
      consultation: { runId: "c1", runDirectory: path.join(dir, "consult"), callerName: "Chief" },
    });
    const tools = await builder.tools(context, plan, {
      consultation: { runId: "c1", runDirectory: path.join(dir, "consult"), callerName: "Chief" },
      searchHistory: () => undefined,
    });
    const allowed = await tools.getAllowedTools();

    expect(plan.wispTools).toEqual([]);
    expect(plan.jobTools).toEqual([]);
    expect(plan.systemPrompt()).toContain("## Consultation");
    expect(plan.systemPrompt()).toContain("Chief");

    for (const forbidden of [
      "ask_wisp",
      "create_wisp",
      "update_wisp",
      "delete_wisp",
      "create_circle",
      "update_circle",
      "list_wisps",
      "list_circles",
      "schedule_job",
      "list_jobs",
      "update_job",
      "cancel_job",
      "save_skill",
      "save_memory",
    ]) {
      expect(allowed).not.toContain(forbidden);
      expect(tools.registryNames).not.toContain(forbidden);
    }

    // Consulted Wisp still has its own workspace & skill reading tools.
    expect(allowed).toContain("read");
    expect(allowed).toContain("grep");
    expect(allowed).toContain("use_skill");
  });

  it("keeps all Wisp and circle tools out of job runs", () => {
    for (const name of WISP_TOOL_NAMES) {
      expect(TOOLS_NEVER_IN_JOB_RUNS.has(name)).toBe(true);
    }
  });
});

describe("BackendRuntime inspection security and circle sync", () => {
  it("never leaks plugin API keys, MCP auth headers, or secret endpoints in runtime inspection and pushes wispsChanged on circle updates", async () => {
    const dir = await makeTempDir("wisp-runtime-inspect-");
    const wispsChanged: WispsView[] = [];
    const runtime = await createBackendRuntime({
      dataDirectory: dir,
      encryption: makeEncryption(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      agentMode: "fake",
      appVersion: "1.0.0",
      allowModelNetwork: false,
      selectApprovalWindowId: () => 1,
      openExternal: async () => undefined,
      openPath: async () => undefined,
      selectFiles: async () => [],
      onAgentEvent: () => undefined,
      onConversationChanged: () => undefined,
      onWispsChanged: (view) => wispsChanged.push(view),
      onMcpSettingsChanged: () => undefined,
      onScheduledMessagesChanged: () => undefined,
      onMessageQueueChanged: () => undefined,
      onJobsChanged: () => undefined,
    });

    try {
      await runtime.conversations.initialize();
      await runtime.conversations.createWisp(
        { id: "atlas", name: "Atlas", role: "Research", soul: "# Atlas", appearance: DEFAULT_WISP_APPEARANCE },
        { notifyOnUpdatesEnabled: true },
      );

      // Save a skill and secret-backed plugin + MCP server.
      await runtime.workspace.importSkill({
        conversationId: "atlas",
        contents: "---\nname: web-brief\ndescription: Summarizes sources.\n---\nRead sources carefully.\n",
      });

      const SECRET_LINEAR_KEY = "lin_api_SUPER_SECRET_TOKEN_987654";
      const SECRET_MCP_HEADER = "Bearer mcp_SUPER_SECRET_HEADER_123456";
      const SECRET_MCP_ENDPOINT = "https://internal-secret-mcp.example.invalid/v1/mcp";

      await runtime.plugins.save({
        pluginId: "linear",
        enabled: true,
        apiKey: SECRET_LINEAR_KEY,
      });
      const pluginAccess = runtime.plugins.getAccess({ conversationId: "atlas" });
      await runtime.plugins.saveAccess({
        conversationId: "atlas",
        revision: pluginAccess.revision,
        grants: [{ pluginId: "linear", access: "write" }],
      });

      const mcpView = await runtime.mcp.save({
        name: "Internal Docs",
        endpoint: SECRET_MCP_ENDPOINT,
        authMode: "header",
        headerName: "Authorization",
        headerValue: SECRET_MCP_HEADER,
        enabled: true,
      });
      const serverId = mcpView.servers[0]!.serverId;
      const mcpAccess = runtime.mcp.getAccess({ conversationId: "atlas" });
      await runtime.mcp.saveAccess({
        conversationId: "atlas",
        revision: mcpAccess.revision,
        grants: [{ serverId, access: "use_with_approval" }],
      });

      // Verify McpService.getServerNames only exposes display names, never endpoints or auth headers.
      const names = runtime.mcp.getServerNames();
      expect(names.get(serverId)).toBe("Internal Docs");
      const serialized = JSON.stringify({
        names: [...names.entries()],
        pluginAccess: runtime.plugins.getAccess({ conversationId: "atlas" }),
        mcpAccess: runtime.mcp.getAccess({ conversationId: "atlas" }),
        skills: await runtime.workspace.listSkills("atlas"),
      });
      expect(serialized).not.toContain(SECRET_LINEAR_KEY);
      expect(serialized).not.toContain(SECRET_MCP_HEADER);
      expect(serialized).not.toContain(SECRET_MCP_ENDPOINT);

      // Verify circle creation and update emit wispsChanged to connected clients.
      const beforeCount = wispsChanged.length;
      await runtime.conversations.create({
        id: "circle-1",
        kind: "circle",
        name: "Team",
        label: "",
        description: "Shared work",
        memberIds: ["atlas"],
        notifyOnUpdatesEnabled: true,
        preview: "Ready",
        messages: [],
      });
      expect(wispsChanged.length).toBe(beforeCount + 1);
      expect(wispsChanged.at(-1)!.chats["circle-1"]).toMatchObject({ kind: "circle", name: "Team" });

      await runtime.conversations.update("circle-1", { kind: "circle", name: "Core Team", responder: "auto" });
      expect(wispsChanged.length).toBe(beforeCount + 2);
      expect(wispsChanged.at(-1)!.chats["circle-1"]).toMatchObject({
        kind: "circle",
        name: "Core Team",
        responder: "auto",
      });
    } finally {
      await runtime.dispose();
    }
  });
});
