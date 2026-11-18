import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";

import type { ClaudeCodeStatusView, ClaudeCodeUpdateView } from "../../shared/claude-code.js";
import { WispBackendError } from "../backend-error.js";
import { compareVersions } from "./claude-code-cli.js";
import { claudeCodeEnvironment } from "./claude-code-launch.js";

const NPM_PACKAGE = "@anthropic-ai/claude-code";
/** The native updater downloads a large binary without printing progress; stopping it midway can break `claude`. */
const UPDATE_TIMEOUT_MS = 15 * 60_000;
const MAX_MESSAGE_LENGTH = 300;

/** Who installed this server's `claude`, proven by where its file is, and so how Wisp can update it. */
export type ClaudeCodeInstall =
  | { method: "native"; executable: string }
  | { method: "npm"; prefix: string }
  | { method: "manual"; command?: string };

export interface InstallProbe {
  realpath: (file: string) => Promise<string>;
  writable: (directory: string) => Promise<boolean>;
}

const systemProbe: InstallProbe = {
  realpath: (file) => realpath(file),
  writable: async (directory) => {
    try {
      await access(directory, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Only an installer the path proves runs (ADR 047): Claude Code's native
 * installer keeps versions under `…/claude/versions/`, and npm under
 * `<prefix>/lib/node_modules/@anthropic-ai/claude-code/`. Anything else, or an
 * npm prefix this server cannot write, is updated by the person.
 */
export async function resolveClaudeCodeInstall(
  executable: string,
  probe: InstallProbe = systemProbe,
): Promise<ClaudeCodeInstall> {
  const command = toSlashes(executable);
  const real = toSlashes(await probe.realpath(executable).catch(() => executable));
  if (real.includes("/claude/versions/") || command.endsWith("/.local/bin/claude.exe")) {
    return { method: "native", executable };
  }
  const npm = /^(.*)\/lib\/node_modules\/@anthropic-ai\/claude-code\//.exec(real);
  if (npm?.[1]) {
    const prefix = fromSlashes(npm[1], executable);
    return (await probe.writable(path.join(prefix, "lib", "node_modules")))
      ? { method: "npm", prefix }
      : { method: "manual", command: `npm install -g ${NPM_PACKAGE}@latest` };
  }
  if (real.includes("/Caskroom/claude-code/")) return { method: "manual", command: "brew upgrade --cask claude-code" };
  return { method: "manual" };
}

export type UpdateRunner = (
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) => Promise<{ exitCode: number; output: string }>;

const systemRunner: UpdateRunner = (command, args, env) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { env, timeout: UPDATE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        const exitCode = !error ? 0 : typeof error.code === "number" ? error.code : -1;
        const output = `${stdout}\n${stderr}`;
        resolve({ exitCode, output: error && exitCode === -1 ? `${output}\n${error.message}` : output });
      },
    );
  });

export interface ClaudeCodeUpdateServiceOptions {
  status: { refresh(force?: boolean): Promise<ClaudeCodeStatusView>; executable(): string | undefined };
  activity: { readonly busy: boolean };
  resolve?: (executable: string) => Promise<ClaudeCodeInstall>;
  run?: UpdateRunner;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/**
 * Updates this server's `claude` with the installer that owns it (ADR 047):
 * one update at a time, never while a Claude Code turn runs. The update goes
 * on in the background; the settings view reports it and its result.
 */
export class ClaudeCodeUpdateService {
  private readonly options: ClaudeCodeUpdateServiceOptions;
  private readonly resolve: (executable: string) => Promise<ClaudeCodeInstall>;
  private readonly run: UpdateRunner;
  private running: Promise<void> | undefined;
  private last: ClaudeCodeUpdateView["last"];

  constructor(options: ClaudeCodeUpdateServiceOptions) {
    this.options = options;
    this.resolve = options.resolve ?? ((executable) => resolveClaudeCodeInstall(executable));
    this.run = options.run ?? systemRunner;
  }

  /** How the `claude` the latest check found can be updated; undefined when none was found. */
  async view(): Promise<ClaudeCodeUpdateView | undefined> {
    const executable = this.options.status.executable();
    if (!executable) return undefined;
    const install = await this.resolve(executable);
    return {
      method: install.method,
      ...(install.method === "manual" && install.command ? { command: install.command } : {}),
      running: Boolean(this.running),
      ...(this.last ? { last: this.last } : {}),
    };
  }

  /** Starts an update and returns once it is under way; `whenDone` waits for its end. */
  async start(): Promise<void> {
    if (this.running) throw new WispBackendError("invalid_request", "Claude Code is already being updated.");
    if (this.options.activity.busy) {
      throw new WispBackendError("invalid_request", "Wait for Wisps on Claude Code to finish before updating it.");
    }
    const before = await this.options.status.refresh(true);
    const executable = this.options.status.executable();
    if (!executable || before.state === "missing") {
      throw new WispBackendError("configuration_required", "Claude Code is not installed on the server's computer.");
    }
    // Read again right before running, so an install that changed is not updated with the wrong installer.
    const install = await this.resolve(executable);
    if (install.method === "manual") {
      throw new WispBackendError(
        "configuration_required",
        install.command
          ? `Wisp cannot update this Claude Code install. Run \`${install.command}\` on the server's computer.`
          : "Wisp cannot update this Claude Code install. Update it the way it was installed.",
      );
    }
    const previous = "version" in before ? before.version : undefined;
    this.last = undefined;
    this.running = this.update(install, previous).finally(() => {
      this.running = undefined;
    });
  }

  /** Resolves once the running update, if any, has ended. */
  async whenDone(): Promise<void> {
    await this.running;
  }

  private async update(install: Exclude<ClaudeCodeInstall, { method: "manual" }>, previous?: string): Promise<void> {
    const environment = this.options.environment ?? process.env;
    const { exitCode, output } =
      install.method === "native"
        ? await this.run(install.executable, ["update"], claudeCodeEnvironment(environment))
        : await this.run(await npmCommand(install.prefix), npmArguments(install.prefix), {
            ...environment,
            PATH: [path.join(install.prefix, "bin"), environment.PATH].filter(Boolean).join(path.delimiter),
          });
    if (exitCode !== 0) {
      this.finish(false, failureLine(output) ?? `The update stopped with exit code ${exitCode}.`);
      return;
    }
    const after = await this.options.status.refresh(true).catch(() => undefined);
    const version = after && "version" in after ? after.version : undefined;
    if (!after || !version) this.finish(false, "The update finished, but Claude Code could not be checked.");
    else if (after.state === "outdated")
      this.finish(false, `The update finished, but Claude Code is still ${version}.`);
    else if (previous && compareVersions(version, previous) > 0)
      this.finish(true, `Updated to Claude Code ${version}.`);
    else this.finish(true, `Claude Code ${version} is up to date.`);
  }

  private finish(ok: boolean, message: string): void {
    this.last = {
      ok,
      message: message.slice(0, MAX_MESSAGE_LENGTH),
      finishedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
  }
}

function npmArguments(prefix: string): string[] {
  return ["install", "--global", "--prefix", prefix, `${NPM_PACKAGE}@latest`];
}

/** The npm of the Node that owns the prefix when it has one; the one on `PATH` may belong to another Node. */
async function npmCommand(prefix: string): Promise<string> {
  const own = path.join(prefix, "bin", "npm");
  try {
    await access(own, constants.X_OK);
    return own;
  } catch {
    return "npm";
  }
}

/** Installers print hints after an error, so the last line that names one is the reason. */
function failureLine(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return [...lines].reverse().find((line) => /error|failed|denied|EACCES|ENOSPC/i.test(line)) ?? lines.at(-1);
}

function toSlashes(file: string): string {
  return file.replaceAll("\\", "/");
}

function fromSlashes(file: string, original: string): string {
  return original.includes("\\") ? file.replaceAll("/", "\\") : file;
}
