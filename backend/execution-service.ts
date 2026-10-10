import type { BashOperations, ToolDefinition } from "@earendil-works/pi-coding-agent" with {
  "resolution-mode": "import",
};
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CONTAINER_WORKSPACE,
  EXECUTION_MODES,
  isContainerImage,
  isGitToken,
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
import { EncryptedCredentialStore, type EncryptionService } from "./encrypted-credential-store.js";
import {
  snapshotRevision,
  type IntegrationToolSnapshot,
  type IntegrationToolSource,
} from "./integration-tool-source.js";
import type { ToolAuthorizationBroker } from "./tool-authorization-broker.js";
import { measureTree, readWorkspaceQuota } from "./workspace-service.js";

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
  `The working directory is ${CONTAINER_WORKSPACE}, which holds the same files as the workspace file tools; paths in commands use ${CONTAINER_WORKSPACE}.`,
  "Use it for git, builds, tests, package installs and other command-line work. git, curl, python3, node, npm, build-essential, ripgrep and jq are installed when the default image is used.",
  "Commands run as a regular user without sudo, so system packages cannot be installed; install tools into the home folder (pip --user, npm -g, downloads into ~/.local/bin). The home folder is inside the workspace and is kept; anything outside the workspace can disappear when the container is recreated.",
  "git over HTTPS to github.com uses the GitHub token configured for this Wisp, when there is one; never print or store the token.",
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

interface ExecutionSettings {
  mode: ExecutionMode;
  image: string | null;
  localNetwork: boolean;
}

const DEFAULT_SETTINGS: ExecutionSettings = { mode: "off", image: null, localNetwork: false };

export interface ExecutionWisp {
  storageId: string;
  workspaceDirectory: string;
  configDirectory: string;
}

export interface ExecutionServiceOptions {
  dataDirectory: string;
  encryption: EncryptionService;
  /** A Wisp's own conversation; throws for circles and unknown conversations. */
  resolveWisp: (conversationId: string) => ExecutionWisp;
  listWispStorageIds: () => ReadonlySet<string>;
  authorizationBroker: Pick<ToolAuthorizationBroker, "authorize">;
  manager: ContainerManager;
  runtime: { status(): Promise<ContainerRuntimeStatus>; cli(): Promise<ContainerCli | null> };
}

/**
 * Decides where each Wisp's commands run and supplies the `run_command` tool
 * to Wisps whose commands run in a container. Pi's own shell tools stay
 * excluded: commands never run on the server itself.
 */
export class ExecutionService implements IntegrationToolSource {
  private readonly credentials: EncryptedCredentialStore;

  constructor(private readonly options: ExecutionServiceOptions) {
    this.credentials = new EncryptedCredentialStore(
      path.join(options.dataDirectory, "execution-credentials.enc.json"),
      options.encryption,
    );
  }

  async getView(conversationId: string): Promise<WispExecutionView> {
    const wisp = this.options.resolveWisp(conversationId);
    const [settings, runtime, container, hasGitToken] = await Promise.all([
      readSettings(wisp.configDirectory),
      this.options.runtime.status(),
      this.options.manager.state(wisp.storageId),
      this.hasGitToken(wisp.storageId),
    ]);
    return { ...settings, defaultImage: SANDBOX_IMAGE, hasGitToken, runtime, container };
  }

  async save(request: SaveWispExecutionRequest): Promise<WispExecutionView> {
    if (!EXECUTION_MODES.includes(request.mode)) throw invalid();
    if (request.image !== null && !isContainerImage(request.image)) {
      throw new WispBackendError("invalid_request", "Enter an image name such as node:22 or ghcr.io/owner/image:tag.");
    }
    if (typeof request.gitToken === "string" && !isGitToken(request.gitToken)) {
      throw new WispBackendError("invalid_request", "The GitHub token has unexpected characters.");
    }
    const wisp = this.options.resolveWisp(request.conversationId);
    const previous = await readSettings(wisp.configDirectory);
    const next: ExecutionSettings = { mode: request.mode, image: request.image, localNetwork: request.localNetwork };
    if (request.gitToken === null) await this.credentials.delete(wisp.storageId);
    else if (request.gitToken !== undefined) {
      if (!this.credentials.isSecureStorageAvailable()) {
        throw new WispBackendError("secure_storage_unavailable", "Secure storage is not available to save the token.");
      }
      await this.credentials.setApiKey(wisp.storageId, request.gitToken);
    }
    if (previous.mode !== next.mode || previous.image !== next.image || previous.localNetwork !== next.localNetwork) {
      await writeFileAtomically(
        path.join(wisp.configDirectory, EXECUTION_SETTINGS_FILE),
        `${JSON.stringify(next, null, 2)}\n`,
      );
      // A container from the old settings must not keep running: it is created again on the next command.
      await this.options.manager.remove(wisp.storageId);
    }
    return this.getView(request.conversationId);
  }

  async getSnapshot(conversationId: string): Promise<IntegrationToolSnapshot> {
    let wisp: ExecutionWisp;
    try {
      wisp = this.options.resolveWisp(conversationId);
    } catch {
      return emptySnapshot();
    }
    // Unreadable settings leave commands off rather than preventing the Wisp from starting.
    const settings = await readSettings(wisp.configDirectory).catch(() => DEFAULT_SETTINGS);
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
    const known = this.options.listWispStorageIds();
    for (const { providerId } of await this.credentials.list().catch(() => [])) {
      if (!known.has(providerId)) await this.credentials.delete(providerId).catch(() => undefined);
    }
  }

