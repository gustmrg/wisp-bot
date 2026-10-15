import { describe, expect, it, vi } from "vitest";

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";

import { ModelFallback, shouldFallBack } from "../backend/model-fallback.js";

const pi = await import("@earendil-works/pi-ai");

type StreamFn = Parameters<ModelFallback["wrap"]>[0];

function model(provider: string, id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id,
    name: `Model ${id}`,
    api: "openai-completions",
    provider,
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
    ...overrides,
  } as Model<Api>;
}

const primary = model("openai", "primary", { reasoning: true, maxTokens: 32_000 });
const backup = model("openrouter", "backup");

function message(from: Model<Api>, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: from.api,
    provider: from.provider,
    model: from.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function failure(from: Model<Api>, errorMessage: string): AssistantMessage {
  return message(from, { stopReason: "error", errorMessage });
}

function answer(from: Model<Api>, text: string): AssistantMessageEvent[] {
  const partial = message(from);
  const done = message(from, { content: [{ type: "text", text }] });
  return [
    { type: "start", partial },
    { type: "text_start", contentIndex: 0, partial },
    { type: "text_delta", contentIndex: 0, delta: text, partial },
    { type: "done", reason: "stop", message: done },
  ];
}

function failing(from: Model<Api>, errorMessage: string): AssistantMessageEvent[] {
  return [
    { type: "start", partial: message(from) },
    { type: "error", reason: "error", error: failure(from, errorMessage) },
  ];
}

function streamOf(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  const stream = pi.createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const event of events) stream.push(event);
    stream.end();
  });
  return stream;
}

/** A stream function that answers each model with the events given for it. */
function provider(events: Record<string, AssistantMessageEvent[]>) {
  return vi.fn<StreamFn>((requested) => streamOf(events[requested.id] ?? answer(requested, "unexpected")));
}

async function collect(stream: ReturnType<StreamFn>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of await stream) events.push(event);
  return events;
}

const context = { messages: [] } as unknown as Parameters<StreamFn>[1];

describe("shouldFallBack", () => {
  it.each([
    ["402 Payment Required: insufficient credits"],
    ['429 {"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}'],
    ["400 Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing."],
    ["401 invalid x-api-key"],
    ["403 Forbidden: this key cannot use the model"],
    ['OpenRouter API error (404): {"message":"No endpoints found for this model","code":404}'],
  ])("moves when the model fails for good: %s", (errorMessage) => {
    expect(shouldFallBack(pi, failure(primary, errorMessage), primary.contextWindow)).toBe(true);
  });

  it.each([
    ["429 Too Many Requests: rate limit reached"],
    ["503 Service Unavailable"],
    ["fetch failed"],
    ["400 prompt is too long: 250000 tokens > 200000 maximum"],
    ["413 Request Entity Too Large"],
  ])("leaves failures Pi retries or compaction fixes: %s", (errorMessage) => {
    expect(shouldFallBack(pi, failure(primary, errorMessage), primary.contextWindow)).toBe(false);
  });

  it("never moves an answer or a stopped request", () => {
    expect(shouldFallBack(pi, message(primary), primary.contextWindow)).toBe(false);
    expect(
      shouldFallBack(pi, message(primary, { stopReason: "aborted", errorMessage: "402" }), primary.contextWindow),
    ).toBe(false);
  });
});

