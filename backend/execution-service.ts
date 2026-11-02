import type { BashOperations, ToolDefinition } from "@earendil-works/pi-coding-agent" with {
  "resolution-mode": "import",
};
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  CONTAINER_WORKSPACE,
  EXECUTION_MODES,
  isContainerImage,
  isGitToken,
  isGitUpstream,
  MAX_COMMAND_DESCRIPTION_LENGTH,
  type CommandResultDetails,
  type ContainerRuntimeStatus,
  type ExecutionMode,
  type SaveWispExecutionRequest,
  type WispExecutionView,
} from "../shared/execution.js";
import { formatBytes } from "../shared/workspace.js";
import { writeFileAtomically } from "./atomic-file.js";
import { WispBackendError } from "./backend-error.js";
import type { ContainerCli } from "./container-cli.js";
import {
  MAX_BACKGROUND_PROCESSES,
  SANDBOX_IMAGE,
  type ContainerManager,
  type ContainerSpec,
  type ProcessAction,
} from "./container-manager.js";
import type { GitForges } from "./egress-proxy.js";
import {
  snapshotRevision,
  type AgentScope,
  type IntegrationToolSnapshot,
  type IntegrationToolSource,
} from "./integration-tool-source.js";
import type { ToolAuthorizationBroker } from "./tool-authorization-broker.js";
import { defineWispTool } from "./tool-schema.js";
import { assertDiskReserve, freeDiskBytes, measureTree, readWorkspaceQuota } from "./workspace-service.js";

export const RUN_COMMAND_TOOL = "run_command";
export const PROCESS_TOOL = "process";
/** File inside a Wisp's config directory that holds where its commands run. */
export const EXECUTION_SETTINGS_FILE = "execution-settings.json";

function runCommandDescription(localNetwork: boolean): string {
  return [
    ...RUN_COMMAND_DESCRIPTION,
    localNetwork
      ? "The internet and the local network are reachable."
      : "The internet is reachable through an HTTP proxy that tools find in HTTP_PROXY and HTTPS_PROXY (curl, git over HTTPS, npm, pip). Local and private network addresses are blocked, and connections that do not use the proxy, such as git over SSH, cannot leave the container.",
  ].join(" ");
}

const RUN_COMMAND_DESCRIPTION: ReadonlyArray<string> = [
  "Run a bash command in this Wisp's own Linux container (Debian) and return its output.",
  `The working directory is ${CONTAINER_WORKSPACE}, which holds the same files as the workspace file tools; paths in commands use ${CONTAINER_WORKSPACE}, and the file tools take paths relative to the workspace root, such as repo/src/index.ts.`,
  "Use it for git, builds, tests, package installs and other command-line work. git, curl, python3, node, npm, build-essential, ripgrep and jq are installed when the default image is used.",
  "Commands run as a regular user without sudo, so system packages cannot be installed; install tools into the home folder (pip --user, npm -g, downloads into ~/.local/bin). The home folder is inside the workspace and is kept; anything outside the workspace can disappear when the container is recreated.",
  "git over HTTPS to github.com, and to the GitLab plugin's instance when this Wisp has access to it, goes through a gateway on the server, which adds the plugin's token; the token is not in the container, and the gateway carries only git, so use the GitHub and GitLab tools for issues, pull and merge requests and other API calls.",
  "Each call starts a fresh shell in the working directory; use cd within the command. Processes left running in the background are stopped when the command ends; start servers, watchers and other long-running commands with the process tool instead. Output is truncated to the last lines; optionally give a timeout in seconds.",
];

/**
 * Commands refused before they reach the container. They would only damage
 * the Wisp's own container and workspace, but nothing good comes from them.
 * This guards against mistakes, not against a determined command: the
 * container is the boundary.
 */
