import { afterEach, describe, expect, it, vi } from "vitest";

import {
  claudeCodeEffort,
  ClaudeCodeSession,
  type ClaudeCodeLaunch,
  type ClaudeCodeQuery,
  type ClaudeCodeQueryHandle,
  type ClaudeCodeSavedSession,
  type ClaudeCodeContextHooks,
  type ClaudeCodeContextState,
  type ClaudeCodeSessionOptions,
} from "../backend/claude-code/claude-code-session.js";
import type { ClaudeCodeQueryOptions } from "../backend/claude-code/claude-code-launch.js";
import type { PiAgentEvent } from "../backend/pi-event-translator.js";
import type { RuntimeSession } from "../backend/runtime-session.js";
import { DEFAULT_CONTEXT_POLICY, type ContextPolicy } from "../shared/context-policy.js";

const SESSION = "550e8400-e29b-41d4-a716-446655440000";

/** A Claude Code process the test drives: it records what it is sent and yields what the test pushes. */
class FakeProcess implements ClaudeCodeQueryHandle {
  readonly sent: string[] = [];
  /** Each message as sent, with its priority and uuid. */
  readonly messages: Array<{ message: { content: unknown }; priority?: string; uuid?: string }> = [];
  /** The uuids cancelAsyncMessage withdraws; others were already read. */
  cancellable = new Set<string>();
  readonly cancelled: string[] = [];
  closed = false;
  interrupts = 0;
  private readonly outbox: unknown[] = [];
  private wake: (() => void) | undefined;
  private failure: Error | undefined;

  constructor(
    readonly options: ClaudeCodeQueryOptions,
    prompt: AsyncIterable<{ message: { content: unknown } }>,
  ) {
    void (async () => {
      for await (const message of prompt) {
        this.messages.push(message);
        this.sent.push(String(message.message.content));
        await this.onMessage?.(String(message.message.content));
      }
    })();
  }

  /** Answers each message the process receives. */
  onMessage: ((text: string) => void | Promise<void>) | undefined;
  onInterrupt: (() => void) | undefined;

  push(...messages: unknown[]): void {
    this.outbox.push(...messages);
    this.wake?.();
  }

  crash(error: Error): void {
    this.failure = error;
    this.wake?.();
  }

  async interrupt(): Promise<unknown> {
    this.interrupts += 1;
    this.onInterrupt?.();
    return { still_queued: [] };
  }

