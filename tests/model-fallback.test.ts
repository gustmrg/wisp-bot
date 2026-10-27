import { describe, expect, it, vi } from "vitest";

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";

import { ModelFallback, shouldFallBack } from "../backend/model-fallback.js";
import { MODEL_HOLD_MS, ModelHolds } from "../backend/model-holds.js";

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
    const fallback = new ModelFallback({ pi, resolve: async () => [backup], onFallback });
    const stream = fallback.wrap(inner);

    const events = await collect(stream(primary, context, {}));
    expect(events.map(({ type }) => type)).toEqual(["start", "text_start", "text_delta", "done"]);
    expect(
      events.every(
        (event) => (event.type === "error" ? event.error : (event.partial ?? event.message))?.provider === "openrouter",
      ),
    ).toBe(true);
    expect(onFallback).toHaveBeenCalledExactlyOnceWith(backup, undefined);

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
    const fallback = new ModelFallback({ pi, resolve: async () => [] });
    expect(await collect(fallback.wrap(provider({ primary: events }))(primary, context, {}))).toEqual(events);
  });

  it("keeps the model's own error for failures Pi retries when it has no retries to wait for", async () => {
    const events = failing(primary, "429 Too Many Requests: rate limit reached");
    const resolve = vi.fn(async () => [backup]);
    const fallback = new ModelFallback({ pi, resolve });
    expect(await collect(fallback.wrap(provider({ primary: events }))(primary, context, {}))).toEqual(events);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("answers with the fallback once Pi's retries of a failure that may pass have run out", async () => {
    const inner = provider({ primary: failing(primary, "429 Too Many Requests"), backup: answer(backup, "Hi") });
    const onFallback = vi.fn();
    const resolve = vi.fn(async () => [backup]);
    const stream = new ModelFallback({ pi, resolve, onFallback, retries: 2 }).wrap(inner);

    // The first call and Pi's two retries: the first two failures are Pi's to retry.
    expect((await collect(stream(primary, context, {}))).at(-1)?.type).toBe("error");
    expect((await collect(stream(primary, context, {}))).at(-1)?.type).toBe("error");
    expect(resolve).not.toHaveBeenCalled();
    expect((await collect(stream(primary, context, {}))).at(-1)?.type).toBe("done");
    expect(onFallback).toHaveBeenCalledExactlyOnceWith(backup, undefined);
    expect(inner.mock.calls.map(([requested]) => requested.id)).toEqual(["primary", "primary", "primary", "backup"]);
  });

  it("counts the retries again after the model answers, and never moves a request too large", async () => {
    let next: AssistantMessageEvent[] = failing(primary, "503 Service Unavailable");
    const inner = vi.fn<StreamFn>((requested) => streamOf(requested.id === "backup" ? answer(backup, "Hi") : next));
    const resolve = vi.fn(async () => [backup]);
    const stream = new ModelFallback({ pi, resolve, retries: 2 }).wrap(inner);

    await collect(stream(primary, context, {}));
    await collect(stream(primary, context, {}));
    next = answer(primary, "Back");
    await collect(stream(primary, context, {}));
    next = failing(primary, "503 Service Unavailable");
    await collect(stream(primary, context, {}));
    await collect(stream(primary, context, {}));
    expect(resolve).not.toHaveBeenCalled();

    next = failing(primary, "400 prompt is too long: 250000 tokens > 200000 maximum");
    for (let call = 0; call < 4; call += 1) await collect(stream(primary, context, {}));
    expect(resolve).not.toHaveBeenCalled();
  });

  it("holds a model whose retries of a rate limit ran out, starting later turns on the fallback until the hold ends", async () => {
    let now = Date.parse("2026-10-26T14:00:00.000Z");
    const holds = new ModelHolds(() => now);
    const inner = provider({ primary: failing(primary, "429 Too Many Requests"), backup: answer(backup, "Hi") });
    const onFallback = vi.fn();
    const fallback = new ModelFallback({
      pi,
      resolve: async () => [backup],
      onFallback,
      retries: 2,
      holds,
      now: () => now,
    });
    const stream = fallback.wrap(inner);
    for (let call = 0; call < 3; call += 1) await collect(stream(primary, context, {}));
    const until = now + MODEL_HOLD_MS;
    expect(onFallback).toHaveBeenLastCalledWith(backup, until);
    expect(holds.heldUntil(primary)).toBe(until);

    // The next turn goes straight to the fallback, without trying the held model.
    fallback.reset();
    now += 60_000;
    await collect(stream(primary, context, {}));
    expect(inner.mock.calls.map(([requested]) => requested.id)).toEqual([
      "primary",
      "primary",
      "primary",
      "backup",
      "backup",
    ]);
    expect(onFallback).toHaveBeenLastCalledWith(backup, until);

    // Once the hold ends, the Wisp's own model answers again.
    fallback.reset();
    now = until;
    await collect(stream(primary, context, {}));
    expect(inner.mock.calls.at(-1)?.[0].id).toBe("primary");
  });

  it("holds no model for a failure that does not pass with time, and keeps a held model without a fallback", async () => {
    const holds = new ModelHolds();
    const inner = provider({ primary: failing(primary, "fetch failed"), backup: answer(backup, "Hi") });
    const onFallback = vi.fn();
    const stream = new ModelFallback({ pi, resolve: async () => [backup], onFallback, retries: 2, holds }).wrap(inner);
    for (let call = 0; call < 3; call += 1) await collect(stream(primary, context, {}));
    expect(onFallback).toHaveBeenCalledExactlyOnceWith(backup, undefined);
    expect(holds.heldUntil(primary)).toBeUndefined();

    holds.hold(primary, Date.now() + MODEL_HOLD_MS);
    const alone = provider({ primary: answer(primary, "Mine") });
    await collect(new ModelFallback({ pi, resolve: async () => [], holds }).wrap(alone)(primary, context, {}));
    expect(alone.mock.calls.map(([requested]) => requested.id)).toEqual(["primary"]);
  });

  it("moves on through the list when a fallback fails too, skipping one on hold", async () => {
    const third = model("google", "third");
    const fourth = model("mistral", "fourth");
    const holds = new ModelHolds();
    holds.hold(third, Date.now() + MODEL_HOLD_MS);
    const inner = provider({
      primary: failing(primary, "402 Payment Required"),
      backup: failing(backup, "401 invalid key"),
      fourth: answer(fourth, "Hi"),
    });
    const onFallback = vi.fn();
    const fallback = new ModelFallback({
      pi,
      resolve: async () => [primary, backup, third, fourth],
      onFallback,
      holds,
    });
    const stream = fallback.wrap(inner);

    expect((await collect(stream(primary, context, {}))).at(-1)?.type).toBe("done");
    expect(inner.mock.calls.map(([requested]) => requested.id)).toEqual(["primary", "backup", "fourth"]);
    expect(onFallback.mock.calls.map(([to]) => to.id)).toEqual(["backup", "fourth"]);

    // The rest of the turn stays on the fallback that answered.
    await collect(stream(primary, context, {}));
    expect(inner.mock.calls.at(-1)?.[0].id).toBe("fourth");
  });

  it("reports the last fallback's own error when every fallback fails", async () => {
    const inner = provider({
      primary: failing(primary, "402 Payment Required"),
      backup: failing(backup, "401 invalid key"),
    });
    const events = await collect(
      new ModelFallback({ pi, resolve: async () => [backup] }).wrap(inner)(primary, context, {}),
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { provider: "openrouter", errorMessage: "401 invalid key" },
    });
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
    const fallback = new ModelFallback({ pi, resolve: async () => [backup] });
    expect(await collect(fallback.wrap(inner)(primary, context, {}))).toEqual(events);
    expect(inner).toHaveBeenCalledOnce();
  });

  it("does not move a request that was stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = failing(primary, "402 Payment Required");
    const inner = provider({ primary: events, backup: answer(backup, "Hi") });
    const fallback = new ModelFallback({ pi, resolve: async () => [backup] });
    expect(await collect(fallback.wrap(inner)(primary, context, { signal: controller.signal }))).toEqual(events);
    expect(inner).toHaveBeenCalledOnce();
  });

  it("keeps the model's own error when the fallback cannot start", async () => {
    const events = failing(primary, "401 invalid x-api-key");
    const inner = vi.fn<StreamFn>((requested) => {
      if (requested.id === "backup") throw new Error("No API key for openrouter");
      return streamOf(events);
    });
    const fallback = new ModelFallback({ pi, resolve: async () => [backup] });
    expect(await collect(fallback.wrap(inner)(primary, context, {}))).toEqual(events);
    expect(fallback.fallbackRequest).toBeUndefined();
  });

  it("sends the fallback its own limits and none of the other provider's credentials", async () => {
    const inner = provider({ primary: failing(primary, "402 Payment Required"), backup: answer(backup, "Hi") });
    const fallback = new ModelFallback({ pi, resolve: async () => [backup] });
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

describe("ModelFallback in a real Pi session", () => {
  it("lets Pi retry a rate limit twice, then answers with the fallback, which ends the retries well", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-fallback-retries-"));
    const { createAgentSession, ModelRuntime, SessionManager, SettingsManager } = await import(
      "@earendil-works/pi-coding-agent"
    );
    try {
      const runtime = await ModelRuntime.create({
        authPath: path.join(directory, "auth.json"),
        modelsPath: null,
        modelsStorePath: path.join(directory, "models.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      const own = pi.fauxProvider({ provider: "wisp-test-own", models: [{ id: "own" }] });
      const spare = pi.fauxProvider({ provider: "wisp-test-spare", models: [{ id: "spare" }] });
      runtime.registerNativeProvider(own.provider);
      runtime.registerNativeProvider(spare.provider);
      const limited = () => pi.fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Too Many Requests" });
      own.setResponses([limited, limited, limited, limited]);
      spare.setResponses([pi.fauxAssistantMessage("From the spare.")]);

      const { session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        model: own.getModel(),
        modelRuntime: runtime,
        sessionManager: SessionManager.inMemory(directory),
        settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } }),
      });
      const onFallback = vi.fn();
      session.agent.streamFunction = new ModelFallback({
        pi,
        resolve: async () => [spare.getModel() as Model<Api>],
        onFallback,
        retries: 2,
      }).wrap(session.agent.streamFunction);
      const events: Array<{ type: string; success?: boolean }> = [];
      session.subscribe((event) => events.push(event as { type: string; success?: boolean }));

      await session.prompt("Hello");

      expect(own.state.callCount).toBe(3);
      expect(onFallback).toHaveBeenCalledOnce();
      expect(events.filter(({ type }) => type === "auto_retry_start")).toHaveLength(2);
      expect(events.find(({ type }) => type === "auto_retry_end")).toMatchObject({ success: true });
      const last = session.messages.at(-1);
      expect(last).toMatchObject({ role: "assistant", provider: "wisp-test-spare", stopReason: "stop" });
      session.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
