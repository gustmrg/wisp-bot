import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { evaluateToolPolicy, ToolAuthorizationBroker } from "../electron/backend/tool-authorization-broker.js";
import { ToolPolicyStore } from "../electron/backend/tool-policy-store.js";
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
