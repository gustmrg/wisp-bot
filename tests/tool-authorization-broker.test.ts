import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { evaluateToolPolicy, ToolAuthorizationBroker } from "../backend/tool-authorization-broker.js";
import { ToolPolicyStore } from "../backend/tool-policy-store.js";
import type { ConversationAgentEvent } from "../shared/contracts.js";
import type { ToolPolicySettings } from "../shared/tool-policy.js";

describe("tool policy", () => {
  it("recovers a corrupt persisted policy to safe defaults", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-policy-corrupt-"));
    const policyPath = path.join(directory, "policy.json");
    await writeFile(policyPath, "{bad policy", "utf8");
    const store = new ToolPolicyStore(policyPath);

    await store.load();

    expect(store.get()).toEqual({ autoReview: true, rules: [] });
    expect((await readdir(directory)).some((name) => name.includes(".corrupt-"))).toBe(true);
    expect(evaluateToolPolicy(store.get(), "modify_file")).toBe("ask");
  });

  it("migrates a legacy unscoped allow rule to ask", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-policy-legacy-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    const migrated = await store.save({
      autoReview: true,
      rules: [{ id: "legacy", action: "create_file", behavior: "allow" }],
    });

    expect(migrated.rules).toEqual([{ id: "legacy", action: "create_file", behavior: "ask", scope: "workspace" }]);
    expect(evaluateToolPolicy(migrated, "create_file")).toBe("ask");
  });

  it("uses conservative precedence and blocks shell and unknown categories", () => {
    const settings = {
      autoReview: true,
      rules: [
        { id: "allow", action: "all_file_changes", behavior: "allow" as const, scope: "workspace" as const },
        { id: "ask", action: "modify_file", behavior: "ask" as const, scope: "workspace" as const },
        { id: "block", action: "modify files", behavior: "block" as const, scope: "workspace" as const },
      ],
    };

    expect(evaluateToolPolicy(settings, "read")).toBe("allow");
    expect(evaluateToolPolicy(settings, "create_file")).toBe("allow");
    expect(evaluateToolPolicy(settings, "modify_file")).toBe("block");
    expect(evaluateToolPolicy(settings, "shell")).toBe("block");
    expect(evaluateToolPolicy(settings, "unknown")).toBe("block");
    expect(evaluateToolPolicy({ ...settings, autoReview: false }, "create_file")).toBe("ask");
    expect(evaluateToolPolicy(settings, "create_file", "external_path")).toBe("ask");
  });

  it("requires approval for external writes regardless of workspace allows and auto-review", () => {
    const settings: ToolPolicySettings = {
      autoReview: true,
      rules: [
        { id: "workspace", action: "external_write", behavior: "allow", scope: "workspace" },
        { id: "integration", action: "external_write", behavior: "allow", scope: "integration" },
      ],
    };
    expect(evaluateToolPolicy(settings, "external_write", "integration")).toBe("ask");
    expect(evaluateToolPolicy({ ...settings, autoReview: false }, "external_write", "integration")).toBe("ask");
    expect(evaluateToolPolicy(settings, "external_write", "workspace_path")).toBe("block");
  });

  it("persists external blocks separately and honors them when file auto-review is disabled", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-integration-approval-"));
    const policyPath = path.join(directory, "policy.json");
    const store = new ToolPolicyStore(policyPath);
    await store.save({ autoReview: false, rules: [] });
    const events: ConversationAgentEvent[] = [];
    let nextId = 0;
    const broker = new ToolAuthorizationBroker(store, (event) => events.push(event), {
      createId: () => `external-${++nextId}`,
      selectWindowId: () => 7,
    });
    const action = {
      conversationId: "one",
      toolCallId: "linear-1",
      toolName: "linear_update_issue",
      category: "external_write" as const,
      scope: { kind: "integration" as const, value: "Linear" },
      summary: "Update issue ENG-42",
    };
    const authorization = broker.authorize(action);
    const rejected = expect(authorization).rejects.toMatchObject({ code: "tool_blocked" });
    expect(events[0]).toMatchObject({
      type: "tool_approval_requested",
      request: {
        toolName: "linear_update_issue",
        category: "external_write",
        scope: { kind: "integration", display: "Linear" },
      },
    });
    await broker.resolve(
      { approvalId: "external-1", conversationId: "one", toolCallId: "linear-1", decision: "block" },
      7,
    );
    await rejected;
    const reopened = new ToolPolicyStore(policyPath);
    await reopened.load();
    expect(reopened.get().rules).toEqual([
      { id: "external-2", action: "external_write", behavior: "block", scope: "integration" },
    ]);
    expect(evaluateToolPolicy(reopened.get(), "external_write", "integration")).toBe("block");
    expect(evaluateToolPolicy(reopened.get(), "modify_file")).toBe("ask");
    await expect(broker.authorize({ ...action, toolCallId: "linear-2" })).rejects.toMatchObject({
      code: "tool_blocked",
    });
    expect(broker.listPending()).toEqual([]);
    broker.dispose();
  });

  it("normalizes an integration allow rule to ask without granting file access", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-integration-policy-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    const settings = await store.save({
      autoReview: true,
      rules: [
        { id: "integration-allow", action: "external_write", behavior: "allow", scope: "integration" },
        { id: "misplaced-file-allow", action: "all_file_changes", behavior: "allow", scope: "integration" },
      ],
    });
    expect(settings.rules.every(({ behavior, scope }) => behavior === "ask" && scope === "integration")).toBe(true);
    expect(evaluateToolPolicy(settings, "modify_file")).toBe("ask");
  });

  it("binds a single-use approval to its window, conversation, and tool call", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    const events: ConversationAgentEvent[] = [];
    const broker = new ToolAuthorizationBroker(store, (event) => events.push(event), {
      createId: () => "approval-1",
      now: () => new Date("2026-08-31T12:00:00.000Z"),
      selectWindowId: () => 7,
    });
    const authorization = broker.authorize({
      conversationId: "one",
      toolCallId: "tool-1",
      toolName: "write",
      category: "create_file",
      scope: { kind: "workspace_path", value: "notes.txt" },
      summary: "Create\nnotes.txt with hidden content that is never included",
    });
    const requested = events[0];
    expect(requested).toMatchObject({
      type: "tool_approval_requested",
      request: {
        approvalId: "approval-1",
        conversationId: "one",
        toolCallId: "tool-1",
        summary: "Create notes.txt with hidden content that is never included",
      },
    });

    await expect(
      broker.resolve(
        {
          approvalId: "approval-1",
          conversationId: "one",
          toolCallId: "tool-1",
          decision: "allow_once",
        },
        8,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await broker.resolve(
      {
        approvalId: "approval-1",
        conversationId: "one",
        toolCallId: "tool-1",
        decision: "allow_once",
      },
      7,
    );
    await expect(authorization).resolves.toBeUndefined();
    await expect(
      broker.resolve(
        {
          approvalId: "approval-1",
          conversationId: "one",
          toolCallId: "tool-1",
          decision: "allow_once",
        },
        7,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("always asks for skill changes, shows their content, and refuses lasting decisions", async () => {
    const settings: ToolPolicySettings = {
      autoReview: true,
      rules: [
        { id: "a", action: "save_skill", behavior: "allow", scope: "workspace" },
        { id: "b", action: "all file changes", behavior: "allow", scope: "workspace" },
      ],
    };
    expect(evaluateToolPolicy(settings, "save_skill", "skill")).toBe("ask");
    expect(evaluateToolPolicy(settings, "save_skill", "workspace_path")).toBe("block");
    expect(evaluateToolPolicy({ autoReview: false, rules: [] }, "save_skill", "skill")).toBe("ask");

    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    await store.save(settings);
    const events: ConversationAgentEvent[] = [];
    const broker = new ToolAuthorizationBroker(store, (event) => events.push(event), {
      createId: () => "approval-skill",
      selectWindowId: () => 7,
    });
    const authorization = broker.authorize({
      conversationId: "one",
      toolCallId: "tool-1",
      toolName: "save_skill",
      category: "save_skill",
      scope: { kind: "skill", value: "weekly-report" },
      summary: "Create skill weekly-report: Builds the weekly report",
      preview: "1. Collect issues\n2. Summarize\u0007",
    });
    expect(events[0]).toMatchObject({
      type: "tool_approval_requested",
      request: {
        category: "save_skill",
        scope: { kind: "skill", display: "weekly-report" },
        preview: "1. Collect issues\n2. Summarize",
      },
    });
    const resolution = { approvalId: "approval-skill", conversationId: "one", toolCallId: "tool-1" };
    await expect(broker.resolve({ ...resolution, decision: "allow_always" }, 7)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(broker.resolve({ ...resolution, decision: "block" }, 7)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(store.get().rules).toHaveLength(2);
    await broker.resolve({ ...resolution, decision: "deny" }, 7);
    await expect(authorization).rejects.toMatchObject({ code: "tool_blocked" });
  });

  it("expires stale approvals and persists an explicit block decision", async () => {
    vi.useFakeTimers();
    try {
      const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-expiry-"));
      const store = new ToolPolicyStore(path.join(directory, "policy.json"));
      let nextId = 0;
      const broker = new ToolAuthorizationBroker(store, () => undefined, {
        approvalTtlMs: 10,
        createId: () => `id-${++nextId}`,
        selectWindowId: () => 1,
      });
      const expired = broker.authorize({
        conversationId: "one",
        toolCallId: "tool-expire",
        toolName: "edit",
        category: "modify_file",
        scope: { kind: "workspace_path", value: "file.txt" },
        summary: "Modify file.txt",
      });
      const expiredExpectation = expect(expired).rejects.toMatchObject({ code: "approval_expired" });
      await vi.advanceTimersByTimeAsync(11);
      await expiredExpectation;

      const blocked = broker.authorize({
        conversationId: "one",
        toolCallId: "tool-block",
        toolName: "edit",
        category: "modify_file",
        scope: { kind: "workspace_path", value: "file.txt" },
        summary: "Modify file.txt",
      });
      const blockedExpectation = expect(blocked).rejects.toMatchObject({ code: "tool_blocked" });
      await broker.resolve(
        {
          approvalId: "id-2",
          conversationId: "one",
          toolCallId: "tool-block",
          decision: "block",
        },
        1,
      );
      await blockedExpectation;
      expect(evaluateToolPolicy(store.get(), "modify_file")).toBe("block");
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves a lasting Allow rule for one file category and keeps the other category asking", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-always-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    let nextId = 0;
    const broker = new ToolAuthorizationBroker(store, () => undefined, {
      createId: () => `id-${++nextId}`,
      selectWindowId: () => 1,
    });
    const authorization = broker.authorize({
      conversationId: "one",
      toolCallId: "tool-create",
      toolName: "write",
      category: "create_file",
      scope: { kind: "workspace_path", value: "notes.txt" },
      summary: "Create notes.txt",
    });
    await broker.resolve(
      { approvalId: "id-1", conversationId: "one", toolCallId: "tool-create", decision: "allow_always" },
      1,
    );
    await expect(authorization).resolves.toBeUndefined();
    expect(evaluateToolPolicy(store.get(), "create_file")).toBe("allow");
    expect(evaluateToolPolicy(store.get(), "modify_file")).toBe("ask");
    await expect(
      broker.authorize({
        conversationId: "one",
        toolCallId: "tool-create-2",
        toolName: "write",
        category: "create_file",
        scope: { kind: "workspace_path", value: "other.txt" },
        summary: "Create other.txt",
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses a lasting Allow for integrations or while auto-review is off", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-always-refused-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    let nextId = 0;
    const broker = new ToolAuthorizationBroker(store, () => undefined, {
      createId: () => `id-${++nextId}`,
      selectWindowId: () => 1,
    });
    const integration = broker.authorize({
      conversationId: "one",
      toolCallId: "tool-linear",
      toolName: "linear_update_issue",
      category: "external_write",
      scope: { kind: "integration", value: "Linear issue ENG-1" },
      summary: "Update ENG-1",
    });
    await expect(
      broker.resolve(
        { approvalId: "id-1", conversationId: "one", toolCallId: "tool-linear", decision: "allow_always" },
        1,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    // The refused decision leaves the request pending for a valid answer.
    await broker.resolve({ approvalId: "id-1", conversationId: "one", toolCallId: "tool-linear", decision: "deny" }, 1);
    await expect(integration).rejects.toMatchObject({ code: "tool_blocked" });

    await store.save({ autoReview: false, rules: [] });
    const file = broker.authorize({
      conversationId: "one",
      toolCallId: "tool-edit",
      toolName: "edit",
      category: "modify_file",
      scope: { kind: "workspace_path", value: "notes.txt" },
      summary: "Edit notes.txt",
    });
    await expect(
      broker.resolve(
        { approvalId: "id-2", conversationId: "one", toolCallId: "tool-edit", decision: "allow_always" },
        1,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await broker.resolve(
      { approvalId: "id-2", conversationId: "one", toolCallId: "tool-edit", decision: "allow_once" },
      1,
    );
    await expect(file).resolves.toBeUndefined();
    expect(store.get().rules).toEqual([]);
  });

  it("remembers an always-allowed MCP tool through its integration and never over a Block rule", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-mcp-always-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    const events: ConversationAgentEvent[] = [];
    let nextId = 0;
    const broker = new ToolAuthorizationBroker(store, (event) => events.push(event), {
      createId: () => `id-${++nextId}`,
      selectWindowId: () => 1,
    });
    const rememberApproval = vi.fn(async () => undefined);
    const call = {
      conversationId: "one",
      toolCallId: "tool-mcp",
      toolName: "mcp_test_search",
      category: "integration_call" as const,
      scope: { kind: "integration" as const, value: "Docs" },
      summary: "search — query: wisp",
    };

    const asked = broker.authorize({ ...call, rememberApproval });
    expect(events[0]).toMatchObject({ type: "tool_approval_requested", request: { alwaysAllowTool: true } });
    await broker.resolve(
      { approvalId: "id-1", conversationId: "one", toolCallId: "tool-mcp", decision: "allow_always" },
      1,
    );
    await expect(asked).resolves.toBeUndefined();
    expect(rememberApproval).toHaveBeenCalledTimes(1);
    // The decision belongs to the integration: no policy rule is written.
    expect(store.get().rules).toEqual([]);

    // A remembered tool runs without a card.
    events.length = 0;
    await expect(broker.authorize({ ...call, alwaysAllowed: true })).resolves.toBeUndefined();
    expect(events).toEqual([]);

    // A Block rule still wins over a remembered tool.
    await store.blockCategory("integration_call", () => "rule-1");
    await expect(broker.authorize({ ...call, alwaysAllowed: true })).rejects.toMatchObject({ code: "tool_blocked" });

    // Other categories cannot use the integration's remembered approval.
    await store.save({ autoReview: true, rules: [] });
    events.length = 0;
    const write = broker.authorize({
      ...call,
      toolCallId: "tool-write",
      category: "external_write",
      alwaysAllowed: true,
      rememberApproval,
    });
    expect(events[0]).toMatchObject({ type: "tool_approval_requested" });
    expect((events[0] as { request: { alwaysAllowTool?: boolean } }).request.alwaysAllowTool).toBeUndefined();
    const writeId = (events[0] as { request: { approvalId: string } }).request.approvalId;
    await expect(
      broker.resolve(
        { approvalId: writeId, conversationId: "one", toolCallId: "tool-write", decision: "allow_always" },
        1,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await broker.resolve({ approvalId: writeId, conversationId: "one", toolCallId: "tool-write", decision: "deny" }, 1);
    await expect(write).rejects.toMatchObject({ code: "tool_blocked" });
    expect(rememberApproval).toHaveBeenCalledTimes(1);
  });

  it("allows the call even when the integration cannot remember it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-mcp-always-failed-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    const broker = new ToolAuthorizationBroker(store, () => undefined, {
      createId: () => "id-1",
      selectWindowId: () => 1,
    });
    const asked = broker.authorize({
      conversationId: "one",
      toolCallId: "tool-mcp",
      toolName: "mcp_test_search",
      category: "integration_call",
      scope: { kind: "integration", value: "Docs" },
      summary: "search",
      rememberApproval: async () => {
        throw new Error("changed");
      },
    });
    await expect(
      broker.resolve(
        { approvalId: "id-1", conversationId: "one", toolCallId: "tool-mcp", decision: "allow_always" },
        1,
      ),
    ).rejects.toThrow("changed");
    await expect(asked).resolves.toBeUndefined();
  });

  it("stores a blocked MCP tool call as an integration rule", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-mcp-block-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    await store.blockCategory("integration_call", () => "rule-1");
    expect(store.get().rules).toEqual([
      { id: "rule-1", action: "integration_call", behavior: "block", scope: "integration" },
    ]);
    expect(evaluateToolPolicy(store.get(), "integration_call", "integration")).toBe("block");
  });

  it("settles a blocked approval once even when the decision arrives twice", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-double-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    const published: ConversationAgentEvent[] = [];
    const audit = { append: vi.fn() };
    const broker = new ToolAuthorizationBroker(store, (event) => published.push(event), {
      createId: () => "approval-1",
      selectWindowId: () => 1,
      audit,
    });
    const action = broker.authorize({
      conversationId: "one",
      toolCallId: "tool-1",
      toolName: "edit",
      category: "modify_file",
      scope: { kind: "workspace_path", value: "file.txt" },
      summary: "Modify file.txt",
    });
    const actionExpectation = expect(action).rejects.toMatchObject({ code: "tool_blocked" });
    const decision = {
      approvalId: "approval-1",
      conversationId: "one",
      toolCallId: "tool-1",
      decision: "block",
    } as const;

    // A double click sends the second decision while the first is still saving the block rule.
    const results = await Promise.allSettled([broker.resolve(decision, 1), broker.resolve(decision, 1)]);

    await actionExpectation;
    expect(results.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
    expect(published.filter(({ type }) => type === "tool_approval_resolved")).toHaveLength(1);
    expect(audit.append.mock.calls.filter(([entry]) => entry.actor === "user")).toHaveLength(1);
  });

  it("blocks the action even when the block rule cannot be saved", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-save-failure-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    vi.spyOn(store, "blockCategory").mockRejectedValue(new Error("disk full"));
    const broker = new ToolAuthorizationBroker(store, () => undefined, {
      createId: () => "approval-1",
      selectWindowId: () => 1,
    });
    const action = broker.authorize({
      conversationId: "one",
      toolCallId: "tool-1",
      toolName: "edit",
      category: "modify_file",
      scope: { kind: "workspace_path", value: "file.txt" },
      summary: "Modify file.txt",
    });
    const actionExpectation = expect(action).rejects.toMatchObject({ code: "tool_blocked" });

    await expect(
      broker.resolve({ approvalId: "approval-1", conversationId: "one", toolCallId: "tool-1", decision: "block" }, 1),
    ).rejects.toThrow("disk full");

    await actionExpectation;
    expect(broker.listPending()).toEqual([]);
  });

  it("cancels a pending approval when the tool execution is aborted", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-abort-"));
    const events: ConversationAgentEvent[] = [];
    const broker = new ToolAuthorizationBroker(
      new ToolPolicyStore(path.join(directory, "policy.json")),
      (event) => events.push(event),
      { createId: () => "approval-abort", selectWindowId: () => 1 },
    );
    const controller = new AbortController();
    const authorization = broker.authorize(
      {
        conversationId: "one",
        toolCallId: "tool-abort",
        toolName: "write",
        category: "create_file",
        scope: { kind: "workspace_path", value: "notes.txt" },
        summary: "Create notes.txt",
      },
      controller.signal,
    );
    const expectation = expect(authorization).rejects.toMatchObject({ code: "aborted" });
    controller.abort();
    await expectation;
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_approval_resolved",
        decision: "deny",
      }),
    );
  });

  it("cancels pending approvals when their conversation is deleted", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-delete-"));
    const broker = new ToolAuthorizationBroker(
      new ToolPolicyStore(path.join(directory, "policy.json")),
      () => undefined,
      { createId: () => "approval-delete", selectWindowId: () => 1 },
    );
    const authorization = broker.authorize({
      conversationId: "one",
      toolCallId: "tool-delete",
      toolName: "write",
      category: "create_file",
      scope: { kind: "workspace_path", value: "notes.txt" },
      summary: "Create notes.txt",
    });
    const expectation = expect(authorization).rejects.toMatchObject({ code: "aborted" });

    broker.cancelConversation("one");

    await expectation;
    expect(broker.listPending()).toEqual([]);
  });
});
