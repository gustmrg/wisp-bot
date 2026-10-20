import { describe, expect, it, vi } from "vitest";

import { ClaudeCodeJobSession } from "../backend/claude-code/claude-code-job-session.js";
import type { ClaudeCodeQueryOptions } from "../backend/claude-code/claude-code-launch.js";
import type { ClaudeCodeQuery } from "../backend/claude-code/claude-code-session.js";

const result = (overrides: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "s",
  result: "Three new posts today.",
  usage: { input_tokens: 10, output_tokens: 5 },
  ...overrides,
});

/** A Claude Code process that answers its one message with the given messages, or throws. */
function queryAnswering(answer: (text: string) => unknown[] | Error, onInterrupt?: () => void) {
  const sent: string[] = [];
  const closed = vi.fn();
  let started = false;
  const query: ClaudeCodeQuery = ({ prompt }) => {
    started = true;
    const messages = (async function* () {
      for await (const message of prompt) {
        const text = String(message.message.content);
        sent.push(text);
        const outcome = answer(text);
        if (outcome instanceof Error) throw outcome;
        yield* outcome;
      }
    })();
    return {
      interrupt: vi.fn(async () => onInterrupt?.()),
      close: closed,
      [Symbol.asyncIterator]: () => messages,
    };
  };
  return { query, sent, closed, started: () => started };
}

function session(query: ClaudeCodeQuery) {
  return new ClaudeCodeJobSession({
    query,
    toolNames: ["web_search", "skip_delivery"],
    queryOptions: async () => ({ persistSession: false }) as ClaudeCodeQueryOptions,
  });
}

describe("ClaudeCodeJobSession", () => {
  it("runs one turn, delivers its reply, and reports its usage", async () => {
    const fake = queryAnswering(() => [result()]);
    const run = session(fake.query);
    expect(fake.started()).toBe(false);

    await run.prompt("Check the blog for new posts.", new AbortController().signal);
    run.dispose();

    expect(fake.sent).toEqual(["Check the blog for new posts."]);
    expect(run.lastAssistantMessage()).toEqual({ text: "Three new posts today.", stopReason: "stop" });
    expect(run.usage()).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(run.getActiveToolNames()).toEqual(["web_search", "skip_delivery"]);
    expect(run.sessionFile).toBeUndefined();
    expect(fake.closed).toHaveBeenCalled();
  });

  it("turns a failed run into an error the person can act on", async () => {
    const fake = queryAnswering(() => [
      result({ subtype: "error_during_execution", is_error: true, errors: ["Not logged in · Please run /login"] }),
    ]);
    const run = session(fake.query);

    await expect(run.prompt("Go", new AbortController().signal)).rejects.toMatchObject({
      code: "configuration_required",
    });
    expect(run.lastAssistantMessage()).toMatchObject({ stopReason: "error" });
  });

  it("fails when Claude Code stops without a result", async () => {
    const run = session(queryAnswering(() => new Error("exited with code 1")).query);

    await expect(run.prompt("Go", new AbortController().signal)).rejects.toMatchObject({
      code: "unavailable",
      message: "Claude Code stopped unexpectedly: exited with code 1",
    });
    expect(run.lastAssistantMessage()).toBeUndefined();
  });

  it("stops the run when the job is stopped", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const fake = queryAnswering(
      () => [],
      () => release(),
    );
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let started = false;
    const query: ClaudeCodeQuery = (params) => {
      const handle = fake.query(params);
      started = true;
      return {
        ...handle,
        [Symbol.asyncIterator]: async function* () {
          await blocked;
          yield result({ subtype: "error_during_execution", is_error: true });
        },
      };
    };
    const run = session(query);

    const running = run.prompt("Go", controller.signal);
    await vi.waitFor(() => expect(started).toBe(true));
    controller.abort();
    await running;

    expect(run.lastAssistantMessage()).toEqual({ text: "", stopReason: "aborted" });
  });
});
