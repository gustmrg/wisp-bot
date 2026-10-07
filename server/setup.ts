import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";

import { SERVER_VERSION_PATTERN, WISP_SERVER_PACKAGE } from "../shared/server-package.js";
import { adminRequest } from "./admin.js";
import { MasterKeyEncryption, readPrivateKeyFile } from "./master-key.js";

const HEALTH_TIMEOUT_MS = 30_000;
const NPM_TIMEOUT_MS = 10 * 60_000;
const SERVICE_NAME = "wisp";
const DEFAULT_PORT = 8787;

export interface SetupOptions {
  /** What to install; the version of the package that is running by default. */
  packageSpec?: string;
  port?: number;
  publicOrigin?: string;
  dataDirectory?: string;
  /** Install and start the systemd user service. Off, only the files are written. */
  service: boolean;
  /** Print a pairing code once the server answers. */
  pair: boolean;
  /** Stops the setup before it starts the service; what was installed stays. */
  signal?: AbortSignal;
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
  service: "started" | "restarted" | "unchanged" | "skipped";
  /** The command that starts the server by hand, when no service was installed. */
  startCommand?: string;
  pairingCode?: string;
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
  sleep(ms: number): Promise<void>;
  progress(message: string): void;
}

export function systemHost(version: string, progress: (message: string) => void): SetupHost {
  const info = os.userInfo();
  return {
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
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    progress,
  };
}

/** Where setup puts things, all under the account's home. */
export function setupPaths(home: string) {
  const installDir = path.join(home, ".local/lib/wisp-server");
  const packageDir = path.join(installDir, "node_modules", ...WISP_SERVER_PACKAGE.split("/"));
  const configDir = path.join(home, ".config/wisp");
  return {
    installDir,
    packageDir,
    mainScript: path.join(packageDir, "server/main.js"),
    cliScript: path.join(packageDir, "server/cli.js"),
    configDir,
    keyFile: path.join(configDir, "master.key"),
    envFile: path.join(configDir, "server.env"),
    wispctl: path.join(home, ".local/bin/wispctl"),
    unitFile: path.join(home, ".config/systemd/user", `${SERVICE_NAME}.service`),
    defaultDataDirectory: path.join(home, ".local/share/wisp"),
  };
}

/**
 * Installs and starts a Wisp server for the current account: the package under
 * `~/.local/lib/wisp-server`, a master key, `server.env`, the `wispctl`
 * command, and a systemd user service. Running it again keeps the key and
 * settings, and restarts the service only when something changed.
 */