const REFUSED_COMMANDS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern:
      /\brm\s+(?:-{1,2}[\w-]+\s+)*(?:\/|\/\*|~\/?|\$HOME\/?|\/workspace\/?|\/workspace\/\*|\.\/?|\*)(?=\s|$|[;&|)])/,
    reason: "deletes the whole workspace or container",
  },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "is a fork bomb" },
];

export interface ExecutionSettings {
  mode: ExecutionMode;
  image: string | null;
  /** Applies to the browser too. */
  localNetwork: boolean;
  browser: boolean;
}

const DEFAULT_SETTINGS: ExecutionSettings = { mode: "off", image: null, localNetwork: false, browser: false };

export interface ExecutionWisp {
  storageId: string;
  workspaceDirectory: string;
  configDirectory: string;
}

export interface ExecutionServiceOptions {
  dataDirectory: string;
  /** A Wisp's own conversation; throws for circles and unknown conversations. */
  resolveWisp: (conversationId: string) => ExecutionWisp;
  listWispStorageIds: () => ReadonlySet<string>;
  authorizationBroker: Pick<ToolAuthorizationBroker, "authorize">;
  manager: ContainerManager;
  runtime: { status(): Promise<ContainerRuntimeStatus>; cli(): Promise<ContainerCli | null> };
  /** The forges git can use through the gateway, with the tokens of the plugins the Wisp has access to. */
  gitForges?: (conversationId: string) => Promise<GitForges>;
  /** Closes a Wisp's browser, when it is turned off. */
  browser?: { close(storageId: string): Promise<void> };
  /** Free space on the disk holding a folder; defaults to asking the operating system. */
  freeDiskBytes?: (directory: string) => Promise<number>;
}

/**
 * Decides where each Wisp's commands run and supplies the `run_command` tool
 * to Wisps whose commands run in a container. Pi's own shell tools stay
 * excluded: commands never run on the server itself.
 */
export class ExecutionService implements IntegrationToolSource {
  constructor(private readonly options: ExecutionServiceOptions) {}

  async getView(conversationId: string): Promise<WispExecutionView> {
    const wisp = this.options.resolveWisp(conversationId);
    const [settings, runtime, container, git] = await Promise.all([
      readExecutionSettings(wisp.configDirectory),
      this.options.runtime.status(),
      this.options.manager.state(wisp.storageId),
      this.gitForges(conversationId),
    ]);
    return {
      ...settings,
      defaultImage: SANDBOX_IMAGE,
      gitHubPlugin: Boolean(git.github),
      gitLabInstance: git.gitlab?.upstream ?? null,
      runtime,
      container,
    };
  }

  /** Whether the server can run commands at all, before any Wisp is involved. */
  runtimeStatus(): Promise<ContainerRuntimeStatus> {
    return this.options.runtime.status();
  }

  async save(request: SaveWispExecutionRequest): Promise<WispExecutionView> {
    if (!EXECUTION_MODES.includes(request.mode)) throw invalid();
    if (request.image !== null && !isContainerImage(request.image)) {
      throw new WispBackendError("invalid_request", "Enter an image name such as node:22 or ghcr.io/owner/image:tag.");
    }
    const wisp = this.options.resolveWisp(request.conversationId);
    const previous = await readExecutionSettings(wisp.configDirectory);
    const next: ExecutionSettings = {
      mode: request.mode,
      image: request.image,
      localNetwork: request.localNetwork,
      browser: request.browser ?? previous.browser,
    };
    const containerChanged =
      previous.mode !== next.mode || previous.image !== next.image || previous.localNetwork !== next.localNetwork;
    if (containerChanged || previous.browser !== next.browser) {
      await writeFileAtomically(
        path.join(wisp.configDirectory, EXECUTION_SETTINGS_FILE),
        `${JSON.stringify(next, null, 2)}\n`,
      );
    }
    // Containers from the old settings must not keep running, the browser's included: each is created again when next used.
    if (containerChanged) await this.options.manager.remove(wisp.storageId);
    else if (previous.browser && !next.browser) await this.options.browser?.close(wisp.storageId);
    return this.getView(request.conversationId);
  }

