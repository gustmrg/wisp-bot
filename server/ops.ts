import { execFile } from "node:child_process";
import { lstat, open, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ContainerRuntimeDetector } from "../backend/container-cli.js";
import type { ServerSummary } from "../shared/remote-protocol.js";
import { adminRequest, ServerNotRunningError } from "./admin.js";
import { checkRuntime, type RuntimeCheck } from "./runtime-check.js";
import { type CommandResult, parseEnvFile, setupPaths, userBusEnvironment } from "./setup.js";
import { freeSpace } from "./update-transaction.js";

const SERVICE_NAME = "wisp";
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const MIN_KEY_BYTES = 32;
const LOW_DISK_FAIL_BYTES = 100 * 1024 * 1024;
const LOW_DISK_WARN_BYTES = 1024 * 1024 * 1024;
const MAX_TAIL_READ_BYTES = 2 * 1024 * 1024;

export const DEFAULT_LOG_LINES = 50;
export const MAX_LOG_LINES = 1_000;
export const MAX_BACKUP_WAIT_SECONDS = 600;

/** Administrative status response from a running server. */
export interface ServerStatus extends Partial<ServerSummary> {
  serverId: string;
  bootId: string;
  version: string;
  port: number;
  devices: number;
  web: boolean;
  publicOrigin?: string;
  exposedPort?: number;
  memoryRssBytes?: number;
}

export interface ContainerCheckResult {
  available: boolean;
  name?: "docker" | "podman";
  version?: string;
  message?: string;
}

export type DoctorCheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  message: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface ServerLogsResult {
  directory: string;
  files: string[];
  lines: string[];
}

export interface ServerConfigView {
  envFile: string;
  envFileExists: boolean;
  dataDirectory: string;
  masterKeyFile: string;
  host: string;
  port: number;
  allowExternalBind: boolean;
  web: boolean;
  publicOrigin?: string;
  webRoot?: string;
  env: Record<string, string>;
}

export type ServiceAction = "start" | "stop" | "restart";

export interface ServiceActionResult {
  service: string;
  action: ServiceAction;
  ok: true;
}

/** Host boundary for operational CLI commands so tests never invoke real system binaries. */
export interface OpsHost {
  home: string;
  user: string;
  uid: number;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  run(command: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs?: number): Promise<CommandResult>;
  checkRuntime(): Promise<RuntimeCheck[]>;
  checkContainerRuntime(): Promise<ContainerCheckResult>;
  freeSpace(directory: string): Promise<number>;
  serverStatus(dataDirectory: string): Promise<ServerStatus | undefined>;
  /** Overrides POSIX permission bits in tests; defaults to real `lstat` bits on POSIX hosts. */
  posixMode?: (filePath: string) => Promise<number | undefined>;
}

export function systemOpsHost(): OpsHost {
  const info = os.userInfo();
  return {
    home: os.homedir(),
    user: info.username,
    uid: info.uid,
    platform: process.platform,
    env: process.env,
    run: (command, args, env, timeoutMs = 30_000) =>
      new Promise((resolve) => {
        execFile(
          command,
          [...args],
          { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
            if (!failure) return resolve({ code: 0, stdout, stderr });
            if (failure.code === "ENOENT") {
              return resolve({ code: 127, stdout, stderr: `${command}: command not found` });
            }
            resolve({
              code: typeof failure.code === "number" ? failure.code : 1,
              stdout,
              stderr: stderr || failure.message,
            });
          },
        );
      }),
    checkRuntime,
    checkContainerRuntime: async () => new ContainerRuntimeDetector().status(),
    freeSpace,
    serverStatus: async (dataDirectory) => {
      try {
        return (await adminRequest(dataDirectory, { command: "status" })) as ServerStatus;
      } catch (error) {
        if (error instanceof ServerNotRunningError) return undefined;
        throw error;
      }
    },
  };
}

/**
 * Waits until `isReady()` returns true, waking only when `subscribe` notifies
 * of a state change, or returns false once `timeoutMs` elapses (or `signal` aborts).
 */
export function waitForCondition(options: {
  isReady: () => boolean;
  subscribe: (onChange: () => void) => () => void;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (options.isReady()) return Promise.resolve(true);
  if (options.timeoutMs <= 0 || options.signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      options.signal?.removeEventListener("abort", onAbort);
      resolve(ready);
    };
    const onAbort = (): void => finish(false);
    const onChange = (): void => {
      if (options.isReady()) finish(true);
    };
    const unsubscribe = options.subscribe(onChange);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish(options.isReady()), options.timeoutMs);
    if (options.isReady()) finish(true);
  });
}

