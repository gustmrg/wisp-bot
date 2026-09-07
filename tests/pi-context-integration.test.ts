import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { SdkPiSessionFactory, type PiSessionLike } from "../electron/backend/pi-conversation-agent.js";
import { DEFAULT_CONTEXT_POLICY } from "../shared/context-policy.js";

it("preserves continuity through real SDK compaction and a fresh-topic restart, with simulated transport", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisp-context-sdk-"));
  const requests: Record<string, unknown>[] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (!String(url).includes("/chat/completions")) throw new Error("Unexpected network request blocked");
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const lastMessage = body.messages[body.messages.length - 1];
    if (lastMessage.role === "user" && JSON.stringify(lastMessage.content).includes("Find old SQLite decision")) {
      const chunk = {
        id: "history",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "history-1",
                  type: "function",
                  function: { name: "search_history", arguments: JSON.stringify({ query: "Turn 0" }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    const chunks = [
      {
        id: "synthetic",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Decision: SQLite. Pending: migrate data." },
            finish_reason: null,
          },
        ],
      },
      {
        id: "synthetic",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 14000, completion_tokens: 20, total_tokens: 14020 },
      },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  });
  let session: PiSessionLike | undefined;
  try {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create({
      authPath: path.join(root, "auth.json"),
      modelsPath: null,
      modelsStorePath: path.join(root, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    await runtime.setRuntimeApiKey("openrouter", "synthetic-test-key");
    const context = {
      conversationId: "audit",
      sessionId: "audit-context",
      name: "Audit",
      label: "Test",
      description: "Synthetic context audit",
      workspaceDirectory: path.join(root, "workspace"),
      sessionDirectory: path.join(root, "sessions"),
      configDirectory: path.join(root, "config"),
      piSessionId: null as string | null,
      piSessionFile: null as string | null,
      onContextRenewed: vi.fn(),
    };
    for (const key of ["workspaceDirectory", "sessionDirectory", "configDirectory"] as const)
      await mkdir(context[key], { recursive: true });
    const factory = new SdkPiSessionFactory(runtime);
    const selection = { providerId: "openrouter", modelId: "anthropic/claude-sonnet-4" };
    session = await factory.create(context, selection);
    await session.manageContext!({ action: "save", policy: DEFAULT_CONTEXT_POLICY, memory: "Prefer Portuguese" });
    // Settings survive even before the first assistant message creates the Pi transcript.
    session.dispose();
    session = await factory.create(context, selection);
    expect((await session.manageContext!({ action: "get" })).memory).toBe("Prefer Portuguese");
    for (let turn = 0; turn < 3; turn++)
      await session.prompt(`Turn ${turn}: SQLite. ${"Synthetic background. ".repeat(500)}`);
    expect(JSON.stringify(requests[0])).toContain("Prefer Portuguese");
    const summarized = await session.manageContext!({ action: "compact" });
    expect(summarized.summary).toContain("SQLite");
    expect(context.onContextRenewed).toHaveBeenCalledWith("compacted", expect.any(String));
    await session.prompt("Continue the pending task");
    expect(JSON.stringify(requests[requests.length - 1])).toContain("Pending: migrate data");
    await session.manageContext!({ action: "new_topic" });
    const identity = { piSessionId: session.sessionId, piSessionFile: session.sessionFile! };
    session.dispose();
    session = await factory.create({ ...context, ...identity }, selection);
    expect((await session.manageContext!({ action: "get" })).summary).toBeNull();
    await session.prompt("New independent question");
    const last = requests[requests.length - 1];
    expect(JSON.stringify(last)).not.toContain("Turn 0:");
    expect(JSON.stringify(last)).toContain("Prefer Portuguese");
    expect(last?.messages as unknown[]).toHaveLength(2);
    expect(session.getActiveToolNames()).toContain("search_history");
    await session.prompt("Find old SQLite decision");
    const searched = requests[requests.length - 1]?.messages as { role: string; content: unknown }[];
    expect(
      searched.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("Turn 0")),
    ).toBe(true);
  } finally {
    session?.dispose();
    fetch.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