  /**
   * Commands run only in a Wisp's own conversation: its container mounts its
   * own workspace, not a circle's (ADR 011).
   */
  async getSnapshot({ conversationId, wispId }: AgentScope): Promise<IntegrationToolSnapshot> {
    if (conversationId !== wispId) return emptySnapshot();
    let wisp: ExecutionWisp;
    try {
      wisp = this.options.resolveWisp(conversationId);
    } catch {
      return emptySnapshot();
    }
    // Unreadable settings leave commands off rather than preventing the Wisp from starting.
    const settings = await readExecutionSettings(wisp.configDirectory).catch(() => DEFAULT_SETTINGS);
    if (settings.mode !== "container") return emptySnapshot();
    const runtime = await this.options.runtime.status();
    if (!runtime.available) return emptySnapshot();
    return {
      definitions: [
        await this.createRunCommandTool(conversationId, wisp, settings),
        this.createProcessTool(conversationId, wisp, settings),
      ],
      metadata: [],
      activeNames: [RUN_COMMAND_TOOL, PROCESS_TOOL],
      revision: snapshotRevision([
        RUN_COMMAND_TOOL,
        settings.image ?? SANDBOX_IMAGE,
        runtime.name,
        settings.localNetwork ? "local-network" : "internet-only",
      ]),
    };
  }

  /** Removes containers whose Wisp was deleted. */
  async reconcile(): Promise<void> {
    await this.options.manager.reconcile(this.options.listWispStorageIds());
  }

  /** The plugins' tokens, which the git gateway adds for this Wisp; a forge without a usable token is left out. */
  private async gitForges(conversationId: string): Promise<GitForges> {
    const forges = await this.options.gitForges?.(conversationId).catch(() => undefined);
    const { github, gitlab } = forges ?? {};
    return {
      ...(github && isGitToken(github.token) ? { github: { token: github.token } } : {}),
      ...(gitlab && isGitToken(gitlab.token) && isGitUpstream(gitlab.upstream)
        ? { gitlab: { upstream: gitlab.upstream, token: gitlab.token } }
        : {}),
    };
  }