  async cancelAsyncMessage(uuid: string): Promise<boolean> {
    if (!this.cancellable.has(uuid)) return false;
    this.cancelled.push(uuid);
    return true;
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    while (true) {
      const next = this.outbox.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

const delta = (text: string) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const result = (overrides: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: SESSION,
  usage: { input_tokens: 1, output_tokens: 1 },
  ...overrides,
});

function createSession(
  options: {
    answer?: (process: FakeProcess, text: string) => void;
    context?: ClaudeCodeContextHooks;
    state?: ClaudeCodeContextState;
    resume?: boolean;
    now?: () => Date;
    fallback?: ClaudeCodeSessionOptions["fallback"];
  } = {},
) {
  const processes: FakeProcess[] = [];
  const launches: Array<Omit<ClaudeCodeLaunch, "observer">> = [];
  const observers: Array<ClaudeCodeLaunch["observer"]> = [];
  const query: ClaudeCodeQuery = ({ prompt, options: queryOptions }) => {
    const process = new FakeProcess(queryOptions, prompt as AsyncIterable<{ message: { content: unknown } }>);
    process.onMessage = (text) => {
      if (options.answer) options.answer(process, text);
      else process.push(delta(`echo:${text}`), result());
    };
    processes.push(process);
    return process;
  };
  const onSessionSaved = vi.fn(async (_saved: ClaudeCodeSavedSession) => undefined);
  const session = new ClaudeCodeSession({
    query,
    queryOptions: async ({ observer, ...launch }) => {
      launches.push(launch);
      observers.push(observer);
      return { model: launch.model } as ClaudeCodeQueryOptions;
    },
    sessionId: SESSION,
    resume: options.resume ?? false,
    model: "sonnet",
    thinkingLevel: "off",
    toolNames: ["read", "run_command"],
    toolRevision: "rev-1",
    onSessionSaved,
    recentTranscript: async () => "user: earlier question",
    ...(options.context ? { context: options.context } : {}),
    ...(options.state ? { state: options.state } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.fallback ? { fallback: options.fallback } : {}),
  });
  const events: PiAgentEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { session, processes, launches, observers, events, onSessionSaved };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ClaudeCodeSession", () => {
  it("runs a turn as Pi's agent events and keeps one process across turns", async () => {
    const { session, processes, launches, events, onSessionSaved } = createSession();

    await session.prompt("hello");
    await session.prompt("again");
    // Each successful turn saves the session, so it is resumed later.
    // A new session is saved for resuming once a turn in it succeeded, and only then.
    expect(onSessionSaved.mock.calls.map(([saved]) => saved.sessionId)).toEqual([SESSION, SESSION]);
    expect(processes).toHaveLength(1);
    expect(processes[0]!.sent).toEqual(["hello", "again"]);
    expect(launches).toEqual([{ sessionId: SESSION, resume: false, model: "sonnet" }]);
    expect(events.map(({ type }) => type)).toEqual([
      "agent_start",
      "message_start",
      "message_update",
      "agent_end",
      "agent_settled",
      "agent_start",
      "message_start",
      "message_update",
      "agent_end",
      "agent_settled",
    ]);
    expect(session.isIdle).toBe(true);
    expect(session.getActiveToolNames()).toEqual(["read", "run_command"]);
  });

  it("reports a Wisp tool's progress and ends its call with the tool's own result", async () => {
    const toolUse = {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "mcp__wisp__edit", input: {} }],
      },
    };
    const toolResult = {
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Edited" }] },
    };
    const own = { content: [{ type: "text", text: "Edited" }], details: { patch: "+one" } };
    const { session, observers, events } = createSession({
      answer: (process) => {
        process.push(toolUse);
        // The Wisp's MCP server runs the tool before Claude Code reports its result.
        setTimeout(() => {
          observers[0]!.progress("toolu_1", { details: { activityLabel: "Editing…" } });
          observers[0]!.result("toolu_1", own);
          process.push(toolResult, delta("Done"), result());
        }, 0);
      },
    });

    await session.prompt("edit it");

    expect(events.filter(({ type }) => type.startsWith("tool_execution"))).toEqual([
      { type: "tool_execution_start", toolCallId: "toolu_1", toolName: "edit", args: {} },
      {
        type: "tool_execution_update",
        toolCallId: "toolu_1",
        toolName: "edit",
        partialResult: { details: { activityLabel: "Editing…" } },
      },
      { type: "tool_execution_end", toolCallId: "toolu_1", toolName: "edit", isError: false, result: own },
    ]);
  });

  it("resumes the session in a new process after a model, reasoning, or identity change", async () => {
    const { session, processes, launches } = createSession();
    await session.prompt("hello");

    await session.setModel({ id: "opus" });
    session.setThinkingLevel("high");
    await session.prompt("next");
    await session.reload();
    await session.prompt("after reload");

    expect(processes.map(({ closed }) => closed)).toEqual([true, true, false]);
    expect(launches).toEqual([
      { sessionId: SESSION, resume: false, model: "sonnet" },
      { sessionId: SESSION, resume: true, model: "opus", effort: "high" },
      { sessionId: SESSION, resume: true, model: "opus", effort: "high" },
    ]);
  });

  it("stops a reply with an interrupt and reports it as a finished, cancelled turn", async () => {
    const { session, processes, events } = createSession({
      answer: (process) => {
        process.push(delta("1\n2\n"));
        process.onInterrupt = () => process.push(result({ subtype: "error_during_execution", is_error: true }));
      },
    });

    const turn = session.prompt("count");
    await vi.waitFor(() => expect(events.some(({ type }) => type === "message_update")).toBe(true));
    await session.abort();
    await turn;

    expect(processes[0]!.interrupts).toBe(1);
    expect(events.at(-1)).toEqual({ type: "agent_settled" });
    expect(session.isIdle).toBe(true);
  });

  it("replaces a session that no longer exists and sends the message again", async () => {
    let first = true;
    const { session, processes, launches, onSessionSaved } = createSession({
      answer: (process, text) => {
        if (first) {
          first = false;
          process.push(
            result({
              subtype: "error_during_execution",
              is_error: true,
              errors: [`No conversation found with session ID: ${SESSION}`],
            }),
          );
          process.crash(new Error("Claude Code returned an error result"));
          return;
        }
        process.push(delta(`echo:${text}`), result({ session_id: launches.at(-1)!.sessionId }));
      },
    });

    await session.prompt("hello");

    expect(processes).toHaveLength(2);
    expect(processes[1]!.sent).toEqual(["hello"]);
    const replacement = launches[1]!;
    expect(replacement.sessionId).not.toBe(SESSION);
    expect(replacement).toMatchObject({ resume: false, recoveredContext: "user: earlier question" });
    expect(onSessionSaved).toHaveBeenCalledWith(expect.objectContaining({ sessionId: replacement.sessionId }));
    expect(session.sessionId).toBe(replacement.sessionId);
  });

  it("turns a failed turn into an error the person can act on", async () => {
    const { session } = createSession({
      answer: (process) =>
        process.push(
          result({ subtype: "error_during_execution", is_error: true, errors: ["OAuth token has expired"] }),
        ),
    });

    await expect(session.prompt("hello")).rejects.toMatchObject({
      code: "configuration_required",
      message: "Claude Code is not signed in. Run `claude auth login` on the server's computer.",
    });
    expect(session.isIdle).toBe(true);
  });

  it("fails the turn when the process stops, and starts a new one for the next message", async () => {
    let crashed = false;
    const { session, processes } = createSession({
      answer: (process, text) => {
        if (!crashed) {
          crashed = true;
          process.crash(new Error("exited with code 1"));
          return;
        }
        process.push(delta(text), result());
      },
    });

    await expect(session.prompt("hello")).rejects.toMatchObject({ code: "unavailable", retryable: true });
    await session.prompt("again");

    expect(processes).toHaveLength(2);
  });

  it("adds a job's delivered result to the next message", async () => {
    const { session, processes } = createSession();

    await session.appendCustomMessage("wisp:job-result", "The nightly report finished.");
    await session.prompt("What happened overnight?");

    expect(processes[0]!.sent).toEqual(["The nightly report finished.\n\nWhat happened overnight?"]);
  });

  it("closes an idle process and resumes it for the next message", async () => {
    vi.useFakeTimers();
    const { session, processes, launches } = createSession();
    await session.prompt("hello");

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(processes[0]!.closed).toBe(true);
    await session.prompt("later");

    expect(launches.at(-1)).toMatchObject({ resume: true });
    expect(processes).toHaveLength(2);
  });

  it("refuses a second turn while one runs, and work after disposal", async () => {
    const { session } = createSession({ answer: () => undefined });
    const running = session.prompt("first");

    await expect(session.prompt("second")).rejects.toMatchObject({ code: "invalid_request" });
    session.dispose();
    await expect(running).rejects.toMatchObject({ code: "disposed" });
    await expect(session.prompt("third")).rejects.toMatchObject({ code: "disposed" });
  });
});

