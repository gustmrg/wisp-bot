import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  SERVER_ARCHIVE_MANIFEST,
  SERVER_VERSION_PATTERN,
  WISP_SERVER_PACKAGE,
  type ServerArchiveManifest,
} from "../shared/server-package.js";
import { type ServerUpdateRecord, UNFINISHED_UPDATE_STATES, UPDATE_ID_PATTERN } from "../shared/server-update.js";
import { adminRequest } from "./admin.js";
import { MasterKeyEncryption, readPrivateKeyFile } from "./master-key.js";
import { checkRuntime, type RuntimeCheck } from "./runtime-check.js";
import { InstanceLock } from "./instance-lock.js";
import { isProcessAlive, readUpdateRecord, writeUpdateRecord } from "./update-record.js";
import {
  commitTransaction,
  coveredFiles,
  freeSpace,
  recoverTransaction,
  restoreSnapshot,
  snapshotSpace,
  takeSnapshot,
} from "./update-transaction.js";

const HEALTH_TIMEOUT_MS = 30_000;
/** How long the new version may take to open the data in an update, migrations included. */
const PREPARE_TIMEOUT_MS = 10 * 60_000;
/** How long to wait for the data directory's lock while the server it belonged to exits. */
const LOCK_TIMEOUT_MS = 30_000;
const NPM_TIMEOUT_MS = 10 * 60_000;
const SERVICE_NAME = "wisp";
const DEFAULT_PORT = 8787;
/** Written last into an installed archive version, holding its version: a folder without it is incomplete. */
const INSTALL_COMPLETE = ".install-complete";

export interface SetupOptions {
  /** What to install; the version of the package that is running by default. */
  packageSpec?: string;
  port?: number;
  publicOrigin?: string;
  /** Serve the browser app. Left out, a new server does not and an existing one keeps its setting. */
  web?: boolean;
  dataDirectory?: string;
  /** Install and start the systemd user service. Off, only the files are written. */
  service: boolean;
  /** Print a pairing code once the server answers. */
  pair: boolean;
  /** Stops the setup before it starts the service; what was installed stays. */
  signal?: AbortSignal;
  /** Names this run in the update record, so whoever started it can ask how it ended. */
  updateId?: string;
}

export interface SetupResult {
  version: string;
  installDir: string;
  keyFile: string;
  keyCreated: boolean;
  envFile: string;
  wispctl: string;
  dataDirectory: string;
  port: number;
  publicOrigin?: string;
  web: boolean;
  service: "started" | "restarted" | "unchanged" | "skipped";
  /** The command that starts the server by hand, when no service was installed. */
  startCommand?: string;
  pairingCode?: string;
  /** The ID of this run's record in `update.json`. */
  updateId: string;
  /** The version the server answered with after the setup, when the service runs. */
  runningVersion?: string;
  warnings: string[];
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything setup does to the machine, so tests can run it against a temporary home. */
export interface SetupHost {
  home: string;
  user: string;
  uid: number;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  /** The version of the package that is running. */
  version: string;
  /**
   * The extracted server archive this setup runs from, which brings its own
   * Node.js. Unset when it runs from the npm package.
   */
  archive?: ServerArchive;
  run(
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<CommandResult>;
  isHealthy(address: string, port: number): Promise<boolean>;
  /** Whether anything accepts connections on the port, Wisp or not. */
  isPortInUse(address: string, port: number): Promise<boolean>;
  pairingCode(dataDirectory: string): Promise<string>;
  /** The version the running server reports, or undefined when it does not answer. */
  serverVersion(dataDirectory: string): Promise<string | undefined>;
  /** Whether this machine can run the code that runs setup. */
  checkRuntime(): Promise<RuntimeCheck[]>;
  pid: number;
  isProcessAlive(pid: number): boolean;
  /** Free bytes on the file system of `directory`. */
  freeSpace(directory: string): Promise<number>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  progress(message: string): void;
}

/** An extracted server archive: its folder and what its manifest says. */
export interface ServerArchive {
  root: string;
  manifest: ServerArchiveManifest;
}

/**
 * The archive the running code belongs to: `app/server/` sits two levels
 * below the archive's top, next to its manifest.
 */
export function findServerArchive(directory = __dirname): ServerArchive | undefined {
  const root = path.resolve(directory, "../..");
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(root, SERVER_ARCHIVE_MANIFEST), "utf8"),
    ) as ServerArchiveManifest;
    if (typeof manifest.version !== "string" || !SERVER_VERSION_PATTERN.test(manifest.version)) return undefined;
    return { root, manifest };
  } catch {
    return undefined;
  }
}

