import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { evaluateToolPolicy, ToolAuthorizationBroker } from "../backend/tool-authorization-broker.js";
import { ToolPolicyStore } from "../backend/tool-policy-store.js";
import { WispToolPolicyStore } from "../backend/wisp-tool-policy-store.js";
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

  it("runs container commands without asking, unless a rule blocks them, and only in a container", () => {
    const settings: ToolPolicySettings = { autoReview: false, rules: [] };
    expect(evaluateToolPolicy(settings, "container_command", "container")).toBe("allow");
    expect(evaluateToolPolicy(settings, "container_command", "workspace_path")).toBe("block");
    expect(evaluateToolPolicy(settings, "container_command", "integration")).toBe("block");
    const blocked: ToolPolicySettings = {
      autoReview: true,
      rules: [{ id: "block", action: "container_command", behavior: "block", scope: "workspace" }],
    };
    expect(evaluateToolPolicy(blocked, "container_command", "container")).toBe("block");
    // Pi's own shell stays blocked whatever the scope.
    expect(evaluateToolPolicy(settings, "shell", "container")).toBe("block");
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
      wispId: "one",
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
      wispId: "one",
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
      wispId: "one",
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

  it("always asks for memory changes, shows them, and refuses lasting decisions (ADR 029)", async () => {
    const settings: ToolPolicySettings = {
      autoReview: true,
      rules: [{ id: "a", action: "save_memory", behavior: "allow", scope: "workspace" }],
    };
    expect(evaluateToolPolicy(settings, "save_memory", "memory")).toBe("ask");
    expect(evaluateToolPolicy(settings, "save_memory", "workspace_path")).toBe("block");

    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-memory-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    await store.save(settings);
    const events: ConversationAgentEvent[] = [];
    const broker = new ToolAuthorizationBroker(store, (event) => events.push(event), {
      createId: () => "approval-memory",
      selectWindowId: () => 7,
    });
    const authorization = broker.authorize({
      conversationId: "one",
      wispId: "one",
      toolCallId: "tool-1",
      toolName: "save_memory",
      category: "save_memory",
      scope: { kind: "memory", value: "About you" },
      summary: "Add to About you: Prefers short answers.",
      preview: "Add to About you: Prefers short answers.",
    });
    expect(events[0]).toMatchObject({
      type: "tool_approval_requested",
      request: { category: "save_memory", scope: { kind: "memory", display: "About you" } },
    });
    const resolution = { approvalId: "approval-memory", conversationId: "one", toolCallId: "tool-1" };
    for (const decision of ["allow_always", "block"] as const) {
      await expect(broker.resolve({ ...resolution, decision }, 7)).rejects.toMatchObject({ code: "invalid_request" });
    }
    await broker.resolve({ ...resolution, decision: "allow_once" }, 7);
    await expect(authorization).resolves.toBeUndefined();

    // A job run never writes memory, even if its grant names the tool.
    await broker.runUnattended({ conversationId: "one", approvedTools: new Set(["save_memory"]) }, async () => {
      await expect(
        broker.authorize({
          conversationId: "one",
          wispId: "one",
          toolCallId: "tool-2",
          toolName: "save_memory",
          category: "save_memory",
          scope: { kind: "memory", value: "This Wisp" },
          summary: "Remove from This Wisp: Old.",
        }),
      ).rejects.toMatchObject({ code: "tool_blocked" });
    });
  });

  it("expires stale approvals and persists an explicit block decision", async () => {
    vi.useFakeTimers();
    try {
      const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-expiry-"));
      const store = new ToolPolicyStore(path.join(directory, "policy.json"));
      const wispPolicies = new WispToolPolicyStore(() => directory);
      let nextId = 0;
      const broker = new ToolAuthorizationBroker(store, () => undefined, {
        approvalTtlMs: 10,
        createId: () => `id-${++nextId}`,
        selectWindowId: () => 1,
        wispPolicies,
      });
      const expired = broker.authorize({
        conversationId: "one",
        wispId: "one",
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
        wispId: "one",
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
      // A file block belongs to this Wisp; the app-wide policy is unchanged.
      expect(wispPolicies.get("one").files).toEqual({ modify_file: "block" });
      expect(evaluateToolPolicy(store.get(), "modify_file")).toBe("ask");
    } finally {
      vi.useRealTimers();
    }
  });

  it("remembers a lasting Allow for one file category for this Wisp only", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-always-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    const wispPolicies = new WispToolPolicyStore((conversationId) => path.join(directory, conversationId));
    const events: ConversationAgentEvent[] = [];
    let nextId = 0;
    const broker = new ToolAuthorizationBroker(store, (event) => events.push(event), {
      createId: () => `id-${++nextId}`,
      selectWindowId: () => 1,
      wispPolicies,
    });
    const create = (conversationId: string, toolCallId: string) =>
      broker.authorize({
        conversationId,
        wispId: conversationId,
        toolCallId,
        toolName: "write",
        category: "create_file",
        scope: { kind: "workspace_path", value: "notes.txt" },
        summary: "Create notes.txt",
      });
    const authorization = create("one", "tool-create");
    await broker.resolve(
      { approvalId: "id-1", conversationId: "one", toolCallId: "tool-create", decision: "allow_always" },
      1,
    );
    await expect(authorization).resolves.toBeUndefined();
    expect(wispPolicies.get("one").files).toEqual({ create_file: "allow" });
    expect(store.get().rules).toEqual([]);
    events.length = 0;
    await expect(create("one", "tool-create-2")).resolves.toBeUndefined();
    expect(events).toEqual([]);
    // Another Wisp still asks.
    void create("two", "tool-create-3").catch(() => undefined);
    expect(events[0]).toMatchObject({ type: "tool_approval_requested" });
    broker.dispose();
  });

  it("refuses a lasting Allow an integration cannot remember, and remembers files even with auto-review off", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-always-refused-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    const wispPolicies = new WispToolPolicyStore(() => directory);
    let nextId = 0;
    const broker = new ToolAuthorizationBroker(store, () => undefined, {
      createId: () => `id-${++nextId}`,
      selectWindowId: () => 1,
      wispPolicies,
    });
    const integration = broker.authorize({
      conversationId: "one",
      wispId: "one",
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
      wispId: "one",
      toolCallId: "tool-edit",
      toolName: "edit",
      category: "modify_file",
      scope: { kind: "workspace_path", value: "notes.txt" },
      summary: "Edit notes.txt",
    });
    await expect(
      broker.resolve(
        { approvalId: "id-2", conversationId: "one", toolCallId: "tool-edit", decision: "allow_integration" },
        1,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await broker.resolve(
      { approvalId: "id-2", conversationId: "one", toolCallId: "tool-edit", decision: "allow_always" },
      1,
    );
    await expect(file).resolves.toBeUndefined();
    expect(store.get().rules).toEqual([]);
    expect(wispPolicies.get("one").files).toEqual({ modify_file: "allow" });
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
      wispId: "one",
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

    // Plugin writes honor their integration's remembered approval too.
    await store.save({ autoReview: true, rules: [] });
    events.length = 0;
    await expect(
      broker.authorize({ ...call, toolCallId: "tool-write", category: "external_write", alwaysAllowed: true }),
    ).resolves.toBeUndefined();
    expect(events).toEqual([]);

    // Other categories cannot use an integration's remembered approval.
    const file = broker.authorize({
      ...call,
      toolCallId: "tool-file",
      category: "modify_file",
      scope: { kind: "workspace_path", value: "notes.txt" },
      alwaysAllowed: true,
      rememberApproval,
    });
    expect(events[0]).toMatchObject({ type: "tool_approval_requested" });
    expect((events[0] as { request: { alwaysAllowTool?: boolean } }).request.alwaysAllowTool).toBeUndefined();
    const fileId = (events[0] as { request: { approvalId: string } }).request.approvalId;
    await broker.resolve({ approvalId: fileId, conversationId: "one", toolCallId: "tool-file", decision: "deny" }, 1);
    await expect(file).rejects.toMatchObject({ code: "tool_blocked" });
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
      wispId: "one",
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
      wispPolicies: new WispToolPolicyStore(() => directory),
    });
    const action = broker.authorize({
      conversationId: "one",
      wispId: "one",
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

    // A double click sends the second decision while the first is still saving the block.
    const results = await Promise.allSettled([broker.resolve(decision, 1), broker.resolve(decision, 1)]);

    await actionExpectation;
    expect(results.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
    expect(published.filter(({ type }) => type === "tool_approval_resolved")).toHaveLength(1);
    expect(audit.append.mock.calls.filter(([entry]) => entry.actor === "user")).toHaveLength(1);
  });

  it("blocks the action even when the block rule cannot be saved", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-save-failure-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    const wispPolicies = new WispToolPolicyStore(() => directory);
    vi.spyOn(wispPolicies, "setFileBehavior").mockRejectedValue(new Error("disk full"));
    const broker = new ToolAuthorizationBroker(store, () => undefined, {
      createId: () => "approval-1",
      selectWindowId: () => 1,
      wispPolicies,
    });
    const action = broker.authorize({
      conversationId: "one",
      wispId: "one",
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

  it("decides at once with no one present: approved tools run, others are refused, blocks still win", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-policy-unattended-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    await store.load();
    const events: ConversationAgentEvent[] = [];
    const broker = new ToolAuthorizationBroker(store, (event) => events.push(event), { selectWindowId: () => 7 });
    const action = (toolName: string, category: "modify_file" | "integration_call" | "save_skill") => ({
      conversationId: "one",
      wispId: "one",
      toolCallId: `call-${toolName}`,
      toolName,
      category,
      summary: "Do something",
      scope:
        category === "integration_call"
          ? { kind: "integration" as const, value: "Linear" }
          : category === "save_skill"
            ? { kind: "skill" as const, value: "notes" }
            : { kind: "workspace_path" as const, value: "notes.md" },
    });
    const grant = { conversationId: "one", approvedTools: new Set(["edit", "save_skill"]) };

    await broker.runUnattended(grant, async () => {
      await expect(broker.authorize(action("edit", "modify_file"))).resolves.toBeUndefined();
      await expect(broker.authorize(action("mcp_linear_create", "integration_call"))).rejects.toMatchObject({
        code: "tool_blocked",
      });
      await expect(broker.authorize(action("save_skill", "save_skill"))).rejects.toMatchObject({
        code: "tool_blocked",
      });
      // The grant covers its own conversation only.
      await expect(broker.authorize({ ...action("edit", "modify_file"), conversationId: "two" })).rejects.toMatchObject(
        { code: "tool_blocked" },
      );
    });
    expect(events).toEqual([]);
    expect(broker.listPending()).toEqual([]);

    await store.blockCategory("modify_file", () => "block-1");
    await broker.runUnattended(grant, async () => {
      await expect(broker.authorize(action("edit", "modify_file"))).rejects.toMatchObject({ code: "tool_blocked" });
    });

    // Outside a run, the person is asked as usual.
    void broker.authorize(action("mcp_linear_create", "integration_call")).catch(() => undefined);
    expect(events).toEqual([expect.objectContaining({ type: "tool_approval_requested" })]);
    broker.dispose();
  });

  it("always asks for jobs, shows what they may do, and refuses lasting decisions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-policy-job-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    await store.load();
    const events: ConversationAgentEvent[] = [];
    const broker = new ToolAuthorizationBroker(store, (event) => events.push(event), {
      createId: () => "approval-job",
      selectWindowId: () => 7,
    });
    expect(evaluateToolPolicy({ autoReview: true, rules: [] }, "schedule_job", "job")).toBe("ask");
    expect(evaluateToolPolicy({ autoReview: true, rules: [] }, "schedule_job", "workspace_path")).toBe("block");
    const job = {
      title: "Openings",
      schedule: "Every day at 10:00 (UTC)",
      nextRunAt: "2026-10-12T10:00:00.000Z",
      instructions: "Search\u0007 the boards.",
      skills: ["job-search"],
      tools: ["web_search"],
    };
    const authorization = broker.authorize({
      conversationId: "one",
      wispId: "one",
      toolCallId: "tool-1",
      toolName: "schedule_job",
      category: "schedule_job",
      scope: { kind: "job", value: "Openings" },
      summary: "Schedule Openings",
      job,
    });
    expect(events[0]).toMatchObject({
      type: "tool_approval_requested",
      request: {
        category: "schedule_job",
        scope: { kind: "job" },
        job: { ...job, instructions: "Search the boards." },
      },
    });
    const decision = { approvalId: "approval-job", conversationId: "one", toolCallId: "tool-1" };
    await expect(broker.resolve({ ...decision, decision: "block" }, 7)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(broker.resolve({ ...decision, decision: "allow_always" }, 7)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await broker.resolve({ ...decision, decision: "allow_once" }, 7);
    await expect(authorization).resolves.toBeUndefined();

    // A job's run never approves another job.
    await broker.runUnattended({ conversationId: "one", approvedTools: new Set(["schedule_job"]) }, async () => {
      await expect(
        broker.authorize({
          conversationId: "one",
          wispId: "one",
          toolCallId: "tool-2",
          toolName: "schedule_job",
          category: "schedule_job",
          scope: { kind: "job", value: "Openings" },
          summary: "Schedule Openings",
        }),
      ).rejects.toMatchObject({ code: "tool_blocked" });
    });
  });

  it("always asks for Wisp changes, even in risk mode, and refuses lasting decisions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-policy-wisp-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    await store.save({ autoReview: true, rules: [{ id: "a", action: "manage_wisp", behavior: "allow" }] });
    const events: ConversationAgentEvent[] = [];
    const broker = new ToolAuthorizationBroker(store, (event) => events.push(event), {
      createId: () => "approval-wisp",
      selectWindowId: () => 7,
      wispPolicies: {
        get: () => ({ files: {}, allowEverything: true }),
        save: async (_id, policy) => policy,
        setFileBehavior: async () => undefined,
      },
    });
    expect(evaluateToolPolicy(store.get(), "manage_wisp", "wisp")).toBe("ask");
    expect(evaluateToolPolicy(store.get(), "manage_wisp", "workspace_path")).toBe("block");
    const authorization = broker.authorize({
      conversationId: "one",
      wispId: "one",
      toolCallId: "tool-1",
      toolName: "create_wisp",
      category: "manage_wisp",
      scope: { kind: "wisp", value: "Quill" },
      summary: "Create the Wisp Quill",
      wisp: { action: "create", name: "Quill", changes: { name: "Quill", role: "", soul: "# Quill\u0007" } },
    });
    expect(events[0]).toMatchObject({
      type: "tool_approval_requested",
      request: {
        category: "manage_wisp",
        scope: { kind: "wisp" },
        wisp: { action: "create", name: "Quill", changes: { name: "Quill", role: "", soul: "# Quill" } },
      },
    });
    const decision = { approvalId: "approval-wisp", conversationId: "one", toolCallId: "tool-1" };
    await expect(broker.resolve({ ...decision, decision: "block" }, 7)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(broker.resolve({ ...decision, decision: "allow_always" }, 7)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await broker.resolve({ ...decision, decision: "allow_once" }, 7);
    await expect(authorization).resolves.toBeUndefined();

    // A job's run never changes Wisps, whatever was approved with it.
    await broker.runUnattended({ conversationId: "one", approvedTools: new Set(["delete_wisp"]) }, async () => {
      await expect(
        broker.authorize({
          conversationId: "one",
          wispId: "one",
          toolCallId: "tool-2",
          toolName: "delete_wisp",
          category: "manage_wisp",
          scope: { kind: "wisp", value: "Quill" },
          summary: "Delete the Wisp Quill",
        }),
      ).rejects.toMatchObject({ code: "tool_blocked" });
    });
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
        wispId: "one",
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
      wispId: "one",
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

  it("lets a Wisp in risk mode act without asking, except for skills, jobs and blocks", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-policy-everything-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    const wispPolicies = new WispToolPolicyStore(() => directory);
    await wispPolicies.save("one", { files: {}, allowEverything: true });
    const events: ConversationAgentEvent[] = [];
    const audit = { append: vi.fn() };
    let nextId = 0;
    const broker = new ToolAuthorizationBroker(store, (event) => events.push(event), {
      createId: () => `id-${++nextId}`,
      selectWindowId: () => 1,
      audit,
      wispPolicies,
    });
    const base = { conversationId: "one", toolCallId: "call", summary: "Do it" };
    await expect(
      broker.authorize({
        ...base,
        toolName: "write",
        category: "create_file",
        scope: { kind: "workspace_path", value: "a.txt" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      broker.authorize({
        ...base,
        toolName: "linear_update_issue",
        category: "external_write",
        scope: { kind: "integration", value: "Linear" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      broker.authorize({
        ...base,
        toolName: "mcp_test_search",
        category: "integration_call",
        scope: { kind: "integration", value: "Docs" },
      }),
    ).resolves.toBeUndefined();
    expect(events).toEqual([]);
    expect(audit.append).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: "allow_everything", actor: "user", outcome: "allowed" }),
    );

    // Skills still ask.
    void broker
      .authorize({ ...base, toolName: "save_skill", category: "save_skill", scope: { kind: "skill", value: "notes" } })
      .catch(() => undefined);
    expect(events[0]).toMatchObject({ type: "tool_approval_requested", request: { category: "save_skill" } });
    broker.dispose();

    // A Block rule, or the Wisp's own block for a kind of file change, still wins.
    await store.blockCategory("integration_call", () => "rule-1");
    await expect(
      broker.authorize({
        ...base,
        toolName: "mcp_test_search",
        category: "integration_call",
        scope: { kind: "integration", value: "Docs" },
      }),
    ).rejects.toMatchObject({ code: "tool_blocked" });
    await wispPolicies.setFileBehavior("one", "modify_file", "block");
    await expect(
      broker.authorize({
        ...base,
        toolName: "edit",
        category: "modify_file",
        scope: { kind: "workspace_path", value: "a.txt" },
      }),
    ).rejects.toMatchObject({ code: "tool_blocked" });
  });

  it("lets the person always allow a whole integration from a card", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-approval-integration-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    const events: ConversationAgentEvent[] = [];
    const broker = new ToolAuthorizationBroker(store, (event) => events.push(event), {
      createId: () => "id-1",
      selectWindowId: () => 1,
    });
    const rememberApproval = vi.fn(async () => undefined);
    const rememberIntegration = vi.fn(async () => undefined);
    const asked = broker.authorize({
      conversationId: "one",
      wispId: "one",
      toolCallId: "tool-linear",
      toolName: "linear_update_issue",
      category: "external_write",
      scope: { kind: "integration", value: "Linear" },
      summary: "Update ENG-1",
      rememberApproval,
      rememberIntegration,
    });
    expect(events[0]).toMatchObject({
      type: "tool_approval_requested",
      request: { alwaysAllowTool: true, alwaysAllowIntegration: true },
    });
    await broker.resolve(
      { approvalId: "id-1", conversationId: "one", toolCallId: "tool-linear", decision: "allow_integration" },
      1,
    );
    await expect(asked).resolves.toBeUndefined();
    expect(rememberIntegration).toHaveBeenCalledTimes(1);
    expect(rememberApproval).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "tool_approval_resolved", decision: "allow_integration" });
  });

  it("applies the acting Wisp's permissions in a circle and names it on the card", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-policy-circle-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    await store.save({ autoReview: false, rules: [] });
    const events: ConversationAgentEvent[] = [];
    const wispPolicies = new WispToolPolicyStore((wispId) => path.join(directory, wispId));
    await wispPolicies.save("atlas", { files: { modify_file: "allow" }, allowEverything: false });
    const broker = new ToolAuthorizationBroker(store, (event) => events.push(event), {
      selectWindowId: () => 1,
      createId: () => "approval-1",
      wispPolicies,
    });
    const edit = (wispId: string) =>
      broker.authorize({
        conversationId: "circle",
        wispId,
        toolCallId: `edit-${wispId}`,
        toolName: "edit",
        category: "modify_file",
        scope: { kind: "workspace_path", value: "plan.md" },
        summary: "Modify plan.md",
      });

    await expect(edit("atlas")).resolves.toBeUndefined();
    const asked = edit("nova");
    expect(events.at(-1)).toMatchObject({
      type: "tool_approval_requested",
      conversationId: "circle",
      request: { conversationId: "circle", wispId: "nova" },
    });
    await broker.resolve(
      { approvalId: "approval-1", conversationId: "circle", toolCallId: "edit-nova", decision: "allow_always" },
      1,
    );
    await expect(asked).resolves.toBeUndefined();
    // The lasting Allow is Nova's, not the circle's.
    expect(wispPolicies.get("nova").files).toEqual({ modify_file: "allow" });
    expect(wispPolicies.get("circle").files).toEqual({});
  });

  it("reports a Wisp's permissions with the app-wide defaults it falls back to", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-policy-view-"));
    const store = new ToolPolicyStore(path.join(directory, "policy.json"));
    await store.save({
      autoReview: true,
      rules: [{ id: "allow", action: "create_file", behavior: "allow", scope: "workspace" }],
    });
    const broker = new ToolAuthorizationBroker(store, () => undefined, {
      wispPolicies: new WispToolPolicyStore(() => directory),
    });
    expect(broker.getWispPolicy("one")).toEqual({
      conversationId: "one",
      files: {},
      allowEverything: false,
      defaults: { create_file: "allow", modify_file: "ask" },
    });
    await expect(
      broker.saveWispPolicy({ conversationId: "one", files: { modify_file: "allow" }, allowEverything: true }),
    ).resolves.toMatchObject({ files: { modify_file: "allow" }, allowEverything: true });
    // Saved to the Wisp's own file, and read back by a fresh store.
    expect(new WispToolPolicyStore(() => directory).get("one")).toEqual({
      files: { modify_file: "allow" },
      allowEverything: true,
    });
  });
});