export async function runSetup(options: SetupOptions, host: SetupHost): Promise<SetupResult> {
  const paths = setupPaths(host.home);
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

  // 1. The package, in a stable place: `npx` runs from a cache that may be cleared.
  const installed = await installedVersion(paths);
  const spec = options.packageSpec ?? `${WISP_SERVER_PACKAGE}@${host.version}`;
  let version = installed ?? host.version;
  if (options.packageSpec !== undefined || installed !== host.version) {
    host.progress(`Installing ${spec}…`);
    await mkdir(paths.installDir, { recursive: true });
    const result = await host.run(
      "npm",
      ["install", "--prefix", paths.installDir, "--no-audit", "--no-fund", "--loglevel=error", spec],
      { ...host.env, PATH: `${path.dirname(host.nodePath)}${path.delimiter}${host.env.PATH ?? ""}` },
      NPM_TIMEOUT_MS,
      options.signal,
    );
    stopIfCancelled();
    if (result.code !== 0) throw new Error(explainInstallFailure(spec, result));
    version = (await installedVersion(paths)) ?? host.version;
    changed = true;
  } else {
    host.progress(`${WISP_SERVER_PACKAGE} ${version} is already installed.`);
  }

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
    ...(wantedOrigin ? { WISP_PUBLIC_ORIGIN: wantedOrigin } : {}),
  });
  changed = (await writeIfChanged(paths.envFile, env, 0o600)) || changed;

  // 4. `wispctl`, for the person and for the desktop app's pairing over SSH.
  const shim = `#!/bin/sh\n# Written by the Wisp server setup; run it again to update.\nexec ${shellQuote(host.nodePath)} ${shellQuote(paths.cliScript)} "$@"\n`;
  await mkdir(path.dirname(paths.wispctl), { recursive: true });
  await writeIfChanged(paths.wispctl, shim, 0o755);
  if (!(host.env.PATH ?? "").split(path.delimiter).includes(path.dirname(paths.wispctl))) {
    warnings.push(`Add ${path.dirname(paths.wispctl)} to your PATH to run wispctl from a terminal.`);
  }
  // nvm, fnm, and the like keep each Node.js version in its own directory under the home.
  // The Node.js the desktop app downloads, beside the package, stays put.
  const underHome = !path.relative(host.home, host.nodePath).startsWith("..");
  const portable = !path.relative(path.join(paths.installDir, "node"), host.nodePath).startsWith("..");
  if (underHome && !portable) {
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
    warnings,
  };
  if (!options.service) {
    return {
      ...base,
      service: "skipped",
      startCommand: `WISP_MASTER_KEY_FILE=${shellQuote(keyFile)} WISP_DATA_DIR=${shellQuote(dataDirectory)} WISP_PORT=${port} ${shellQuote(host.nodePath)} ${shellQuote(paths.mainScript)}`,
    };
  }

  // 5. The service.
  const systemctlEnv = userBusEnvironment(host);
  const systemctl = async (...args: string[]): Promise<CommandResult> =>
    host.run("systemctl", ["--user", ...args], systemctlEnv);
  const wasActive = (await systemctl("is-active", "--quiet", SERVICE_NAME)).code === 0;
  // Checked before anything is enabled: a service that cannot get its port
  // would fail on every boot. A running Wisp holds its own port.
  const ownPort = wasActive && Number(current.get("WISP_PORT") ?? DEFAULT_PORT) === port;
  if (!ownPort && (await host.isPortInUse(address, port))) {
    throw new Error(
      `Another program already uses port ${port}. Choose a free port with --port (in the desktop app, the connection's server port), or stop that program, then run the setup again.`,
    );
  }
  stopIfCancelled();
  const unit = renderUnit(host.nodePath, paths.mainScript, paths.envFile);
  await mkdir(path.dirname(paths.unitFile), { recursive: true });
  changed = (await writeIfChanged(paths.unitFile, unit, 0o644)) || changed;
  const reload = await systemctl("daemon-reload");
  if (reload.code !== 0) throw new Error(explainSystemdFailure(reload));
  const enable = await systemctl("enable", SERVICE_NAME);
  if (enable.code !== 0) throw new Error(explainSystemdFailure(enable));
  let service: SetupResult["service"] = "unchanged";
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
  } catch (error) {
    // A server that never ran must not keep failing on every boot.
    if (!wasActive) await systemctl("disable", "--now", SERVICE_NAME);
    throw error;
  }
  const pairingCode = options.pair ? await host.pairingCode(dataDirectory) : undefined;
  return { ...base, service, ...(pairingCode ? { pairingCode } : {}) };
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
  if (!result.publicOrigin) {
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

/** The installed version, only when the install is complete: an interrupted `npm install` must be repeated. */
async function installedVersion(paths: ReturnType<typeof setupPaths>): Promise<string | undefined> {
  const text = await readIfExists(path.join(paths.packageDir, "package.json"));
  if (!text) return undefined;
  let manifest: { version?: unknown; dependencies?: unknown };
  try {
    manifest = JSON.parse(text) as typeof manifest;
  } catch {
    return undefined;
  }
  const { version, dependencies } = manifest;
  if (typeof version !== "string" || !SERVER_VERSION_PATTERN.test(version)) return undefined;
  if (!(await exists(paths.mainScript))) return undefined;
  for (const name of Object.keys(typeof dependencies === "object" && dependencies ? dependencies : {})) {
    // npm puts a dependency at the top, or next to the package when versions conflict.
    const found = await Promise.all(
      [paths.installDir, paths.packageDir].map((directory) =>
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