  private async createRunCommandTool(
    conversationId: string,
    wisp: ExecutionWisp,
    settings: ExecutionSettings,
  ): Promise<ToolDefinition> {
    const { createBashToolDefinition } = await import("@earendil-works/pi-coding-agent");
    const operations: BashOperations = {
      // The environment Pi offers is the server's own; none of it is passed to the container.
      exec: async (command, cwd, { onData, signal, timeout }) =>
        this.options.manager.exec(containerSpec(wisp, settings), command, containerPath(wisp.workspaceDirectory, cwd), {
          onData,
          ...(signal ? { signal } : {}),
          ...(timeout === undefined ? {} : { timeout }),
          git: await this.gitForges(conversationId),
        }),
    };
    const base = createBashToolDefinition(wisp.workspaceDirectory, { operations, exposeSessionEnvironment: false });
    const execute: typeof base.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
      assertAllowedCommand(params.command);
      await this.authorize(
        conversationId,
        toolCallId,
        RUN_COMMAND_TOOL,
        "Run a command in the Wisp's container",
        signal,
      );
      await assertRoomToRun(wisp, this.options.freeDiskBytes);
      const startedAt = performance.now();
      const result = await base.execute(toolCallId, params, signal, onUpdate, ctx);
      const exitCode = (result.structuredContent as { exit_code?: unknown } | undefined)?.exit_code;
      // Kept with the session so its report can tell how each command ended.
      const commandResult: CommandResultDetails = {
        ...(typeof exitCode === "number" ? { exitCode } : {}),
        durationMs: Math.round(performance.now() - startedAt),
      };
      return { ...result, details: { ...result.details, commandResult } };
    };
    // Plain JSON Schema, like the process tool's, with a description the usage report can show.
    const parameters = JSON.parse(JSON.stringify(base.parameters)) as { properties: Record<string, unknown> };
    parameters.properties.description = {
      type: "string",
      maxLength: MAX_COMMAND_DESCRIPTION_LENGTH,
      description:
        "A few words on what the command does, shown to the user in the Wisp's usage report (for example: Run the test suite). Never include secrets.",
    };
    return {
      ...base,
      name: RUN_COMMAND_TOOL,
      label: "Run command",
      description: runCommandDescription(settings.localNetwork),
      parameters,
      promptSnippet: "Run bash commands in this Wisp's Linux container",
      promptGuidelines: undefined,
      execute,
    } as unknown as ToolDefinition;
  }

  private authorize(
    conversationId: string,
    toolCallId: string,
    toolName: string,
    summary: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    return this.options.authorizationBroker.authorize(
      {
        // Commands run only in the Wisp's own conversation, which shares its ID.
        conversationId,
        wispId: conversationId,
        toolCallId,
        toolName,
        category: "container_command",
        summary,
        scope: { kind: "container", value: "Wisp container" },
      },
      signal,
    );
  }

  private createProcessTool(conversationId: string, wisp: ExecutionWisp, settings: ExecutionSettings): ToolDefinition {
    const spec = containerSpec(wisp, settings);
    const run = async (action: ProcessAction, args: ReadonlyArray<string>, signal: AbortSignal | undefined) => {
      const git = action === "start" ? await this.gitForges(conversationId) : undefined;
      return this.options.manager.processScript(spec, action, args, {
        ...(signal ? { signal } : {}),
        ...(git ? { git } : {}),
      });
    };
    return defineWispTool({
      name: PROCESS_TOOL,
      label: "Background process",
      description: PROCESS_DESCRIPTION,
      parameters: PROCESS_PARAMETERS,
      execute: async (toolCallId, params, signal) => {
        const request = parseProcessParams(params);
        await this.authorize(conversationId, toolCallId, PROCESS_TOOL, PROCESS_SUMMARIES[request.action], signal);
        return {
          content: [
            { type: "text", text: await processResult(request, run, signal, wisp, this.options.freeDiskBytes) },
          ],
          details: {},
        };
      },
    });
  }
}

const MAX_PROCESS_COMMAND_LENGTH = 10_000;
const MAX_PROCESS_LOG_LINES = 500;
const MAX_PROCESS_WAIT_SECONDS = 300;
const DEFAULT_PROCESS_LOG_LINES = 50;
const DEFAULT_PROCESS_WAIT_SECONDS = 30;

const PROCESS_DESCRIPTION = [
  "Run long-running commands in the background of this Wisp's container, such as dev servers, watchers and long builds, and check on them.",
  "action=start runs `command` from /workspace in its own process and returns an id with its first output; action=list shows every process with its state;",
  "action=log returns the last `lines` lines of a process's output; action=wait waits up to `timeout` seconds for it to end and returns its state and output; action=kill stops it and everything it started.",
  `At most ${MAX_BACKGROUND_PROCESSES} processes run at once. They can be reached from run_command (for example curl http://localhost:3000), not from the user's browser.`,
  "They stop with the container, which stops after 30 minutes without a command or process call; their output is lost then.",
].join(" ");

const PROCESS_SUMMARIES: Record<ProcessAction, string> = {
  start: "Start a background process in the Wisp's container",
  list: "List background processes in the Wisp's container",
  log: "Read a background process's output",
  wait: "Wait for a background process to end",
  kill: "Stop a background process in the Wisp's container",
};

const PROCESS_ID_MESSAGE = "Give the id of a process, as returned by action=start or action=list.";