export function systemHost(version: string, progress: (message: string) => void): SetupHost {
  const info = os.userInfo();
  const archive = findServerArchive();
  return {
    ...(archive ? { archive } : {}),
    home: os.homedir(),
    user: info.username,
    uid: info.uid,
    platform: process.platform,
    env: process.env,
    nodePath: process.execPath,
    version,
    run: (command, args, env, timeoutMs = 60_000, signal) =>
      new Promise((resolve) => {
        execFile(
          command,
          [...args],
          { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, ...(signal ? { signal } : {}) },
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
    isHealthy: (address, port) =>
      new Promise((resolve) => {
        const request = httpRequest({ host: address, port, path: "/health", timeout: 2_000 }, (response) => {
          response.resume();
          resolve(response.statusCode === 200);
        });
        request.on("error", () => resolve(false));
        request.on("timeout", () => request.destroy());
        request.end();
      }),
    isPortInUse: (address, port) =>
      new Promise((resolve) => {
        const socket = connect({ host: address, port, timeout: 2_000 });
        const done = (inUse: boolean) => () => {
          socket.destroy();
          resolve(inUse);
        };
        socket.once("connect", done(true));
        socket.once("error", done(false));
        socket.once("timeout", done(false));
      }),
    pairingCode: async (dataDirectory) => {
      const value = (await adminRequest(dataDirectory, { command: "pair" })) as { code?: unknown };
      if (typeof value.code !== "string") throw new Error("The server did not return a pairing code.");
      return value.code;
    },
    serverVersion: async (dataDirectory) => {
      try {
        const { version } = (await adminRequest(dataDirectory, { command: "status" })) as { version?: unknown };
        return typeof version === "string" ? version : undefined;
      } catch {
        return undefined;
      }
    },
    checkRuntime,
    pid: process.pid,
    isProcessAlive,
    freeSpace,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    progress,
  };
}

/** Where setup puts things, all under the account's home. */
export function setupPaths(home: string) {
  const installDir = path.join(home, ".local/lib/wisp-server");
  const packageDir = path.join(installDir, "node_modules", ...WISP_SERVER_PACKAGE.split("/"));
  const configDir = path.join(home, ".config/wisp");
  /** The installed archive the service runs; it points into `versions/`. */
  const current = path.join(installDir, "current");
  return {
    installDir,
    packageDir,
    mainScript: path.join(packageDir, "server/main.js"),
    cliScript: path.join(packageDir, "server/cli.js"),
    versionsDir: path.join(installDir, "versions"),
    current,
    currentNode: path.join(current, "runtime/node"),
    currentMainScript: path.join(current, "app/server/main.js"),
    currentWispctl: path.join(current, "bin/wispctl"),
    configDir,
    /** The record of the last setup, which `wispctl update-status` reads. */
    updateRecord: path.join(configDir, "update.json"),
    keyFile: path.join(configDir, "master.key"),
    envFile: path.join(configDir, "server.env"),
    wispctl: path.join(home, ".local/bin/wispctl"),
    unitFile: path.join(home, ".config/systemd/user", `${SERVICE_NAME}.service`),
    defaultDataDirectory: path.join(home, ".local/share/wisp"),
  };
}

type Track = (changes: Partial<ServerUpdateRecord>) => Promise<void>;

/**
 * Installs and starts a Wisp server for the current account: the package under
 * `~/.local/lib/wisp-server`, a master key, `server.env`, the `wispctl`
 * command, and a systemd user service. Running it again keeps the key and
 * settings, and restarts the service only when something changed.
 *
 * Each run is recorded in `update.json` as it goes, so a client that lost the
 * answer can ask how it ended (`wispctl update-status`). Only one setup runs
 * at a time.
 */
export async function runSetup(options: SetupOptions, host: SetupHost): Promise<SetupResult> {
  const paths = setupPaths(host.home);
  if (options.updateId !== undefined && !UPDATE_ID_PATTERN.test(options.updateId)) {
    throw new Error("The update ID must be a UUID.");
  }
  const previous = await readUpdateRecord(paths.updateRecord, host.isProcessAlive);
  if (previous && UNFINISHED_UPDATE_STATES.has(previous.state) && previous.pid !== host.pid) {
    throw new Error(
      `Another Wisp server setup is running (process ${previous.pid}). Wait for it to finish, then run the setup again.`,
    );
  }
  const startedAt = host.now().toISOString();
  const record: ServerUpdateRecord = {
    id: options.updateId ?? randomUUID(),
    targetVersion: host.archive?.manifest.version ?? host.version,
    state: "accepted",
    pid: host.pid,
    startedAt,
    updatedAt: startedAt,
  };
  const track: Track = async (changes) => {
    Object.assign(record, changes, { updatedAt: host.now().toISOString() });
    await writeUpdateRecord(paths.updateRecord, record);
  };
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await track({});
  try {
    const result = await setUp(options, host, paths, track);
    await track({
      state: "completed",
      targetVersion: result.version,
      ...(result.runningVersion ? { runningVersion: result.runningVersion } : {}),
    });
    return { ...result, updateId: record.id };
  } catch (error) {
    await track({
      state: error instanceof RolledBackError ? "rolled-back" : "failed",
      error: error instanceof Error ? error.message : "The setup failed.",
    }).catch(() => undefined);
    throw error;
  }
}

/** The new version could not open the data; the previous version and its data were restored. */
export class RolledBackError extends Error {
  override name = "RolledBackError";
}

async function setUp(
  options: SetupOptions,
  host: SetupHost,
  paths: ReturnType<typeof setupPaths>,
  track: Track,
): Promise<Omit<SetupResult, "updateId">> {
  const warnings: string[] = [];
  let changed = false;
  const stopIfCancelled = (): void => {
    if (options.signal?.aborted) throw new Error("The setup was cancelled.");
  };

  if (options.service && host.platform !== "linux") {
    throw new Error("Setting up the service works on Linux with systemd. Add --no-service to only install the files.");
  }
  const publicOrigin = options.publicOrigin === undefined ? undefined : normalizeOrigin(options.publicOrigin);
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    throw new Error("The port must be between 1 and 65535.");
  }

  // 1. The server, in a stable place: `npx` runs from a cache that may be cleared,
  // and an extracted archive from wherever it was downloaded. Nothing the
  // running server uses changes until the new version is in place and checked.
  const linked = (await readlink(paths.current).catch(() => undefined))?.replace(/^versions\//, "");
  const fromVersion = linked ?? (await installedVersion(paths.installDir));
  await track({ state: "preparing", ...(fromVersion ? { fromVersion } : {}) });
  const failedCheck = (await host.checkRuntime()).find(({ ok }) => !ok);
  if (failedCheck) {
    throw new Error(
      `Wisp server ${host.archive?.manifest.version ?? host.version} cannot run on this machine: the ${failedCheck.name} check failed: ${failedCheck.error}`,
    );
  }
  stopIfCancelled();
  let version: string;
  if (host.archive) {
    if (options.packageSpec !== undefined) {
      throw new Error(
        "--package installs the npm package. This setup runs from a server archive: run the setup of the archive you want instead.",
      );
    }
    version = host.archive.manifest.version;
    await installArchive(paths, host.archive, host, stopIfCancelled);
  } else {
    const installed = await installedVersion(paths.installDir);
    const spec = options.packageSpec ?? `${WISP_SERVER_PACKAGE}@${host.version}`;
    version = installed ?? host.version;
    if (options.packageSpec !== undefined || installed !== host.version) {
      host.progress(`Installing ${spec}…`);
      version = await installPackage(paths.installDir, spec, host, options.signal, stopIfCancelled);
      changed = true;
    } else {
      host.progress(`${WISP_SERVER_PACKAGE} ${version} is already installed.`);
    }
  }
  // An archive brings its own Node.js; the npm package runs on the one that runs setup.
  const runtime = host.archive
    ? { nodePath: paths.currentNode, mainScript: paths.currentMainScript }
    : { nodePath: host.nodePath, mainScript: paths.mainScript };

  // 2. Settings. An existing server.env wins, apart from what was passed explicitly.
  const existingEnv = await readIfExists(paths.envFile);
  const current = parseEnvFile(existingEnv ?? "");
  const keyFile = current.get("WISP_MASTER_KEY_FILE") ?? paths.keyFile;
  const dataDirectory = path.resolve(
    options.dataDirectory ?? current.get("WISP_DATA_DIR") ?? paths.defaultDataDirectory,
  );
  const port = options.port ?? Number(current.get("WISP_PORT") ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The port must be between 1 and 65535.");
  const wantedOrigin = publicOrigin ?? current.get("WISP_PUBLIC_ORIGIN");
  // Servers set up before WISP_WEB existed always served the browser app; they keep doing so.
  const web = options.web ?? (existingEnv === undefined ? false : (current.get("WISP_WEB") ?? "1") === "1");
  const address = probeAddress(current.get("WISP_HOST"));

  // 3. The master key. Never replaced: saved credentials could not be read without it.
  await mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  await chmod(paths.configDir, 0o700).catch(() => undefined);
  let keyCreated = false;
  try {
    MasterKeyEncryption.generate(keyFile);
    keyCreated = true;
    host.progress(`Created the master key ${keyFile}. Keep a copy somewhere safe.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    readPrivateKeyFile(keyFile);
    host.progress(`Keeping the master key ${keyFile}.`);
  }

  const env = renderEnvFile(existingEnv, {
    WISP_DATA_DIR: dataDirectory,
    WISP_MASTER_KEY_FILE: keyFile,
    WISP_PORT: String(port),
    WISP_WEB: web ? "1" : "0",
    ...(wantedOrigin ? { WISP_PUBLIC_ORIGIN: wantedOrigin } : {}),
  });
  changed = (await writeIfChanged(paths.envFile, env, 0o600)) || changed;

  // 4. `wispctl`, for the person and for the desktop app's pairing over SSH.
  const shim = `#!/bin/sh\n# Written by the Wisp server setup; run it again to update.\nexec ${
    host.archive ? shellQuote(paths.currentWispctl) : `${shellQuote(host.nodePath)} ${shellQuote(paths.cliScript)}`
  } "$@"\n`;
  await mkdir(path.dirname(paths.wispctl), { recursive: true });
  await writeIfChanged(paths.wispctl, shim, 0o755);
  if (!(host.env.PATH ?? "").split(path.delimiter).includes(path.dirname(paths.wispctl))) {
    warnings.push(`Add ${path.dirname(paths.wispctl)} to your PATH to run wispctl from a terminal.`);
  }
  // nvm, fnm, and the like keep each Node.js version in its own directory under the home.
  if (!host.archive && !path.relative(host.home, host.nodePath).startsWith("..")) {
    warnings.push(
      `The server runs ${host.nodePath}. After updating or removing that Node.js version, run \`npx ${WISP_SERVER_PACKAGE} setup\` again.`,
    );
  }

  const base = {
    version,
    installDir: paths.installDir,
    keyFile,
    keyCreated,
    envFile: paths.envFile,
    wispctl: paths.wispctl,
    dataDirectory,
    port,
    ...(wantedOrigin ? { publicOrigin: wantedOrigin } : {}),
    web,
    warnings,
  };
  // Another archive version ran on this data: switching to this one is a
  // transaction that can be rolled back. Otherwise `current` moves now.
  const transaction =
    host.archive !== undefined &&
    options.service &&
    linked !== undefined &&
    linked !== version &&
    (await coveredFiles(dataDirectory)).length > 0;
  if (host.archive && !transaction) changed = (await pointCurrentAt(paths, version)) || changed;

  if (!options.service) {
    return {
      ...base,
      service: "skipped",
      startCommand: `WISP_MASTER_KEY_FILE=${shellQuote(keyFile)} WISP_DATA_DIR=${shellQuote(dataDirectory)} WISP_PORT=${port}${web ? " WISP_WEB=1" : ""} ${shellQuote(runtime.nodePath)} ${shellQuote(runtime.mainScript)}`,
    };
  }

  // 5. The service.
  const systemctlEnv = userBusEnvironment(host);
  const systemctl = async (...args: string[]): Promise<CommandResult> =>
    host.run("systemctl", ["--user", ...args], systemctlEnv);
  const wasActive = (await systemctl("is-active", "--quiet", SERVICE_NAME)).code === 0;
  // One server per data directory: one started by hand, or by an older setup
  // under another name, holds it, and the service would fail to start.
  const other = wasActive ? undefined : await host.serverVersion(dataDirectory);
  if (other !== undefined) {
    throw new Error(
      `A Wisp server (${other}) already runs on ${dataDirectory} without the service. Stop it, then run the setup again.`,
    );
  }
  // Checked before anything is enabled: a service that cannot get its port
  // would fail on every boot. A running Wisp holds its own port.
  const ownPort = wasActive && Number(current.get("WISP_PORT") ?? DEFAULT_PORT) === port;
  if (!ownPort && (await host.isPortInUse(address, port))) {
    throw new Error(
      `Another program already uses port ${port}. Choose a free port with --port (in the desktop app, the connection's server port), or stop that program, then run the setup again.`,
    );
  }
  stopIfCancelled();
  const unit = renderUnit(runtime.nodePath, runtime.mainScript, paths.envFile);
  await mkdir(path.dirname(paths.unitFile), { recursive: true });
  changed = (await writeIfChanged(paths.unitFile, unit, 0o644)) || changed;
  const reload = await systemctl("daemon-reload");
  if (reload.code !== 0) throw new Error(explainSystemdFailure(reload));
  const enable = await systemctl("enable", SERVICE_NAME);
  if (enable.code !== 0) throw new Error(explainSystemdFailure(enable));
  let service: SetupResult["service"] = "unchanged";
  let runningVersion: string | undefined;
  await track({ state: "activating", targetVersion: version });
  if (transaction && linked) {
    await updateWithRollback({
      host,
      paths,
      systemctl,
      dataDirectory,
      keyFile,
      version,
      fromVersion: linked,
      id: options.updateId ?? `${host.pid}-${host.now().getTime()}`,
      wasActive,
    });
    changed = true;
  }
  try {
    if (!wasActive || changed) {
      host.progress(wasActive ? "Restarting the service…" : "Starting the service…");
      const restart = await systemctl("restart", SERVICE_NAME);
      if (restart.code !== 0) throw new Error(explainSystemdFailure(restart));
      service = wasActive ? "restarted" : "started";
    } else {
      host.progress("The service is already running.");
    }
    await ensureLinger(host, systemctlEnv, warnings);

    host.progress(`Waiting for the server on port ${port}…`);
    const journal = `See why with: journalctl --user -u ${SERVICE_NAME} -n 50`;
    if (!(await waitUntilHealthy(host, address, port, stopIfCancelled))) {
      throw new Error(
        `The server did not answer on port ${port} within ${HEALTH_TIMEOUT_MS / 1000} seconds. ${journal}`,
      );
    }
    // A crash-looping service answers now and then; it must still be running.
    if ((await systemctl("is-active", "--quiet", SERVICE_NAME)).code !== 0) {
      throw new Error(`The server stopped right after it started. ${journal}`);
    }
    // Answering is not enough: it must be the version just installed.
    runningVersion = await host.serverVersion(dataDirectory);
    if (runningVersion !== undefined && runningVersion !== version) {
      throw new Error(`The server answers as version ${runningVersion} instead of ${version}. ${journal}`);
    }
  } catch (error) {
    // A server that never ran must not keep failing on every boot.
    if (!wasActive) await systemctl("disable", "--now", SERVICE_NAME);
    throw error;
  }
  if (host.archive) await tidyInstall(paths, [version, fromVersion], host);
  const pairingCode = options.pair ? await host.pairingCode(dataDirectory) : undefined;
  return { ...base, service, ...(runningVersion ? { runningVersion } : {}), ...(pairingCode ? { pairingCode } : {}) };
}

/**
 * Once the service runs an archive: removes the npm package a server set up
 * before archives existed ran from, and archive versions other than the one
 * running and the one before it. Data, the master key and settings live
 * elsewhere and stay.
 */
async function tidyInstall(
  paths: ReturnType<typeof setupPaths>,
  keep: ReadonlyArray<string | undefined>,
  host: SetupHost,
): Promise<void> {
  if (await exists(paths.packageDir)) {
    for (const name of ["node_modules", "package.json", "package-lock.json"]) {
      await rm(path.join(paths.installDir, name), { recursive: true, force: true });
    }
    host.progress("Removed the npm installation the server ran from before; data and settings are kept.");
  }
  for (const entry of await readdir(paths.versionsDir).catch(() => [])) {
    if (!entry.startsWith(".") && !keep.includes(entry)) {
      await rm(path.join(paths.versionsDir, entry), { recursive: true, force: true });
    }
  }
}

/** What to tell the person once setup is done, including what to do next. */
export function describeSetup(result: SetupResult): string {
  const lines = [""];
  if (result.service === "skipped") {
    lines.push(`Wisp server ${result.version} is installed. Start it with:`, `  ${result.startCommand}`);
  } else {
    lines.push(`Wisp server ${result.version} is running on port ${result.port}.`);
  }
  if (result.keyCreated) lines.push("", `Back up ${result.keyFile}: without it, saved credentials cannot be read.`);
  lines.push(
    "",
    "Connect from the Wisp desktop app: Settings → Connections → Add a server → SSH,",
    `with this machine's host name and server port ${result.port}.`,
  );
  if (result.pairingCode) {
    lines.push(`Or pair another device with this code (valid for 10 minutes): ${result.pairingCode}`);
  } else if (result.service !== "skipped") {
    lines.push("Run `wispctl pair` for a pairing code.");
  }
  if (!result.web) {
    lines.push(
      "",
      "To use Wisp in a browser or install it on a phone, serve the browser app:",
      "  wispctl setup --web",
    );
  } else if (!result.publicOrigin) {
    lines.push(
      "",
      "For a browser or phone, expose it on your tailnet and set the address:",
      `  tailscale serve --bg http://127.0.0.1:${result.port}`,
      "  wispctl setup --public-origin https://<machine>.<tailnet>.ts.net",
    );
  }
  for (const warning of result.warnings) lines.push("", `Note: ${warning}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Moves the service from the archive version it ran to this one as a
 * transaction over its data (ADR 046). With enough free space for a copy of
 * the data, it stops the service, snapshots the data under the data
 * directory's lock, and has the new version open the data in a process of
 * its own, which upgrades the databases without starting anything. If that
 * works, `current` moves to the new version and the transaction commits;
 * otherwise the snapshot is restored, the previous version starts again, and
 * this throws `RolledBackError`. Interrupted at any point, the journal in the
 * data directory lets the next setup or server start finish the rollback.
 */
async function updateWithRollback(update: {
  host: SetupHost;
  paths: ReturnType<typeof setupPaths>;
  systemctl: (...args: string[]) => Promise<CommandResult>;
  dataDirectory: string;
  keyFile: string;
  version: string;
  fromVersion: string;
  id: string;
  wasActive: boolean;
}): Promise<void> {
  const { host, paths, systemctl, dataDirectory, keyFile, version, fromVersion, id, wasActive } = update;
  const needed = await snapshotSpace(dataDirectory);
  const available = await host.freeSpace(dataDirectory);
  if (available < needed) {
    throw new Error(
      `Updating needs ${megabytes(needed)} free in ${dataDirectory} to keep a copy of the data, and ${megabytes(available)} are free. Free some space, then run the setup again.`,
    );
  }
  const journal = { id, fromVersion, targetVersion: version };
  host.progress(`Stopping Wisp server ${fromVersion} to update it…`);
  if (wasActive) {
    const stop = await systemctl("stop", SERVICE_NAME);
    if (stop.code !== 0) throw new Error(explainSystemdFailure(stop));
  }
  // The server is down from here on: whatever happens, a version starts again.
  let failure: string | undefined;
  try {
    await withLock(dataDirectory, host, async () => {
      await recoverTransaction(dataDirectory);
      await takeSnapshot(dataDirectory, { ...journal, step: "snapshotting" });
    });
    host.progress(`Opening the data with Wisp server ${version}…`);
    const target = path.join(paths.versionsDir, version);
    const trial = await host.run(
      path.join(target, "runtime/node"),
      [path.join(target, "app/server/cli.js"), "prepare-data", "--data-dir", dataDirectory, "--key-file", keyFile],
      { ...host.env, WISP_UPDATE_TRANSACTION: id },
      PREPARE_TIMEOUT_MS,
    );
    await withLock(dataDirectory, host, async () => {
      if (trial.code === 0) {
        // `current` moves before the commit: interrupted between the two, the
        // new version starts, rolls back the uncommitted data, and upgrades it again.
        await pointCurrentAt(paths, version);
        await commitTransaction(dataDirectory);
        return;
      }
      failure = trial.stderr.trim().split("\n").filter(Boolean).pop() ?? `exit code ${trial.code}`;
      host.progress(`Wisp server ${version} could not open the data. Restoring ${fromVersion}…`);
      await restoreSnapshot(dataDirectory, { ...journal, step: "trying" });
    });
  } catch (error) {
    // The journal stays; the server that starts next finishes the rollback.
    failure ??= error instanceof Error ? error.message : "The update stopped.";
  }
  if (failure === undefined) return;
  if (wasActive) await systemctl("start", SERVICE_NAME);
  throw new RolledBackError(
    `Wisp server ${version} could not open the data, so ${fromVersion} and its data were restored: ${failure}`,
  );
}

/** Runs `work` holding the data directory's lock, waiting for a server that is exiting to let go of it. */
async function withLock<T>(dataDirectory: string, host: SetupHost, work: () => Promise<T>): Promise<T> {
  let lock: InstanceLock | undefined;
  for (let waited = 0; !lock; waited += 500) {
    try {
      lock = InstanceLock.acquire(dataDirectory);
    } catch (error) {
      if (waited >= LOCK_TIMEOUT_MS || !(error instanceof Error) || !/already using/.test(error.message)) throw error;
      await host.sleep(500);
    }
  }
  try {
    return await work();
  } finally {
    lock.release();
  }
}

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / 1024 / 1024)} MB`;
}

/**
 * Copies the archive setup runs from into `versions/<version>`, unless that
 * version is there already. The copy goes into a staging folder first and is
 * renamed into place complete, so an interrupted setup never leaves a
 * partial version that looks installed.
 */
async function installArchive(
  paths: ReturnType<typeof setupPaths>,
  archive: ServerArchive,
  host: SetupHost,
  stopIfCancelled: () => void,
): Promise<void> {
  const { version } = archive.manifest;
  const target = path.join(paths.versionsDir, version);
  const runningInstalled = path.resolve(archive.root) === path.resolve(target);
  if (runningInstalled || (await readIfExists(path.join(target, INSTALL_COMPLETE))) === version) {
    host.progress(`Wisp server ${version} is already installed.`);
  } else {
    host.progress(`Installing Wisp server ${version}…`);
    await mkdir(paths.versionsDir, { recursive: true });
    const staging = await mkdtemp(path.join(paths.versionsDir, ".staging-"));
    try {
      await cp(archive.root, staging, { recursive: true, verbatimSymlinks: true });
      stopIfCancelled();
      await writeFile(path.join(staging, INSTALL_COMPLETE), version);
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
}

/** Points `current` at an installed version; reports whether it moved, which means the service must restart. */
async function pointCurrentAt(paths: ReturnType<typeof setupPaths>, version: string): Promise<boolean> {
  const link = path.join("versions", version);
  if ((await readlink(paths.current).catch(() => undefined)) === link) return false;
  // A new link renamed over the old one, so `current` always points somewhere.
  const temporary = `${paths.current}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  await symlink(link, temporary);
  await rename(temporary, paths.current);
  return true;
}

/**
 * Installs the npm package into a staging prefix inside `installDir`, then
 * moves it into place, so a failed or interrupted `npm install` leaves the
 * installed server as it was. Resolves with the version installed.
 */
async function installPackage(
  installDir: string,
  spec: string,
  host: SetupHost,
  signal: AbortSignal | undefined,
  stopIfCancelled: () => void,
): Promise<string> {
  await mkdir(installDir, { recursive: true });
  const staging = await mkdtemp(path.join(installDir, ".npm-staging-"));
  try {
    const result = await host.run(
      "npm",
      ["install", "--prefix", staging, "--no-audit", "--no-fund", "--loglevel=error", spec],
      { ...host.env, PATH: `${path.dirname(host.nodePath)}${path.delimiter}${host.env.PATH ?? ""}` },
      NPM_TIMEOUT_MS,
      signal,
    );
    stopIfCancelled();
    if (result.code !== 0) throw new Error(explainInstallFailure(spec, result));
    const version = await installedVersion(staging);
    if (!version) throw new Error(`Installing ${spec} left an incomplete package. Run the setup again.`);
    for (const name of ["node_modules", "package.json", "package-lock.json"]) {
      if (!(await exists(path.join(staging, name)))) continue;
      const target = path.join(installDir, name);
      await rename(target, path.join(staging, `${name}.previous`)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await rename(path.join(staging, name), target);
    }
    return version;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** The version installed in `installDir`, only when the install is complete: an interrupted `npm install` must be repeated. */
async function installedVersion(installDir: string): Promise<string | undefined> {
  const packageDir = path.join(installDir, "node_modules", ...WISP_SERVER_PACKAGE.split("/"));
  const text = await readIfExists(path.join(packageDir, "package.json"));
  if (!text) return undefined;
  let manifest: { version?: unknown; dependencies?: unknown };
  try {
    manifest = JSON.parse(text) as typeof manifest;
  } catch {
    return undefined;
  }
  const { version, dependencies } = manifest;
  if (typeof version !== "string" || !SERVER_VERSION_PATTERN.test(version)) return undefined;
  if (!(await exists(path.join(packageDir, "server/main.js")))) return undefined;
  for (const name of Object.keys(typeof dependencies === "object" && dependencies ? dependencies : {})) {
    // npm puts a dependency at the top, or next to the package when versions conflict.
    const found = await Promise.all(
      [installDir, packageDir].map((directory) =>
        exists(path.join(directory, "node_modules", ...name.split("/"), "package.json")),
      ),
    );
    if (!found.includes(true)) return undefined;
  }
  return version;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function ensureLinger(host: SetupHost, env: NodeJS.ProcessEnv, warnings: string[]): Promise<void> {
  const state = await host.run("loginctl", ["show-user", host.user, "--property=Linger"], env);
  if (state.code === 0 && /Linger=yes/.test(state.stdout)) return;
  const enable = await host.run("loginctl", ["enable-linger", host.user], env);
  if (enable.code !== 0) {
    warnings.push(
      `Wisps stop when you log out. Run \`sudo loginctl enable-linger ${host.user}\` to keep the server running.`,
    );
  }
}

async function waitUntilHealthy(
  host: SetupHost,
  address: string,
  port: number,
  stopIfCancelled: () => void,
): Promise<boolean> {
  for (let waited = 0; waited < HEALTH_TIMEOUT_MS; waited += 500) {
    stopIfCancelled();
    if (await host.isHealthy(address, port)) return true;
    await host.sleep(500);
  }
  return false;
}

/** Where the server can be reached on this machine, given its `WISP_HOST`. */
export function probeAddress(bind: string | undefined): string {
  if (!bind || bind === "0.0.0.0") return "127.0.0.1";
  if (bind === "::" || bind === "[::]") return "::1";
  return bind.replace(/^\[(.*)\]$/, "$1");
}

/** `systemctl --user` needs the user's runtime directory, which SSH commands do not always have. */
function userBusEnvironment(host: SetupHost): NodeJS.ProcessEnv {
  if (host.env.XDG_RUNTIME_DIR) return host.env;
  return { ...host.env, XDG_RUNTIME_DIR: `/run/user/${host.uid}` };
}

function explainSystemdFailure(result: CommandResult): string {
  const detail = result.stderr.trim().split("\n").pop() ?? "";
  if (result.code === 127) {
    return "systemd is not available here. Add --no-service to only install the files, or run the server with Docker.";
  }
  if (/Failed to connect to (user )?bus|No such file or directory|XDG_RUNTIME_DIR/i.test(detail)) {
    return `The systemd user session is not running (${detail}). Log in to this account once, or run \`sudo loginctl enable-linger $USER\`, then run the setup again.`;
  }
  return `systemd could not start the service: ${detail || `exit code ${result.code}`}`;
}

function explainInstallFailure(spec: string, result: CommandResult): string {
  const text = result.stderr;
  if (result.code === 127) return "npm was not found next to Node.js. Install npm, then run the setup again.";
  if (/E404|404 Not Found/i.test(text)) {
    return `${spec} is not published on npm. Check the version, or install another one with --package.`;
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|network/i.test(text)) {
    return `npm could not reach the registry. Check this machine's internet access and run the setup again.`;
  }
  if (/EACCES/i.test(text)) return "npm could not write to ~/.local/lib. Check that you own your home directory.";
  const detail = text.trim().split("\n").slice(-3).join(" ");
  return `Installing ${spec} failed${detail ? `: ${detail}` : "."}`;
}

export function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The public origin must be an address such as https://machine.tailnet-name.ts.net.");
  }
  if (url.protocol !== "https:" || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("The public origin must be an https:// address without a path.");
  }
  return url.origin;
}

export function renderUnit(nodePath: string, mainScript: string, envFile: string): string {
  return `# Written by the Wisp server setup; run it again to update.
[Unit]
Description=Wisp server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${unitEscape(envFile)}
ExecStart=${unitQuote(nodePath)} ${unitQuote(mainScript)}
Restart=on-failure
RestartSec=5
# Agents get ten seconds to settle their last turn on stop.
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`;
}

/** `KEY=value` lines of an environment file, as systemd reads them. */
export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(["\\])/g, "$1");
    }
    values.set(match[1]!, value);
  }
  return values;
}

/** Sets `values` in an environment file, keeping comments and variables setup does not manage. */
export function renderEnvFile(existing: string | undefined, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values));
  const lines = (
    existing ?? "# Settings of the Wisp server; see docs/remote-server.md. Keep this file private (mode 600).\n"
  ).split("\n");
  if (lines.at(-1) === "") lines.pop();
  const output = lines.map((line) => {
    const key = /^\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (!key || !pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${envValue(value)}`;
  });
  for (const [key, value] of pending) output.push(`${key}=${envValue(value)}`);
  if (existing === undefined && !values.WISP_PUBLIC_ORIGIN) {
    output.push(
      "# Set when a private HTTPS proxy (such as Tailscale Serve) exposes the server:",
      "# WISP_PUBLIC_ORIGIN=https://machine.tailnet-name.ts.net",
    );
  }
  return `${output.join("\n")}\n`;
}

const PLAIN = /^[\w@+=:,./-]+$/;

function envValue(value: string): string {
  return PLAIN.test(value) ? value : `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function shellQuote(value: string): string {
  return PLAIN.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function unitEscape(value: string): string {
  return value.replace(/%/g, "%%");
}

function unitQuote(value: string): string {
  const escaped = unitEscape(value).replace(/\$/g, "$$$$");
  return PLAIN.test(value) ? escaped : `"${escaped.replace(/["\\]/g, "\\$&")}"`;
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Writes a file with the given mode unless it already holds exactly this content; reports whether it changed. */
async function writeIfChanged(file: string, content: string, mode: number): Promise<boolean> {
  const existing = await readIfExists(file);
  if (existing !== content) await writeFile(file, content, { mode });
  await chmod(file, mode);
  return existing !== content;
}