/** The fallback model's session: it answers with Pi's events, or waits until aborted. */
function fakeFallback(answer: "reply" | "wait" = "reply") {
  const listeners = new Set<(event: PiAgentEvent) => void>();
  const prompts: string[] = [];
  let release: (() => void) | undefined;
  const session = {
    subscribe: (listener: (event: PiAgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: vi.fn(async (text: string) => {
      prompts.push(text);
      const emit = (event: unknown) => listeners.forEach((listener) => listener(event as PiAgentEvent));
      emit({ type: "agent_start" });
      emit({ type: "message_start", message: { role: "user" } });
      emit({ type: "message_update", text: "from the fallback" });
      if (answer === "wait") await new Promise<void>((resolve) => (release = resolve));
      emit({ type: "agent_end" });
      emit({ type: "agent_settled" });
    }),
    abort: vi.fn(async () => release?.()),
    dispose: vi.fn(),
  } as unknown as RuntimeSession;
  return { session, prompts, fallback: vi.fn(async () => ({ name: "GPT-5", session })) };
}

const signedOut = (process: FakeProcess) =>
  process.push(
    result({ subtype: "error_during_execution", is_error: true, errors: ["Not logged in · Please run /login"] }),
  );

const lifecycle = (uuid: string, state: string) => ({ type: "command_lifecycle", command_uuid: uuid, state });
const userStarts = (events: PiAgentEvent[]) =>
  events.filter((event) => event.type === "message_start" && event.message?.role === "user").length;

describe("ClaudeCodeSession steering", () => {
  it("sends a follow-up to steer the running turn and reports when the turn reads it", async () => {
    const { session, processes, events } = createSession({ answer: (process) => process.push(delta("working")) });
    const turn = session.prompt("count slowly");
    await vi.waitFor(() => expect(processes[0]?.sent).toEqual(["count slowly"]));

    session.steer("stop at two");
    const process = processes[0]!;
    await vi.waitFor(() => expect(process.messages).toHaveLength(2));
    const followUp = process.messages[1]!;
    expect(followUp).toMatchObject({ priority: "next", message: { content: "stop at two" } });
    expect(userStarts(events)).toBe(1);

    process.push(lifecycle(followUp.uuid!, "started"), delta("stopping"), result());
    await turn;

    expect(userStarts(events)).toBe(2);
    expect(process.cancelled).toEqual([]);
  });

  it("sends a follow-up that arrived before Claude Code had the message right after it", async () => {
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => (release = resolve));
    const { session, processes } = createSession({
      answer: () => undefined,
      // The context policy is read before the message is sent.
      context: {
        load: async () => {
          await loaded;
          return { policy: DEFAULT_CONTEXT_POLICY, memory: "" };
        },
        save: async () => undefined,
        timeZone: () => "UTC",
        onRenewed: () => undefined,
      },
    });

    const turn = session.prompt("first");
    session.steer("and then this");
    release();
    await vi.waitFor(() => expect(processes[0]?.messages).toHaveLength(2));
    const process = processes[0]!;
    expect(process.messages.map(({ priority }) => priority)).toEqual([undefined, "next"]);
    process.cancellable.add(process.messages[1]!.uuid!);
    process.push(result());
    await turn;
  });

  it("withdraws a follow-up the turn did not read, so it is sent as a message of its own", async () => {
    const { session, processes, events } = createSession({ answer: () => undefined });
    const turn = session.prompt("hello");
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    session.steer("one more thing");
    const process = processes[0]!;
    await vi.waitFor(() => expect(process.messages).toHaveLength(2));
    process.cancellable.add(process.messages[1]!.uuid!);

    process.push(delta("hi"), result());
    await turn;

    expect(process.cancelled).toEqual([process.messages[1]!.uuid]);
    expect(userStarts(events)).toBe(1);
  });

  it("goes on to answer a follow-up Claude Code read just as the turn ended", async () => {
    const { session, processes, events } = createSession({ answer: () => undefined });
    const turn = session.prompt("hello");
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    session.steer("one more thing");
    const process = processes[0]!;
    await vi.waitFor(() => expect(process.messages).toHaveLength(2));
    const uuid = process.messages[1]!.uuid!;
    let settled = false;
    void turn.then(() => (settled = true));

    process.push(delta("hi"), result());
    await vi.waitFor(() => expect(userStarts(events)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    process.push(lifecycle(uuid, "started"), delta("and the rest"), result());
    await turn;
    expect(userStarts(events)).toBe(2);
  });
});

describe("ClaudeCodeSession fallback", () => {
  it("answers a turn Claude Code failed for good on the fallback model, told the latest messages", async () => {
    const backup = fakeFallback();
    const { session, events } = createSession({ answer: signedOut, fallback: backup.fallback });

    await session.prompt("hello");

    expect(events.map(({ type }) => type)).toEqual([
      "agent_start",
      "message_start",
      "model_fallback",
      "message_update",
      "agent_end",
      "agent_settled",
    ]);
    expect(events[2]).toEqual({ type: "model_fallback", model: "GPT-5" });
    expect(backup.prompts[0]).toContain("user: earlier question");
    expect(backup.prompts[0]!.endsWith("hello")).toBe(true);
    expect(backup.session.dispose).toHaveBeenCalled();
    expect(session.isIdle).toBe(true);
  });

  it("fails the turn when the Wisp has no fallback", async () => {
    const { session } = createSession({ answer: signedOut, fallback: async () => null });

    await expect(session.prompt("hello")).rejects.toMatchObject({ code: "configuration_required" });
  });

  it("answers on the fallback model once Claude Code's own retries of an overloaded provider ran out", async () => {
    const backup = fakeFallback();
    const { session, events } = createSession({
      answer: (process) =>
        process.push(
          result({
            subtype: "error_during_execution",
            is_error: true,
            errors: ['API Error: 529 {"type":"overloaded_error"}'],
          }),
        ),
      fallback: backup.fallback,
    });

    await session.prompt("hello");

    expect(backup.fallback).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ type: "model_fallback", model: "GPT-5" });
  });

  it("keeps a failure of Claude Code itself on Claude Code", async () => {
    const backup = fakeFallback();
    const { session } = createSession({
      answer: (process) =>
        process.push(
          result({ subtype: "error_max_turns", is_error: true, errors: ["Reached maximum number of turns (40)"] }),
        ),
      fallback: backup.fallback,
    });

    await expect(session.prompt("hello")).rejects.toMatchObject({ code: "unavailable", retryable: true });
    expect(backup.fallback).not.toHaveBeenCalled();
  });

  it("stops the fallback model's reply", async () => {
    const backup = fakeFallback("wait");
    const { session, events } = createSession({ answer: signedOut, fallback: backup.fallback });

    const turn = session.prompt("hello");
    await vi.waitFor(() => expect(events.some(({ type }) => type === "message_update")).toBe(true));
    await session.abort();
    await turn;

    expect(backup.session.abort).toHaveBeenCalled();
    expect(backup.session.dispose).toHaveBeenCalled();
    expect(session.isIdle).toBe(true);
  });
});

describe("ClaudeCodeSession context", () => {
  const NOW = new Date("2026-10-20T12:00:00Z");

  function contextHooks(policy: Partial<ContextPolicy> = {}) {
    let settings = { policy: { ...DEFAULT_CONTEXT_POLICY, ...policy }, memory: "Prefers short answers." };
    const renewed: string[] = [];
    const hooks: ClaudeCodeContextHooks = {
      load: async () => settings,
      save: async (next) => {
        settings = next;
      },
      timeZone: () => "UTC",
      onRenewed: (kind) => renewed.push(kind),
    };
    return { hooks, renewed };
  }

  /** Answers messages with text, and `/compact` the way Claude Code does. */
  const answerWithCompaction = (process: FakeProcess, text: string) => {
    if (text === "/compact") {
      process.push(
        { type: "system", subtype: "status", status: "compacting" },
        { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", post_tokens: 900 } },
        result({ result: "" }),
      );
      return;
    }
    process.push(
      {
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "message_start", message: { usage: { input_tokens: 20, cache_read_input_tokens: 15_000 } } },
      },
      delta(`echo:${text}`),
      result(),
    );
  };

  it("shows the policy, memory, and context size, and saves new settings for the next process", async () => {
    const { hooks } = contextHooks();
    const { session, processes } = createSession({ context: hooks, now: () => NOW, answer: answerWithCompaction });
    await session.prompt("hello");

    const view = await session.manageContext({ action: "get" });
    expect(view).toEqual({
      policy: DEFAULT_CONTEXT_POLICY,
      memory: "Prefers short answers.",
      summary: null,
      lastRenewedAt: null,
      lastActivityAt: NOW.toISOString(),
      tokens: 15_020,
    });

    const saved = await session.manageContext({
      action: "save",
      policy: { ...DEFAULT_CONTEXT_POLICY, mode: "none" },
      memory: "Answers in Portuguese.",
    });
    expect(saved).toMatchObject({ memory: "Answers in Portuguese.", policy: { mode: "none" } });
    // The memory is in the system prompt, which the next process reads.
    expect(processes[0]!.closed).toBe(true);
  });

  it("compacts through Claude Code's /compact and starts a new topic as a new session", async () => {
    const { hooks, renewed } = contextHooks();
    const { session, processes, launches, onSessionSaved } = createSession({
      context: hooks,
      now: () => NOW,
      answer: answerWithCompaction,
    });
    await session.prompt("hello");

    const compacted = await session.manageContext({ action: "compact" });
    expect(processes[0]!.sent).toEqual(["hello", "/compact"]);
    expect(compacted).toMatchObject({ tokens: 900, lastRenewedAt: NOW.toISOString() });

    const fresh = await session.manageContext({ action: "new_topic" });
    expect(fresh.tokens).toBe(0);
    expect(renewed).toEqual(["compacted", "new_topic"]);
    // A new topic is not resumed until a turn in it succeeds.
    expect(onSessionSaved.mock.calls.at(-1)![0]).toMatchObject({ sessionId: null, tokens: 0 });
    await session.prompt("new subject");
    expect(launches.at(-1)).toMatchObject({ resume: false });
    expect(launches.at(-1)!.sessionId).not.toBe(SESSION);
  });

  it("renews the context before a message once the policy says so", async () => {
    const { hooks, renewed } = contextHooks({ mode: "idle", idleHours: 24, minimumTokens: 12_000, renewal: "compact" });
    const { session, processes } = createSession({
      context: hooks,
      now: () => NOW,
      resume: true,
      // Two days idle with a large context.
      state: { lastActivityAt: "2026-10-18T12:00:00Z", lastRenewedAt: null, tokens: 40_000 },
      answer: answerWithCompaction,
    });

    await session.prompt("Good morning");

    expect(processes[0]!.sent).toEqual(["/compact", "Good morning"]);
    expect(renewed).toEqual(["compacted"]);
  });

  it("refuses context changes while a turn runs", async () => {
    const { hooks } = contextHooks();
    const { session } = createSession({ context: hooks, answer: () => undefined });
    const running = session.prompt("first");

    await expect(session.manageContext({ action: "new_topic" })).rejects.toMatchObject({ code: "invalid_request" });
    session.dispose();
    await running.catch(() => undefined);
  });
});

describe("claudeCodeEffort", () => {
  it("maps Wisp reasoning levels to Claude Code effort", () => {
    expect(claudeCodeEffort("off")).toBeUndefined();
    expect(claudeCodeEffort("minimal")).toBe("low");
    expect(claudeCodeEffort("medium")).toBe("medium");
    expect(claudeCodeEffort("max")).toBe("max");
  });
});