export const PROCESS_PARAMETERS = z.strictObject({
  action: z.enum(["start", "list", "log", "wait", "kill"], { error: "action must be start, list, log, wait or kill." }),
  command: z
    .string()
    .min(1, "Give the command to start.")
    .max(MAX_PROCESS_COMMAND_LENGTH, "The command is too long.")
    .optional(),
  id: z
    .string()
    .regex(/^[a-f0-9]{8}$/, PROCESS_ID_MESSAGE)
    .optional(),
  lines: z.int().min(1).max(MAX_PROCESS_LOG_LINES).optional(),
  timeout: z.int().min(1).max(MAX_PROCESS_WAIT_SECONDS).optional(),
});

type ProcessRequest =
  | { action: "start"; command: string }
  | { action: "list" }
  | { action: "log"; id: string; lines: number }
  | { action: "wait"; id: string; lines: number; timeout: number }
  | { action: "kill"; id: string };

/** The schema checks each field; this checks which fields the action needs. */
function parseProcessParams(params: z.output<typeof PROCESS_PARAMETERS>): ProcessRequest {
  const id = () => {
    if (params.id === undefined) throw new Error(PROCESS_ID_MESSAGE);
    return params.id;
  };
  switch (params.action) {
    case "start":
      if (!params.command?.trim()) throw new Error("Give the command to start.");
      assertAllowedCommand(params.command);
      return { action: "start", command: params.command };
    case "list":
      return { action: "list" };
    case "log":
      return { action: "log", id: id(), lines: params.lines ?? DEFAULT_PROCESS_LOG_LINES };
    case "wait":
      return {
        action: "wait",
        id: id(),
        lines: params.lines ?? DEFAULT_PROCESS_LOG_LINES,
        timeout: params.timeout ?? DEFAULT_PROCESS_WAIT_SECONDS,
      };
    case "kill":
      return { action: "kill", id: id() };
  }
}

type ProcessRunner = (
  action: ProcessAction,
  args: ReadonlyArray<string>,
  signal: AbortSignal | undefined,
) => Promise<{ exitCode: number; stdout: string } | null>;

const STOPPED_CONTAINER =
  "The container is not running, so no background processes are running and their output is gone.";

async function processResult(
  request: ProcessRequest,
  run: ProcessRunner,
  signal: AbortSignal | undefined,
  wisp: ExecutionWisp,
  measureFreeDisk: ((directory: string) => Promise<number>) | undefined,
): Promise<string> {
  const unknown = (id: string) => `There is no process ${id}. Use action=list to see the processes.`;
  switch (request.action) {
    case "start": {
      await assertRoomToRun(wisp, measureFreeDisk);
      const id = randomUUID().replace(/-/g, "").slice(0, 8);
      const result = (await run("start", [id, request.command, String(MAX_BACKGROUND_PROCESSES)], signal))!;
      if (result.exitCode === 3) {
        throw new Error(
          `${MAX_BACKGROUND_PROCESSES} background processes are already running. Stop one with action=kill first.`,
        );
      }
      if (result.exitCode !== 0) throw new Error("The process could not be started.");
      const output = result.stdout.trim();
      return `Started process ${id}.\n${output ? `First output:\n${output}` : "No output yet."}`;
    }
    case "list": {
      const result = await run("list", [], signal);
      if (!result) return STOPPED_CONTAINER;
      const now = Math.floor(Date.now() / 1000);
      const rows = result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [id, state, started, command] = line.split("\t");
          const minutes = Math.max(0, Math.round((now - Number(started)) / 60));
          return `${id}  ${state}  started ${minutes} min ago  ${command ?? ""}`;
        });
      return rows.length ? rows.join("\n") : "No background processes.";
    }
    case "log": {
      const result = await run("log", [request.id, String(request.lines)], signal);
      if (!result) return STOPPED_CONTAINER;
      if (result.exitCode === 4) return unknown(request.id);
      return result.stdout.trim() || "No output yet.";
    }
    case "wait": {
      const result = await run("wait", [request.id, String(request.timeout), String(request.lines)], signal);
      if (!result) return STOPPED_CONTAINER;
      if (result.exitCode === 4) return unknown(request.id);
      const [state = "unknown", ...output] = result.stdout.split("\n");
      const status = state === "running" ? `Still running after ${request.timeout} seconds.` : `Process ${state}.`;
      const text = output.join("\n").trim();
      return `${status}\n${text ? `Last output:\n${text}` : "No output."}`;
    }
    case "kill": {
      const result = await run("kill", [request.id], signal);
      if (!result) return STOPPED_CONTAINER;
      if (result.exitCode === 4) return unknown(request.id);
      return `Process ${request.id} stopped.`;
    }
  }
}

