import { spawn } from "node:child_process";

import { FatalTransportError } from "../../client/remote-session.js";
import type { SshConnectionProfile } from "../../shared/connections.js";
import {
  SERVER_RELEASES_URL,
  SERVER_VERSION_PATTERN,
  serverArchiveName,
  WISP_SERVER_PACKAGE,
  type ServerArchiveHashes,
} from "../../shared/server-package.js";
import { parseServerUpdateRecord, type ServerUpdateRecord, UPDATE_ID_PATTERN } from "../../shared/server-update.js";
import { SshQuestions, type SshInteraction } from "./ssh-auth.js";
import { detailsOf, parseLines, runWispctl, sshArguments, sshFailure, WISPCTL } from "./ssh-tunnel.js";

// Downloading the package and its dependencies can take a while on a small machine.
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 16 * 1024;

export interface SshInstallOptions {
  /** The version of this app; the server it installs is always the same version. */
  version: string;
  /** The OpenSSH client; tests substitute a fake. */
  sshPath?: string;
  signal?: AbortSignal;
  /** Called with each line the setup reports, such as "Installing…", and the step it belongs to. */
  onProgress?: (message: string, step: InstallStep) => void;
  /** Lets OpenSSH ask the person questions; without it, SSH runs in BatchMode. */
  interaction?: SshInteraction;
  /** Names the run in the server's update record, so its result can be asked for later. */
  updateId?: string;
  /**
   * The hashes of this version's server archives, which this app carries.
   * With them, the server downloads its archive with Node.js included;
   * without them (a development build), it installs the npm package.
   */
  archives?: ServerArchiveHashes;
}

/** What a setup that finished reported. */
export interface InstallOutcome {
  /** The port the server listens on, when the setup said. */
  port?: number;
  /** The version the server answered with once it ran. */
  version?: string;
}

/**
 * The setup started on the server, then the connection ended before it
 * answered: it may still run, or have finished. Ask the server's update
 * record before calling it failed, and never run it again only for this.
 */
export class SetupOutcomeUnknownError extends FatalTransportError {
  override name = "SetupOutcomeUnknownError";
}

/** Where the setup is: downloading the server, installing it, or starting its service. */
export type InstallStep = "download" | "install" | "service";

/** What the setup's command prints first on the server: SSH reached the host and signed in. */
export const CONNECTED_MESSAGE = "Connected. Downloading the Wisp server…";

/** The step a line of the setup's output belongs to, given the step before it. */
export function installStepOf(message: string, previous: InstallStep): InstallStep {
  if (/service|Waiting for the server/i.test(message)) return "service";
  if (/^Installing |is already installed|master key/i.test(message)) return "install";
  return previous;
}

/** The archive install script reports why it stopped on one stderr line: `wisp-install: <reason> [detail]`. */
const ARCHIVE_FAILURE = /^wisp-install: ([a-z-]+)(?: (.*))?$/m;

/**
 * The command that installs a server archive on the server, then runs the
 * setup inside it. The remote shell sees the app's version, the port, the
 * update ID and the archives' hashes, all validated; never text from the user.
 *
 * It detects the processor and the C library, takes a lock (a directory,
 * which `mkdir` creates atomically, holding the owner's PID so a lock left by
 * a dead process is taken over), and removes downloads an interrupted run
 * left. Unless that version is installed completely already, it downloads the
 * archive from the release into a staging folder, checks it against the hash
 * this app carries, checks that it runs on this machine, marks it complete,
 * and moves it into `versions/<version>`. The setup then copies nothing and
 * points `current` at it. Failures print one `wisp-install:` line for the
 * app to explain.
 */