describe("ModelFallback", () => {
  it("answers with the fallback when the model fails for good, for the rest of the turn", async () => {
    const inner = provider({ primary: failing(primary, "402 Payment Required"), backup: answer(backup, "Hi") });
    const onFallback = vi.fn();
    const fallback = new ModelFallback({ pi, resolve: async () => backup, onFallback });
    const stream = fallback.wrap(inner);

    const events = await collect(stream(primary, context, {}));
    expect(events.map(({ type }) => type)).toEqual(["start", "text_start", "text_delta", "done"]);
    expect(
      events.every(
        (event) => (event.type === "error" ? event.error : (event.partial ?? event.message))?.provider === "openrouter",
      ),
    ).toBe(true);
    expect(onFallback).toHaveBeenCalledExactlyOnceWith(backup);

    // The next call of the turn, such as after a tool runs, goes straight to the fallback.
    await collect(stream(primary, context, {}));
    expect(inner.mock.calls.map(([requested]) => requested.id)).toEqual(["primary", "backup", "backup"]);
    expect(onFallback).toHaveBeenCalledOnce();

    // The next turn tries the Wisp's own model again.
    fallback.reset();
    await collect(stream(primary, context, {}));
    expect(inner.mock.calls.at(-2)?.[0].id).toBe("primary");
  });

  it("keeps the model's own error when there is no fallback", async () => {
    const events = failing(primary, "402 Payment Required");
    const fallback = new ModelFallback({ pi, resolve: async () => null });
    expect(await collect(fallback.wrap(provider({ primary: events }))(primary, context, {}))).toEqual(events);
  });

  it("keeps the model's own error for failures the fallback cannot fix", async () => {
    const events = failing(primary, "429 Too Many Requests: rate limit reached");
    const resolve = vi.fn(async () => backup);
    const fallback = new ModelFallback({ pi, resolve });
    expect(await collect(fallback.wrap(provider({ primary: events }))(primary, context, {}))).toEqual(events);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not move once the model has started answering", async () => {
    const partial = message(primary);
    const events: AssistantMessageEvent[] = [
      { type: "start", partial },
      { type: "text_start", contentIndex: 0, partial },
      { type: "text_delta", contentIndex: 0, delta: "Hel", partial },
      { type: "error", reason: "error", error: failure(primary, "402 Payment Required") },
    ];
    const inner = provider({ primary: events, backup: answer(backup, "Hi") });
    const fallback = new ModelFallback({ pi, resolve: async () => backup });
    expect(await collect(fallback.wrap(inner)(primary, context, {}))).toEqual(events);
    expect(inner).toHaveBeenCalledOnce();
  });

  it("does not move a request that was stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = failing(primary, "402 Payment Required");
    const inner = provider({ primary: events, backup: answer(backup, "Hi") });
    const fallback = new ModelFallback({ pi, resolve: async () => backup });
    expect(await collect(fallback.wrap(inner)(primary, context, { signal: controller.signal }))).toEqual(events);
    expect(inner).toHaveBeenCalledOnce();
  });

  it("keeps the model's own error when the fallback cannot start", async () => {
    const events = failing(primary, "401 invalid x-api-key");
    const inner = vi.fn<StreamFn>((requested) => {
      if (requested.id === "backup") throw new Error("No API key for openrouter");
      return streamOf(events);
    });
    const fallback = new ModelFallback({ pi, resolve: async () => backup });
    expect(await collect(fallback.wrap(inner)(primary, context, {}))).toEqual(events);
    expect(fallback.fallbackRequest).toBeUndefined();
  });

  it("sends the fallback its own limits and none of the other provider's credentials", async () => {
    const inner = provider({ primary: failing(primary, "402 Payment Required"), backup: answer(backup, "Hi") });
    const fallback = new ModelFallback({ pi, resolve: async () => backup });
    await collect(
      fallback.wrap(inner)(primary, context, {
        apiKey: "openai-key",
        headers: { "x-openai": "1" },
        maxTokens: 32_000,
        reasoning: "high",
        sessionId: "session",
      }),
    );

    const options = inner.mock.calls[1]?.[2];
    expect(options).toMatchObject({ maxTokens: 8_000, sessionId: "session" });
    expect(options?.apiKey).toBeUndefined();
    expect(options?.headers).toBeUndefined();
    // The fallback cannot reason, so it answers without.
    expect(options?.reasoning).toBeUndefined();
    expect(fallback.fallbackRequest).toEqual({ provider: "openrouter", thinkingLevel: "off" });
  });
});