/** Formats running server status for a human reading a terminal. */
export function describeStatus(status: ServerStatus): string {
  const lines = [`Wisp server ${status.version} (running)`];
  lines.push(`  Server ID: ${status.serverId}`);
  lines.push(`  Port: ${status.port}${status.exposedPort !== undefined ? ` (exposed: ${status.exposedPort})` : ""}`);
  if (status.uptimeSeconds !== undefined) {
    lines.push(
      `  Uptime: ${formatDuration(status.uptimeSeconds)}${status.startedAt ? ` (since ${status.startedAt})` : ""}`,
    );
  }
  lines.push(`  Paired devices: ${status.devices}`);
  if (status.workingWisps !== undefined) lines.push(`  Working Wisps: ${status.workingWisps}`);
  if (status.pendingApprovals !== undefined) lines.push(`  Pending approvals: ${status.pendingApprovals}`);
  if (status.unreadConversations !== undefined) lines.push(`  Unread conversations: ${status.unreadConversations}`);
  if (status.activeEventStreams !== undefined) lines.push(`  Active event streams: ${status.activeEventStreams}`);
  if (status.memoryRssBytes !== undefined) lines.push(`  Memory (RSS): ${formatBytes(status.memoryRssBytes)}`);
  lines.push(`  Browser app: ${status.web ? "enabled" : "disabled"}`);
  if (status.publicOrigin) lines.push(`  Public origin: ${status.publicOrigin}`);
  return `${lines.join("\n")}\n`;
}

/** Runs read-only host diagnostics for a Wisp server installation. */
export async function runDoctor(
  options: { dataDirectory?: string; keyFile?: string },
  host: OpsHost,
): Promise<DoctorResult> {
  const config = await readServerConfig(
    { ...(options.dataDirectory ? { dataDirectory: options.dataDirectory } : {}) },
    host,
  );
  const dataDirectory = config.dataDirectory;
  const keyFile = options.keyFile ? path.resolve(options.keyFile) : config.masterKeyFile;
  const checks: DoctorCheck[] = [];

  for (const check of await host.checkRuntime()) {
    checks.push(
      check.ok
        ? {
            name: check.name,
            status: "ok",
            message: `${check.name === "sqlite" ? "SQLite" : "PDF rendering"} check passed.`,
          }
        : {
            name: check.name,
            status: "fail",
            message: `${check.name === "sqlite" ? "SQLite" : "PDF rendering"} check failed: ${check.error ?? "unknown error"}`,
          },
    );
  }

  checks.push(await checkDataDirectory(dataDirectory, host));
  checks.push(await checkDiskSpace(dataDirectory, host));
  checks.push(await checkMasterKey(keyFile, host));
  checks.push(await checkContainerRuntime(host));
  checks.push(await checkRunningServer(dataDirectory, host));

  if (host.platform === "linux") {
    const busEnv = userBusEnvironment(host);
    const service = await host.run("systemctl", ["--user", "is-active", SERVICE_NAME], busEnv);
    if (service.code === 127) {
      checks.push({
        name: "systemd-service",
        status: "warn",
        message: "systemd is not available on this host.",
      });
    } else {
      const state = service.stdout.trim() || service.stderr.trim() || "inactive";
      checks.push(
        service.code === 0
          ? { name: "systemd-service", status: "ok", message: `systemd user service ${SERVICE_NAME} is active.` }
          : {
              name: "systemd-service",
              status: "warn",
              message: `systemd user service ${SERVICE_NAME} is not active (${state}).`,
            },
      );
      const linger = await host.run("loginctl", ["show-user", host.user, "--property=Linger"], busEnv);
      if (linger.code === 0 && /Linger=yes/.test(linger.stdout)) {
        checks.push({
          name: "systemd-linger",
          status: "ok",
          message: `User linger is enabled for ${host.user}.`,
        });
      } else if (linger.code === 127) {
        checks.push({
          name: "systemd-linger",
          status: "warn",
          message: `loginctl is not available; could not verify user linger for ${host.user}.`,
        });
      } else {
        checks.push({
          name: "systemd-linger",
          status: "warn",
          message: `User linger is not enabled for ${host.user}. Run \`sudo loginctl enable-linger ${host.user}\` so Wisps keep running after logout.`,
        });
      }
    }
  }

  return { ok: checks.every((check) => check.status !== "fail"), checks };
}