export function archiveInstallCommand(
  version: string,
  serverPort: number,
  updateId: string | undefined,
  archives: ServerArchiveHashes,
): string {
  validate(version, serverPort, updateId);
  if (archives.version !== version) throw new FatalTransportError(`This app carries no server archive for ${version}.`);
  const hashes = Object.values(archives.sha256);
  if (!hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash)))
    throw new FatalTransportError("The archive hashes are invalid.");
  // The archive's name for the processor the script detects ($a).
  const name = serverArchiveName(version, "x64").replace(/x64$/, "$a");
  const script = [
    `PATH="$HOME/.local/bin:$PATH"`,
    `echo "${CONNECTED_MESSAGE}" >&2`,
    `fail() { echo "wisp-install: $*" >&2; exit 1; }`,
    `case "$(uname -s) $(uname -m)" in`,
    `  "Linux x86_64"|"Linux amd64") a=x64; h=${archives.sha256.x64} ;;`,
    `  "Linux aarch64"|"Linux arm64") a=arm64; h=${archives.sha256.arm64} ;;`,
    `  *) fail unsupported-system "$(uname -s) $(uname -m)" ;;`,
    `esac`,
    `g=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail unsupported-libc`,
    `g=\${g#glibc }`,
    `case "$g" in [01].*|2.[0-9]|2.[0-9].*|2.1[0-9]|2.1[0-9].*|2.2[0-7]|2.2[0-7].*) fail old-glibc "$g" ;; esac`,
    `r="$HOME/.local/lib/wisp-server"; d="$r/versions"; v="$d/${version}"; n="${name}"`,
    `mkdir -p "$d" || fail no-space "$d"`,
    `l="$r/.install.lock"; i=0`,
    `until mkdir "$l" 2>/dev/null; do`,
    `  p=$(cat "$l/pid" 2>/dev/null); i=$((i + 1))`,
    `  if { [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; } || { [ -z "$p" ] && [ "$i" -gt 10 ]; }; then rm -rf "$l"; continue; fi`,
    `  [ "$i" -le 300 ] || fail busy`,
    `  sleep 1`,
    `done`,
    `echo $$ >"$l/pid"; t=""`,
    // No single quotes anywhere: the whole script is one single-quoted argument.
    `cleanup() { rm -rf "$l"; if [ -n "$t" ]; then rm -rf "$t"; fi; }`,
    `trap cleanup EXIT`,
    `trap "exit 130" INT TERM HUP`,
    `rm -rf "$d"/.download-*`,
    `if [ "$(cat "$v/.install-complete" 2>/dev/null)" != "${version}" ]; then`,
    `  t=$(mktemp -d "$d/.download-XXXXXX") || fail no-space "$d"`,
    `  f="$t/archive.tar.gz"; u="${SERVER_RELEASES_URL}/v${version}/$n.tar.gz"`,
    `  echo "Downloading Wisp server ${version} for $a…" >&2`,
    `  if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time 900 -o "$f" "$u" || fail download "$u"`,
    `  elif command -v wget >/dev/null 2>&1; then wget -q -T 30 -O "$f" "$u" || fail download "$u"`,
    `  else fail no-downloader; fi`,
    `  if command -v sha256sum >/dev/null 2>&1; then s=$(sha256sum "$f"); else s=$(shasum -a 256 "$f") || fail no-sha256; fi`,
    `  [ "\${s%% *}" = "$h" ] || fail checksum`,
    `  echo "Installing Wisp server ${version}…" >&2`,
    `  tar -xzf "$f" -C "$t" || fail no-space "$d"`,
    `  rm -f "$f"`,
    `  "$t/$n/bin/wispctl" version --check >&2 || fail cannot-run`,
    `  echo "${version}" >"$t/$n/.install-complete"`,
    `  rm -rf "$v"; mv "$t/$n" "$v" || fail no-space "$d"`,
    `fi`,
    `"$v/bin/wispctl" setup --json --no-pair --until-stdin-closes --port ${serverPort}${updateId ? ` --update-id ${updateId}` : ""}`,
  ].join("\n");
  if (script.includes("'")) throw new FatalTransportError("The install script cannot be quoted.");
  return `sh -c '${script}'`;
}

function validate(version: string, serverPort: number, updateId: string | undefined): void {
  if (!SERVER_VERSION_PATTERN.test(version))
    throw new FatalTransportError(`${version} is not a version Wisp can install.`);
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new FatalTransportError("The server port is invalid.");
  }
  if (updateId !== undefined && !UPDATE_ID_PATTERN.test(updateId)) {
    throw new FatalTransportError("The update ID is invalid.");
  }
}

/**
 * The command run on the server. The remote shell sees only the app's own
 * version and the profile's port, both validated; never text from the user.
 * ~/.local/bin is added because it is often missing from the PATH of
 * non-interactive SSH sessions. The first line tells the app that SSH reached
 * the host and signed in, which OpenSSH itself does not report. The package
 * goes into a new directory each time, unlike `npx`, whose cache keeps a
 * half-extracted install from an interrupted setup and fails on it from then
 * on. npm's output goes to stderr so stdout carries only the setup's result.
 * Without a terminal, ending ssh does not stop the remote command, so it
 * stops itself when its stdin closes.
 */
