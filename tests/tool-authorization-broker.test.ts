import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  evaluateToolPolicy,
  ToolAuthorizationBroker,
} from "../electron/backend/tool-authorization-broker.js";
import { ToolPolicyStore } from "../electron/backend/tool-policy-store.js";
import type { ConversationAgentEvent } from "../shared/contracts.js";

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

  it("uses conservative precedence and blocks shell and unknown categories", () => {
    const settings = {
      autoReview: true,
      rules: [
        { id: "allow", action: "all_file_changes", behavior: "allow" as const },
        { id: "ask", action: "modify_file", behavior: "ask" as const },
        { id: "block", action: "modify files", behavior: "block" as const },
      ],
    };

    expect(evaluateToolPolicy(settings, "read")).toBe("allow");
    expect(evaluateToolPolicy(settings, "create_file")).toBe("allow");
    expect(evaluateToolPolicy(settings, "modify_file")).toBe("block");
    expect(evaluateToolPolicy(settings, "shell")).toBe("block");
    expect(evaluateToolPolicy(settings, "unknown")).toBe("block");
    expect(evaluateToolPolicy({ ...settings, autoReview: false }, "create_file")).toBe("ask");
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

    await expect(broker.resolve({
      approvalId: "approval-1",
      conversationId: "one",
      toolCallId: "tool-1",
      decision: "allow_once",
    }, 8)).rejects.toMatchObject({ code: "invalid_request" });
    await broker.resolve({
      approvalId: "approval-1",
      conversationId: "one",
      toolCallId: "tool-1",
      decision: "allow_once",
    }, 7);
    await expect(authorization).resolves.toBeUndefined();
    await expect(broker.resolve({
      approvalId: "approval-1",
      conversationId: "one",
      toolCallId: "tool-1",
      decision: "allow_once",
    }, 7)).rejects.toMatchObject({ code: "not_found" });
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
        summary: "Modify file.txt",
      });
      const blockedExpectation = expect(blocked).rejects.toMatchObject({ code: "tool_blocked" });
      await broker.resolve({
        approvalId: "id-2",
        conversationId: "one",
        toolCallId: "tool-block",
        decision: "block",
      }, 1);
      await blockedExpectation;
      expect(evaluateToolPolicy(store.get(), "modify_file")).toBe("block");
    } finally {
      vi.useRealTimers();
    }
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
    const authorization = broker.authorize({
      conversationId: "one",
      toolCallId: "tool-abort",
      toolName: "write",
      category: "create_file",
      summary: "Create notes.txt",
    }, controller.signal);
    const expectation = expect(authorization).rejects.toMatchObject({ code: "aborted" });
    controller.abort();
    await expectation;
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_approval_resolved",
      decision: "deny",
    }));
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
      summary: "Create notes.txt",
    });
    const expectation = expect(authorization).rejects.toMatchObject({ code: "aborted" });

    broker.cancelConversation("one");

    await expectation;
    expect(broker.listPending()).toEqual([]);
  });
});