/** Formats doctor diagnostics for a terminal. */
export function describeDoctor(result: DoctorResult): string {
  const labels: Record<DoctorCheckStatus, string> = { ok: "[OK]  ", warn: "[WARN]", fail: "[FAIL]" };
  const lines = ["Wisp server diagnostics:"];
  for (const check of result.checks) {
    lines.push(`  ${labels[check.status]} ${check.name}: ${check.message}`);
  }
  const fails = result.checks.filter((check) => check.status === "fail").length;
  const warns = result.checks.filter((check) => check.status === "warn").length;
  lines.push("");
  if (fails > 0) {
    lines.push(`Summary: ${fails} failing check${fails === 1 ? "" : "s"}, ${warns} warning${warns === 1 ? "" : "s"}.`);
  } else if (warns > 0) {
    lines.push(`Summary: all required checks passed (${warns} warning${warns === 1 ? "" : "s"}).`);
  } else {
    lines.push("Summary: all checks passed.");
  }
  return `${lines.join("\n")}\n`;
}

/** Reads the latest `maxLines` log lines from `<dataDirectory>/backend/logs`. */
export async function readServerLogs(dataDirectory: string, maxLines = DEFAULT_LOG_LINES): Promise<ServerLogsResult> {
  const directory = path.join(dataDirectory, "backend", "logs");
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { directory, files: [], lines: [] };
    }
    throw error;
  }
  const fileStats: Array<{ name: string; filePath: string; mtimeMs: number; size: number }> = [];
  for (const name of entries) {
    const filePath = path.join(directory, name);
    const info = await stat(filePath).catch(() => undefined);
    if (info?.isFile()) fileStats.push({ name, filePath, mtimeMs: info.mtimeMs, size: info.size });
  }
  // Active `backend.log` is always newest; rotated files follow by mtime descending.
  fileStats.sort((left, right) => {
    if (left.name === "backend.log") return -1;
    if (right.name === "backend.log") return 1;
    if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs;
    return left.name.localeCompare(right.name);
  });

  const collected: string[] = [];
  const usedFiles: string[] = [];
  for (const file of fileStats) {
    if (collected.length >= maxLines) break;
    const text = await readTailText(file.filePath, file.size);
    const fileLines = splitLogLines(text);
    usedFiles.push(file.name);
    if (fileLines.length === 0) continue;
    const remaining = maxLines - collected.length;
    const slice = fileLines.length > remaining ? fileLines.slice(fileLines.length - remaining) : fileLines;
    collected.unshift(...slice);
  }
  return { directory, files: usedFiles.reverse(), lines: collected };
}