export function installCommand(version: string, serverPort: number, updateId?: string): string {
  validate(version, serverPort, updateId);
  const cli = `"$d/node_modules/${WISP_SERVER_PACKAGE}/server/cli.js"`;
  const script = [
    `PATH="$HOME/.local/bin:$PATH"`,
    `echo "${CONNECTED_MESSAGE}" >&2`,
    `d=$(mktemp -d) || exit 1`,
    `npm install --prefix "$d" --no-audit --no-fund --loglevel=error ${WISP_SERVER_PACKAGE}@${version} >&2 && node ${cli} setup --json --no-pair --until-stdin-closes --port ${serverPort}${updateId ? ` --update-id ${updateId}` : ""}`,
    `s=$?`,
    `rm -rf "$d"`,
    `exit $s`,
  ].join("; ");
  // sh runs it whatever the account's login shell is.
  return `sh -c '${script}'`;
}

/**
 * Installs and starts the Wisp server on a machine reached over SSH, by
 * running its `setup` there. Resolves with the port and version the setup
 * reports.
 */
export async function installRemoteServer(
  profile: SshConnectionProfile,
  options: SshInstallOptions,
): Promise<InstallOutcome> {
  const command = options.archives
    ? archiveInstallCommand(options.version, profile.serverPort, options.updateId, options.archives)
    : installCommand(options.version, profile.serverPort, options.updateId);
  const ssh = options.sshPath ?? "ssh";
  const questions = new SshQuestions(options.interaction, ssh, profile, options.signal);
  const child = spawn(
    ssh,
    ["-T", ...sshArguments(profile, questions.interactive), "--", profile.host, command],
    // stdin stays open and silent: closing it is how the setup learns it was cancelled.
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...(questions.env ? { env: questions.env } : {}) },
  );
  child.stdin?.on("error", () => undefined);
  let stdout = "";
  let stderr = "";
  let pending = "";
  let step: InstallStep = "download";
  // Until the setup says it is connected, stderr is OpenSSH's own.
  let connected = false;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = (stdout + chunk).slice(-MAX_OUTPUT);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_OUTPUT);
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const message = line.trim();
      if (message === CONNECTED_MESSAGE) connected = true;
      // npm's own chatter is not about Wisp.
      if (connected && message && !/^npm /i.test(message)) {
        step = installStepOf(message, step);
        options.onProgress?.(message.slice(0, 160), step);
      }
    }
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, INSTALL_TIMEOUT_MS);
  const stop = (): void => void child.kill("SIGTERM");
  options.signal?.addEventListener("abort", stop, { once: true });
  let spawnError: Error | undefined;
  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
    child.once("error", (error) => {
      spawnError = error;
      resolve(null);
    });
  });
  clearTimeout(timer);
  questions.close();
  child.stdin?.destroy();
  options.signal?.removeEventListener("abort", stop);
  if (options.signal?.aborted) throw new FatalTransportError("Installing the server was cancelled.", "cancelled");
  const result = /^\{.*\}$/m.exec(stdout)?.[0];
  if (code === 0 && result) return outcomeOf(result);
  const failure = explainInstallFailure(profile, options.version, code, stderr, timedOut, spawnError, questions);
  // OpenSSH exits with 255 when the connection drops; it may have dropped while the setup went on.
  if (connected && (timedOut || code === 255 || code === null)) {
    throw new SetupOutcomeUnknownError(failure.message, failure.failure, failure.details);
  }
  throw failure;
}

/**
 * Asks the server how the setup with this ID ended, with `wispctl
 * update-status` over SSH. It only reads. Resolves undefined when the server
 * has no record of it, or is too old to keep one.
 */
export async function readServerUpdate(
  profile: SshConnectionProfile,
  updateId: string,
  options: { sshPath?: string; interaction?: SshInteraction } = {},
): Promise<ServerUpdateRecord | undefined> {
  if (!UPDATE_ID_PATTERN.test(updateId)) throw new FatalTransportError("The update ID is invalid.");
  const run = await runWispctl(
    options.sshPath ?? "ssh",
    profile,
    options.interaction,
    `${WISPCTL} update-status --json --id ${updateId}`,
  );
  if (run.exitCode === 255 || run.spawnError || run.timedOut) {
    const failure = sshFailure(run.stderr, profile, run.spawnError, run.questions);
    throw new FatalTransportError(failure.message, failure.failure, failure.details);
  }
  return parseLines(run.stdout)
    .map(parseServerUpdateRecord)
    .find((record) => record?.id === updateId);
}

