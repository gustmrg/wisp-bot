// Spike (SWE-182, ADR 026): checks, against the person's own `claude` binary
// and sign-in, the Claude Agent SDK behaviors the Claude Code runtime relies
// on. Each check runs a short conversation with a small model in a fresh
// temporary directory, so it uses a little of the person's plan, and removes
// what Claude Code saved for it afterwards. Run by hand:
//
//   WISP_CLAUDE_CODE_SMOKE=1 node scripts/claude-code-smoke.mjs [check...]
//
// Until the SDK is a dependency, point WISP_CLAUDE_SDK_MODULES at a
// node_modules folder holding @anthropic-ai/claude-agent-sdk and
// @modelcontextprotocol/sdk. Tests never start the real binary.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODEL = process.env.WISP_CLAUDE_CODE_SMOKE_MODEL ?? "haiku";
const MODULES =
  process.env.WISP_CLAUDE_SDK_MODULES ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules");
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const report = [];
function check(name, ok, detail) {
  report.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).slice(0, 140)})` : ""}`);
}

const load = (specifier) => import(pathToFileURL(path.join(MODULES, specifier)).href);

/** The only environment Claude Code gets: no API keys, no Wisp variables, no claude.ai connectors. */
function cleanEnvironment() {
  const env = { ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
  for (const name of ["HOME", "PATH", "LANG", "TZ", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

async function run() {
  const { query } = await load("@anthropic-ai/claude-agent-sdk/sdk.mjs");
  const { McpServer } = await load("@modelcontextprotocol/sdk/dist/esm/server/mcp.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = await load("@modelcontextprotocol/sdk/dist/esm/types.js");
  const executable = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  const only = new Set(process.argv.slice(2));
  const wanted = (name) => only.size === 0 || only.has(name);

  /** Wisp's tools as an in-process MCP server, described with plain JSON Schema. */
  function wispServer(calls) {
    const mcp = new McpServer({ name: "wisp", version: "0.0.0" }, { capabilities: { tools: {} } });
    const tools = [
      {
        name: "echo",
        description: "Returns the text it is given, prefixed with 'wisp:'.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
      {
        name: "slow",
        description: "Waits the given number of seconds, then returns 'done'. Use only when asked.",
        inputSchema: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] },
      },
    ];
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push(request.params);
      if (request.params.name === "slow") {
        await new Promise((resolve) => setTimeout(resolve, request.params.arguments.seconds * 1000));
        return { content: [{ type: "text", text: "done" }] };
      }
      return { content: [{ type: "text", text: `wisp:${request.params.arguments.text}` }] };
    });
    return mcp;
  }

  /** A conversation: one long-lived Claude Code process fed from a queue. */
  function conversation(cwd, options) {
    const queue = [];
    let wake;
    let closed = false;
    async function* prompt() {
      while (!closed) {
        if (queue.length) yield queue.shift();
        else await new Promise((resolve) => (wake = resolve));
      }
    }
    const q = query({
      prompt: prompt(),
      options: {
        cwd,
        model: MODEL,
        pathToClaudeCodeExecutable: executable,
        env: cleanEnvironment(),
        settingSources: [],
        strictMcpConfig: true,
        extraArgs: { restricted: null },
        settings: { disableAllHooks: true },
        permissionMode: "default",
        includePartialMessages: true,
        ...options,
      },
    });
    const events = [];
    const results = [];
    let waiter;
    const done = (async () => {
      for await (const message of q) {
        events.push(message);
        if (message.type === "result") {
          results.push(message);
          waiter?.();
        }
      }
    })().catch((error) => events.push({ type: "crash", error: String(error) }));
    return {
      q,
      events,
      results,
      done,
      send(content, priority, uuid) {
        queue.push({
          type: "user",
          session_id: "",
          parent_tool_use_id: null,
          message: { role: "user", content },
          ...(priority ? { priority } : {}),
          ...(uuid ? { uuid } : {}),
        });
        wake?.();
      },
      /** The turn's result, or undefined when none came in time. */
      result(count, timeoutMs = 240_000) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve(results[count - 1]), timeoutMs);
          const settle = () => {
            if (results.length >= count) {
              clearTimeout(timer);
              resolve(results[count - 1]);
            }
          };
          waiter = settle;
          settle();
          done.then(() => {
            clearTimeout(timer);
            resolve(results[count - 1]);
          });
        });
      },
      close() {
        closed = true;
        wake?.();
        q.close();
      },
    };
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "wisp-claude-code-smoke-"));
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, ".claude"), { recursive: true });
  // A repository can bring hooks; they must never run.
  const hookMarker = path.join(root, "hook-ran");
  await writeFile(
    path.join(workspace, ".claude", "settings.json"),
    JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `touch ${hookMarker}` }] }] } }),
  );
  try {
    if (wanted("conversation")) {
      const calls = [];
      const asked = [];
      const c = conversation(workspace, {
        tools: [],
        mcpServers: { wisp: { type: "sdk", name: "wisp", instance: wispServer(calls), timeout: 3_900_000 } },
        allowedTools: ["mcp__wisp__*"],
        canUseTool: async (toolName) => {
          asked.push(toolName);
          return { behavior: "deny", message: "Denied by the smoke." };
        },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: "Your name is Lumen. When asked your name, answer only: Lumen.",
        },
        sessionId: randomUUID(),
      });
      c.send("Call the echo tool with the text 'ping'. Then tell me your name.");
      const first = await c.result(1);
      const init = c.events.find((event) => event.type === "system" && event.subtype === "init");
      check("signs in with the plan from a clean environment", init?.apiKeySource === "none", init?.apiKeySource);
      check(
        "offers only Wisp's in-process tools",
        (init?.tools ?? []).every((name) => name.startsWith("mcp__wisp__") || name === "EndConversation"),
        init?.tools?.join(","),
      );
      check(
        "runs Wisp's tools (JSON Schema) without asking",
        calls.some((call) => call.name === "echo") && asked.length === 0,
      );
      check("appends the Wisp's prompt", /lumen/i.test(first?.result ?? ""), first?.result);
      check("does not run the repository's hooks", !(await exists(hookMarker)));

      c.send("What text did you send to the echo tool? One word.");
      const second = await c.result(2);
      check("keeps one process across turns", /ping/i.test(second?.result ?? ""), second?.result);

      c.send([
        { type: "text", text: "Reply with one word: did you receive an image?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PIXEL_PNG } },
      ]);
      const image = await c.result(3);
      check("accepts an image", /yes/i.test(image?.result ?? ""), image?.result);

      c.send("Write the numbers from 1 to 300, one per line, nothing else.");
      await until(() => c.results.length === 3 && c.events.at(-1)?.type === "stream_event");
      await c.q.interrupt();
      const interrupted = await c.result(4);
      c.send("Reply with the single word: still-here");
      const after = await c.result(5);
      check(
        "interrupts a reply and keeps the session",
        interrupted?.subtype === "error_during_execution" && /still-here/i.test(after?.result ?? ""),
        `${interrupted?.subtype} / ${after?.result}`,
      );
      c.close();
    }

    if (wanted("steer")) {
      const calls = [];
      const c = conversation(workspace, {
        tools: [],
        mcpServers: { wisp: { type: "sdk", name: "wisp", instance: wispServer(calls), timeout: 3_900_000 } },
        allowedTools: ["mcp__wisp__*"],
      });
      c.send(
        "Do these one at a time, waiting for each result: call slow with seconds=4, then slow with seconds=4, then slow with seconds=4. Then reply 'finished'.",
      );
      await until(() => calls.length >= 1);
      const followUp = randomUUID();
      c.send(
        "Change of plan: skip the remaining slow calls, call echo with 'steered', and reply with its result.",
        "next",
        followUp,
      );
      const first = await c.result(1);
      const second = await c.result(2, 20_000);
      const slowCalls = calls.filter((call) => call.name === "slow").length;
      check(
        "a 'next' follow-up steers the running turn",
        calls.some((call) => call.name === "echo") && slowCalls < 3 && second === undefined,
        `slow=${slowCalls} reply=${first?.result}`,
      );
      // The session emits follow_up_taken from either of these.
      const read = c.events.some(
        (event) =>
          (event.type === "command_lifecycle" && event.state === "started" && event.command_uuid === followUp) ||
          (event.type === "assistant" && event.user_message_uuid === followUp),
      );
      check("Claude Code reports when it reads the follow-up", read);
      c.close();
    }

    if (wanted("withdraw")) {
      const calls = [];
      const c = conversation(workspace, {
        tools: [],
        mcpServers: { wisp: { type: "sdk", name: "wisp", instance: wispServer(calls), timeout: 3_900_000 } },
        allowedTools: ["mcp__wisp__*"],
      });
      c.send("Call slow with seconds=3, then reply 'finished'.");
      await until(() => calls.length >= 1);
      const queued = randomUUID();
      // "later" waits for the turn to end, so it is still queued when withdrawn.
      c.send("Reply 'withdrawn message ran'.", "later", queued);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const cancelled = await c.q.cancelAsyncMessage(queued);
      await c.result(1);
      const second = await c.result(2, 15_000);
      check(
        "a queued follow-up can be withdrawn",
        cancelled === true && second === undefined,
        `cancelled=${cancelled}`,
      );
      c.close();
    }

    if (wanted("plan")) {
      const c = conversation(workspace, { tools: [] });
      c.send("Reply 'ok'.");
      await c.result(1);
      const info = c.events.find((event) => event.type === "rate_limit_event")?.rate_limit_info;
      if (process.env.WISP_CLAUDE_CODE_SMOKE_TRACE) console.log(JSON.stringify(info));
      // The session reads the plan's usage from these windows.
      const windows = info?.unifiedWindows ?? {};
      check(
        "reports the plan's 5-hour and 7-day usage",
        ["five_hour", "seven_day"].every((name) => typeof windows[name]?.utilization === "number"),
        info ? Object.keys(info).join(",") : "no rate_limit_event",
      );
      c.close();
    }

    if (wanted("missing")) {
      const c = conversation(workspace, { tools: [], resume: randomUUID() });
      c.send("Hello");
      const result = await c.result(1, 60_000);
      const crash = c.events.find((event) => event.type === "crash");
      check(
        "reports a session that no longer exists",
        result?.is_error === true || crash !== undefined,
        crash?.error ?? `${result?.subtype} ${result?.result}`,
      );
      c.close();
    }

    if (wanted("websearch")) {
      const asked = [];
      const c = conversation(workspace, {
        tools: ["WebSearch"],
        canUseTool: async (toolName, input) => {
          asked.push({ toolName, input });
          return { behavior: "allow", updatedInput: input };
        },
      });
      c.send("Use web search to find the current stable version of Node.js. One short sentence.");
      const result = await c.result(1);
      check(
        "sends WebSearch to canUseTool",
        asked.some((ask) => ask.toolName === "WebSearch" && typeof ask.input.query === "string"),
        result?.subtype,
      );
      c.close();
    }

    if (wanted("slow")) {
      const calls = [];
      const c = conversation(workspace, {
        tools: [],
        mcpServers: { wisp: { type: "sdk", name: "wisp", instance: wispServer(calls), timeout: 3_900_000 } },
        allowedTools: ["mcp__wisp__*"],
      });
      c.send("Call the slow tool with seconds=75, then reply with its result only.");
      const result = await c.result(1, 300_000);
      check("lets a Wisp tool take longer than 60 s", /done/i.test(result?.result ?? ""), result?.result);
      c.close();
    }
  } finally {
    try {
      execFileSync(executable, ["purge", workspace, "--yes"], { stdio: "ignore" });
    } catch {
      console.warn(`Could not purge Claude Code's data for ${workspace}; run: claude purge ${workspace}`);
    }
    await rm(root, { recursive: true, force: true });
  }
  process.exitCode = report.every(({ ok }) => ok) ? 0 : 1;
}

async function until(condition, timeoutMs = 120_000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for the conversation.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

if (process.env.WISP_CLAUDE_CODE_SMOKE !== "1") {
  console.error("The Claude Code smoke is disabled. Set WISP_CLAUDE_CODE_SMOKE=1 explicitly to enable it.");
  process.exitCode = 2;
} else {
  await run();
}