/** Reads `~/.config/wisp/server.env` and resolves effective server settings and paths. */
export async function readServerConfig(
  options: { dataDirectory?: string },
  host: Pick<OpsHost, "home" | "env">,
): Promise<ServerConfigView> {
  const paths = setupPaths(host.home);
  let raw: string | undefined;
  try {
    raw = await readFile(paths.envFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parsed = raw === undefined ? new Map<string, string>() : parseEnvFile(raw);
  const envValue = (name: string): string | undefined => host.env[name]?.trim() || parsed.get(name) || undefined;
  const dataDirectory = options.dataDirectory
    ? path.resolve(options.dataDirectory)
    : path.resolve(envValue("WISP_DATA_DIR") ?? paths.defaultDataDirectory);
  const masterKeyFile = path.resolve(envValue("WISP_MASTER_KEY_FILE") ?? paths.keyFile);
  const hostAddress = envValue("WISP_HOST") ?? DEFAULT_HOST;
  const portValue = Number(envValue("WISP_PORT") ?? DEFAULT_PORT);
  const port = Number.isInteger(portValue) && portValue >= 0 && portValue <= 65535 ? portValue : DEFAULT_PORT;
  const allowExternalBind = envValue("WISP_ALLOW_EXTERNAL_BIND") === "1";
  const web = envValue("WISP_WEB") === "1";
  const publicOrigin = envValue("WISP_PUBLIC_ORIGIN");
  const webRoot = envValue("WISP_WEB_ROOT");
  return {
    envFile: paths.envFile,
    envFileExists: raw !== undefined,
    dataDirectory,
    masterKeyFile,
    host: hostAddress,
    port,
    allowExternalBind,
    web,
    ...(publicOrigin ? { publicOrigin } : {}),
    ...(webRoot ? { webRoot: path.resolve(webRoot) } : {}),
    env: Object.fromEntries(parsed),
  };
}

/** Formats the server configuration for a terminal. */
export function describeServerConfig(config: ServerConfigView): string {
  const lines = [
    `Config file: ${config.envFile}${config.envFileExists ? "" : " (not found; showing defaults)"}`,
    `Data directory: ${config.dataDirectory}`,
    `Master key file: ${config.masterKeyFile}`,
    `Listen address: ${config.host}:${config.port}`,
    `External bind: ${config.allowExternalBind ? "allowed" : "disabled"}`,
    `Browser app: ${config.web ? "enabled" : "disabled"}`,
  ];
  if (config.publicOrigin) lines.push(`Public origin: ${config.publicOrigin}`);
  if (config.webRoot) lines.push(`Web root: ${config.webRoot}`);
  return `${lines.join("\n")}\n`;
}

/** Runs `systemctl --user <action> wisp` on Linux with clear diagnostics when systemd is unavailable. */
export async function runServiceAction(action: ServiceAction, host: OpsHost): Promise<ServiceActionResult> {
  if (host.platform !== "linux") {
    throw new Error("Managing the wisp service requires Linux with systemd.");
  }
  const result = await host.run("systemctl", ["--user", action, SERVICE_NAME], userBusEnvironment(host));
  if (result.code === 0) return { service: SERVICE_NAME, action, ok: true };
  const detail = result.stderr.trim().split("\n").pop() ?? "";
  if (result.code === 127) {
    throw new Error(
      "systemd is not available here. If the server runs in Docker or with --no-service, manage it with Docker or your process supervisor.",
    );
  }
  if (/Unit wisp\.service not found|could not be found/i.test(result.stderr)) {
    throw new Error(
      "The wisp systemd user service is not installed. Run `wispctl setup` to install it, or manage the server directly if you used --no-service.",
    );
  }
  if (/Failed to connect to (user )?bus|No such file or directory|XDG_RUNTIME_DIR/i.test(detail)) {
    throw new Error(
      `The systemd user session is not reachable (${detail}). Log in to this account once, or run \`sudo loginctl enable-linger ${host.user}\`.`,
    );
  }
  throw new Error(`Could not ${action} the ${SERVICE_NAME} service: ${detail || `exit code ${result.code}`}`);
}

export function describeServiceAction(result: ServiceActionResult): string {
  const verb = result.action === "start" ? "Started" : result.action === "stop" ? "Stopped" : "Restarted";
  return `${verb} ${result.service} service.\n`;
}

async function readPosixMode(filePath: string, infoMode: number, host: OpsHost): Promise<number | undefined> {
  if (host.posixMode) return host.posixMode(filePath);
  if (host.platform === "win32" || process.platform === "win32") return undefined;
  return infoMode;
}

async function checkDataDirectory(dataDirectory: string, host: OpsHost): Promise<DoctorCheck> {
  try {
    const info = await stat(dataDirectory);
    if (!info.isDirectory()) {
      return { name: "data-dir", status: "fail", message: `${dataDirectory} is not a directory.` };
    }
    const mode = await readPosixMode(dataDirectory, info.mode, host);
    if (mode !== undefined && (mode & 0o077) !== 0) {
      return {
        name: "data-dir",
        status: "fail",
        message: `Data directory ${dataDirectory} is accessible by other users; run \`chmod 700 ${dataDirectory}\`.`,
      };
    }
    return {
      name: "data-dir",
      status: "ok",
      message: `Data directory ${dataDirectory} exists${mode !== undefined ? " and is private (0700)" : ""}.`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        name: "data-dir",
        status: "warn",
        message: `Data directory ${dataDirectory} does not exist yet.`,
      };
    }
    return {
      name: "data-dir",
      status: "fail",
      message: `Could not inspect data directory ${dataDirectory}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkDiskSpace(dataDirectory: string, host: OpsHost): Promise<DoctorCheck> {
  const probe = await nearestExistingDirectory(dataDirectory);
  try {
    const available = await host.freeSpace(probe);
    if (available < LOW_DISK_FAIL_BYTES) {
      return {
        name: "disk-space",
        status: "fail",
        message: `Only ${formatBytes(available)} free for ${dataDirectory}. Free disk space before running Wisps.`,
      };
    }
    if (available < LOW_DISK_WARN_BYTES) {
      return {
        name: "disk-space",
        status: "warn",
        message: `${formatBytes(available)} free for ${dataDirectory}; workspaces pause writes below 1 GiB free.`,
      };
    }
    return {
      name: "disk-space",
      status: "ok",
      message: `${formatBytes(available)} free for ${dataDirectory}.`,
    };
  } catch (error) {
    return {
      name: "disk-space",
      status: "warn",
      message: `Could not check free disk space for ${dataDirectory}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkMasterKey(keyFile: string, host: OpsHost): Promise<DoctorCheck> {
  try {
    const info = await lstat(keyFile);
    if (!info.isFile()) {
      return { name: "master-key", status: "fail", message: `Master key ${keyFile} is not a regular file.` };
    }
    const mode = await readPosixMode(keyFile, info.mode, host);
    if (mode !== undefined && (mode & 0o077) !== 0) {
      return {
        name: "master-key",
        status: "fail",
        message: `Master key ${keyFile} is readable by other users; run \`chmod 600 ${keyFile}\`.`,
      };
    }
    if (info.size !== MIN_KEY_BYTES) {
      return {
        name: "master-key",
        status: "fail",
        message: `Master key ${keyFile} must be exactly ${MIN_KEY_BYTES} bytes (found ${info.size} bytes).`,
      };
    }
    return {
      name: "master-key",
      status: "ok",
      message: `Master key ${keyFile} is present${mode !== undefined ? " and owner-only" : ""}.`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        name: "master-key",
        status: "warn",
        message: `Master key ${keyFile} does not exist. Provider credentials cannot be saved until a master key is configured.`,
      };
    }
    return {
      name: "master-key",
      status: "fail",
      message: `Could not inspect master key ${keyFile}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkContainerRuntime(host: OpsHost): Promise<DoctorCheck> {
  try {
    const runtime = await host.checkContainerRuntime();
    if (runtime.available) {
      const label = runtime.name === "podman" ? "Podman" : "Docker";
      return {
        name: "container-runtime",
        status: "ok",
        message: `${label}${runtime.version ? ` ${runtime.version}` : ""} is available.`,
      };
    }
    return {
      name: "container-runtime",
      status: "warn",
      message: runtime.message ?? "Install Docker or Podman on the server to run commands in containers.",
    };
  } catch (error) {
    return {
      name: "container-runtime",
      status: "warn",
      message: `Could not check container runtime: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkRunningServer(dataDirectory: string, host: OpsHost): Promise<DoctorCheck> {
  try {
    const status = await host.serverStatus(dataDirectory);
    if (!status) {
      return { name: "server", status: "warn", message: `No Wisp server is running for ${dataDirectory}.` };
    }
    const details = [`port ${status.port}`, `${status.devices} paired device${status.devices === 1 ? "" : "s"}`];
    if (status.workingWisps !== undefined) {
      details.push(`${status.workingWisps} working Wisp${status.workingWisps === 1 ? "" : "s"}`);
    }
    return {
      name: "server",
      status: "ok",
      message: `Wisp server ${status.version} is running (${details.join(", ")}).`,
    };
  } catch (error) {
    return {
      name: "server",
      status: "fail",
      message: `Could not query running server: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function nearestExistingDirectory(target: string): Promise<string> {
  let current = path.resolve(target);
  for (;;) {
    const exists = await stat(current).then(
      () => true,
      () => false,
    );
    if (exists) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

async function readTailText(filePath: string, size: number): Promise<string> {
  if (size <= MAX_TAIL_READ_BYTES) return readFile(filePath, "utf8");
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(MAX_TAIL_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_TAIL_READ_BYTES, size - MAX_TAIL_READ_BYTES);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const firstNewline = text.indexOf("\n");
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
  } finally {
    await handle.close();
  }
}

function splitLogLines(text: string): string[] {
  const trimmed = text.replace(/\r?\n$/, "");
  return trimmed ? trimmed.split(/\r?\n/) : [];
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const secs = seconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function formatBytes(bytes: number): string {
  const gib = 1024 * 1024 * 1024;
  const mib = 1024 * 1024;
  const kib = 1024;
  if (bytes >= gib) return `${(bytes / gib).toFixed(1)} GiB`;
  if (bytes >= mib) return `${(bytes / mib).toFixed(1)} MiB`;
  if (bytes >= kib) return `${(bytes / kib).toFixed(1)} KiB`;
  return `${bytes} B`;
}