  private async hasGitToken(storageId: string): Promise<boolean> {
    try {
      return Boolean(await this.credentials.read(storageId));
    } catch {
      return false;
    }
  }

  private async gitToken(storageId: string): Promise<string | undefined> {
    const credential = await this.credentials.read(storageId).catch(() => undefined);
    return credential?.type === "api_key" ? credential.key : undefined;
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
          ...(await this.gitToken(wisp.storageId).then((gitToken) => (gitToken ? { gitToken } : {}))),
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
      await assertRoomToRun(wisp);
      return base.execute(toolCallId, params, signal, onUpdate, ctx);
    };
    return {
      ...base,
      name: RUN_COMMAND_TOOL,
      label: "Run command",
      description: runCommandDescription(settings.localNetwork),
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
        conversationId,
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
      const gitToken = action === "start" ? await this.gitToken(wisp.storageId) : undefined;
      return this.options.manager.processScript(spec, action, args, {
        ...(signal ? { signal } : {}),
        ...(gitToken ? { gitToken } : {}),
      });
    };
    const execute = async (toolCallId: string, params: ProcessParams, signal?: AbortSignal) => {
      const request = parseProcessParams(params);
      await this.authorize(conversationId, toolCallId, PROCESS_TOOL, PROCESS_SUMMARIES[request.action], signal);
      return { content: [{ type: "text", text: await processResult(request, run, signal, wisp) }], details: {} };
    };
    return {
      name: PROCESS_TOOL,
      label: "Background process",
      description: PROCESS_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "list", "log", "wait", "kill"] },
          command: { type: "string", minLength: 1, maxLength: MAX_PROCESS_COMMAND_LENGTH },
          id: { type: "string", pattern: "^[a-f0-9]{8}$" },
          lines: { type: "integer", minimum: 1, maximum: MAX_PROCESS_LOG_LINES },
          timeout: { type: "integer", minimum: 1, maximum: MAX_PROCESS_WAIT_SECONDS },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute,
    } as unknown as ToolDefinition;
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

interface ProcessParams {
  action?: unknown;
  command?: unknown;
  id?: unknown;
  lines?: unknown;
  timeout?: unknown;
}

type ProcessRequest =
  | { action: "start"; command: string }
  | { action: "list" }
  | { action: "log"; id: string; lines: number }
  | { action: "wait"; id: string; lines: number; timeout: number }
  | { action: "kill"; id: string };

function parseProcessParams(params: ProcessParams): ProcessRequest {
  const id = () => {
    if (typeof params.id !== "string" || !/^[a-f0-9]{8}$/.test(params.id)) {
      throw new Error("Give the id of a process, as returned by action=start or action=list.");
    }
    return params.id;
  };
  const bounded = (value: unknown, fallback: number, max: number) =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 ? Math.min(value, max) : fallback;
  switch (params.action) {
    case "start":
      if (typeof params.command !== "string" || !params.command.trim()) throw new Error("Give the command to start.");
      if (params.command.length > MAX_PROCESS_COMMAND_LENGTH) throw new Error("The command is too long.");
      assertAllowedCommand(params.command);
      return { action: "start", command: params.command };
    case "list":
      return { action: "list" };
    case "log":
      return {
        action: "log",
        id: id(),
        lines: bounded(params.lines, DEFAULT_PROCESS_LOG_LINES, MAX_PROCESS_LOG_LINES),
      };
    case "wait":
      return {
        action: "wait",
        id: id(),
        lines: bounded(params.lines, DEFAULT_PROCESS_LOG_LINES, MAX_PROCESS_LOG_LINES),
        timeout: bounded(params.timeout, DEFAULT_PROCESS_WAIT_SECONDS, MAX_PROCESS_WAIT_SECONDS),
      };
    case "kill":
      return { action: "kill", id: id() };
    default:
      throw new Error("action must be start, list, log, wait or kill.");
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
): Promise<string> {
  const unknown = (id: string) => `There is no process ${id}. Use action=list to see the processes.`;
  switch (request.action) {
    case "start": {
      await assertRoomToRun(wisp);
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
 * Commands are refused while the workspace holds more than its size. The
 * container cannot be stopped from writing past it mid-command, so this is
 * checked between commands.
 */
async function assertRoomToRun(wisp: ExecutionWisp): Promise<void> {
  const [quota, tree] = await Promise.all([
    readWorkspaceQuota(wisp.configDirectory),
    measureTree(wisp.workspaceDirectory),
  ]);
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

async function readSettings(configDirectory: string): Promise<ExecutionSettings> {
  let contents: string;
  try {
    contents = await readFile(path.join(configDirectory, EXECUTION_SETTINGS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS };
    throw new WispBackendError("internal_error", "The command settings could not be read.", true);
  }
  try {
    const { mode, image, localNetwork } = JSON.parse(contents) as {
      mode?: unknown;
      image?: unknown;
      localNetwork?: unknown;
    };
    if (
      typeof mode === "string" &&
      EXECUTION_MODES.includes(mode as ExecutionMode) &&
      (image === null || (typeof image === "string" && isContainerImage(image))) &&
      (localNetwork === undefined || typeof localNetwork === "boolean")
    ) {
      return { mode: mode as ExecutionMode, image, localNetwork: localNetwork ?? false };
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