/** Why the setup over SSH failed, in terms of what to do on the server. */
export function explainInstallFailure(
  profile: SshConnectionProfile,
  version: string,
  exitCode: number | null,
  stderr: string,
  timedOut: boolean,
  spawnError?: Error,
  questions?: SshQuestions,
): FatalTransportError {
  const { host } = profile;
  const details = detailsOf(stderr);
  if (timedOut) {
    return new FatalTransportError(
      `Installing on ${host} took more than ${INSTALL_TIMEOUT_MS / 60_000} minutes. Check its internet connection, or run \`npx ${WISP_SERVER_PACKAGE} setup\` there.`,
      "install",
      details,
    );
  }
  // OpenSSH exits with 255 when the connection itself failed.
  if (spawnError || exitCode === 255) {
    const failure = sshFailure(stderr, profile, spawnError, questions);
    return new FatalTransportError(failure.message, failure.failure, failure.details);
  }
  const archiveFailure = ARCHIVE_FAILURE.exec(stderr);
  if (archiveFailure)
    return explainArchiveFailure(host, version, archiveFailure[1]!, archiveFailure[2], stderr, details);
  if (
    /(npx|npm|node): (command )?not found|(npx|npm|node): No such file|env: .?(node|npx|npm).?: No such file/i.test(
      stderr,
    ) ||
    exitCode === 127
  ) {
    return new FatalTransportError(
      `Node.js is missing on ${host}, or not in the PATH of SSH commands. Install Node.js 22.19 or later there, then retry.`,
      "node",
      details,
    );
  }
  const last = stderr
    .trim()
    .split("\n")
    .filter((line) => !/^npm (warn|notice)/i.test(line))
    .pop();
  if (/Wisp needs Node\.js/i.test(stderr)) {
    return new FatalTransportError(`${last ?? "Node.js is too old"} (on ${host})`, "node", details);
  }
  if (/E404|404 Not Found|is not published on npm/i.test(stderr)) {
    return new FatalTransportError(
      `Wisp server ${version} is not published on npm, so ${host} cannot install it. Update Wisp to a released version, or set the server up by hand (see “How to set up a Wisp server”).`,
      "install",
      details,
    );
  }
  return new FatalTransportError(
    `Could not set up the Wisp server on ${host}${last ? `: ${last}` : "."}`,
    "install",
    details,
  );
}

/** Why installing a server archive stopped, from the script's `wisp-install:` line. */
function explainArchiveFailure(
  host: string,
  version: string,
  reason: string,
  detail: string | undefined,
  stderr: string,
  details: string | undefined,
): FatalTransportError {
  const docs = "or use Docker there (see “How to set up a Wisp server”)";
  const messages: Record<string, string> = {
    "unsupported-system": `${host} runs ${detail ?? "a system"} the Wisp server is not built for. It runs on Linux on x64 or arm64; ${docs}.`,
    "unsupported-libc": `${host} has no GNU C library (glibc), which the Wisp server needs; Alpine and other musl systems are not supported. Install the server ${docs}.`,
    "old-glibc": `${host} has glibc ${detail ?? ""}, but the Wisp server needs 2.28 or later (Debian 10, Ubuntu 20.04, RHEL 8 or newer). Update the system, ${docs}.`,
    busy: `Another installation of the Wisp server is running on ${host}. Wait for it to finish, then retry.`,
    "no-downloader": `${host} has neither curl nor wget to download the Wisp server. Install one of them, then retry.`,
    "no-sha256": `${host} has neither sha256sum nor shasum to check the download. Install coreutils, then retry.`,
    download: `${host} could not download Wisp server ${version}. Check its internet access to github.com, then retry.`,
    checksum: `The Wisp server ${host} downloaded does not match the one this app expects, so nothing was installed. Retry; if it happens again, report it.`,
    "no-space": `Could not unpack the Wisp server on ${host}. Check the free space in ~/.local/lib, then retry.`,
    "cannot-run": `Wisp server ${version} cannot run on ${host}: ${lastLine(stderr.slice(0, stderr.search(ARCHIVE_FAILURE))) ?? "its check failed"}.`,
  };
  return new FatalTransportError(
    messages[reason] ?? `Could not set up the Wisp server on ${host}: ${reason}.`,
    "install",
    details,
  );
}

function lastLine(text: string): string | undefined {
  return text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
}

/** The port and running version in the setup's JSON result, when they are valid. */
function outcomeOf(result: string): InstallOutcome {
  try {
    const { port, runningVersion } = JSON.parse(result) as { port?: unknown; runningVersion?: unknown };
    const validPort = Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65_535;
    const version =
      typeof runningVersion === "string" && SERVER_VERSION_PATTERN.test(runningVersion) ? runningVersion : undefined;
    return { ...(validPort ? { port: port as number } : {}), ...(version ? { version } : {}) };
  } catch {
    return {};
  }
}