function assertAllowedCommand(command: string): void {
  const refused = REFUSED_COMMANDS.find(({ pattern }) => pattern.test(command));
  if (refused) throw new Error(`This command was not run because it ${refused.reason}.`);
}

function containerSpec(wisp: ExecutionWisp, settings: ExecutionSettings): ContainerSpec {
  return {
    storageId: wisp.storageId,
    image: settings.image ?? SANDBOX_IMAGE,
    workspaceDirectory: wisp.workspaceDirectory,
    localNetwork: settings.localNetwork,
  };
}

/**
 * Commands are refused while the workspace holds more than its size, or,
 * without one, while its disk is down to the reserve. The container cannot be
 * stopped from writing past either mid-command, so this is checked between commands.
 */
async function assertRoomToRun(
  wisp: ExecutionWisp,
  measureFreeDisk: (directory: string) => Promise<number> = freeDiskBytes,
): Promise<void> {
  const quota = await readWorkspaceQuota(wisp.configDirectory);
  if (quota === null) {
    await assertDiskReserve(wisp.workspaceDirectory, 0, "before running more commands", measureFreeDisk);
    return;
  }
  const tree = await measureTree(wisp.workspaceDirectory);
  if (tree.bytes >= quota) {
    throw new WispBackendError(
      "invalid_request",
      `This Wisp's workspace is full (${formatBytes(tree.bytes)} of ${formatBytes(quota)} used). Free some space or give the workspace a larger size before running more commands.`,
    );
  }
}

/** The container path for a folder in the workspace; anything else maps to the workspace itself. */
export function containerPath(workspaceDirectory: string, directory: string): string {
  const relative = path.relative(workspaceDirectory, directory);
  if (!relative) return CONTAINER_WORKSPACE;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return CONTAINER_WORKSPACE;
  return path.posix.join(CONTAINER_WORKSPACE, ...relative.split(path.sep));
}

/** Where a Wisp's commands run, and whether it has a browser. */
export async function readExecutionSettings(configDirectory: string): Promise<ExecutionSettings> {
  let contents: string;
  try {
    contents = await readFile(path.join(configDirectory, EXECUTION_SETTINGS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS };
    throw new WispBackendError("internal_error", "The command settings could not be read.", true);
  }
  try {
    const { mode, image, localNetwork, browser } = JSON.parse(contents) as {
      mode?: unknown;
      image?: unknown;
      localNetwork?: unknown;
      browser?: unknown;
    };
    if (
      typeof mode === "string" &&
      EXECUTION_MODES.includes(mode as ExecutionMode) &&
      (image === null || (typeof image === "string" && isContainerImage(image))) &&
      (localNetwork === undefined || typeof localNetwork === "boolean") &&
      (browser === undefined || typeof browser === "boolean")
    ) {
      return { mode: mode as ExecutionMode, image, localNetwork: localNetwork ?? false, browser: browser ?? false };
    }
  } catch {
    // Falls through: a damaged file is reported like an unreadable one.
  }
  throw new WispBackendError("internal_error", "The command settings could not be read.", true);
}

function emptySnapshot(): IntegrationToolSnapshot {
  return { definitions: [], metadata: [], activeNames: [], revision: snapshotRevision([]) };
}

function invalid(): WispBackendError {
  return new WispBackendError("invalid_request", "The backend request is invalid.");
}
