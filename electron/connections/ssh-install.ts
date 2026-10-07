import { spawn } from "node:child_process";

import { FatalTransportError } from "../../client/remote-session.js";
import type { SshConnectionProfile } from "../../shared/connections.js";
import { SERVER_VERSION_PATTERN, WISP_SERVER_PACKAGE } from "../../shared/server-package.js";
import { classify, sshArguments } from "./ssh-tunnel.js";

// Downloading the package and its dependencies can take a while on a small machine.
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 16 * 1024;

export interface SshInstallOptions {
  /** The version of this app; the server it installs is always the same version. */
  version: string;
  /** The OpenSSH client; tests substitute a fake. */
  sshPath?: string;
  /** Wisp's own key, once it added one to the server. */
  identityFile?: string;
  signal?: AbortSignal;
  /** Called with each line the setup reports, such as "Installing…". */
  onProgress?: (message: string) => void;
}

/** Where Wisp keeps a Node.js it downloaded, beside the server it installs. */
export const PORTABLE_NODE_DIR = "$HOME/.local/lib/wisp-server/node";

/**
 * The script run on the server, by `sh` from stdin, so it works whatever the
 * account's login shell is. It sees only the app's own version and the
 * profile's port, both validated; never text from the user.
 *
 * It finds a Node.js 22.19 or later with npx beside it: on the PATH (with
 * ~/.local/bin, often missing from non-interactive SSH sessions), Wisp's own,
 * or one from nvm, fnm, Volta, mise, or asdf. Without one, it downloads the
 * latest Node.js 22 for Linux from nodejs.org, checks it against the release's
 * SHASUMS256.txt, and keeps it in ~/.local/lib/wisp-server/node.
 *
 * Without a terminal, ending ssh does not stop the remote command, so the
 * setup stops itself when its stdin, still this script's, closes.
 */
export function installScript(version: string, serverPort: number): string {
  if (!SERVER_VERSION_PATTERN.test(version))
    throw new FatalTransportError(`${version} is not a version Wisp can install.`);
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new FatalTransportError("The server port is invalid.");
  }
  return `set -e
PATH="$HOME/.local/bin:$PATH"
wisp_node="${PORTABLE_NODE_DIR}"
node_dist="\${WISP_NODE_DIST:-https://nodejs.org/dist/latest-v22.x}"
# Node.js 22.19 or later, with npx beside it.
usable() {
  [ -x "$1" ] && [ -x "$(dirname "$1")/npx" ] || return 1
  v=$("$1" -p process.versions.node 2>/dev/null) || return 1
  major=\${v%%.*}; rest=\${v#*.}; minor=\${rest%%.*}
  [ "$major" -gt 22 ] 2>/dev/null || { [ "$major" -eq 22 ] && [ "$minor" -ge 19 ]; } 2>/dev/null
}
find_node() {
  for candidate in "$(command -v node 2>/dev/null || true)" "$wisp_node/bin/node" \\
    "$HOME"/.nvm/versions/node/*/bin/node \\
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \\
    "$HOME"/.fnm/node-versions/*/installation/bin/node \\
    "$HOME"/.volta/tools/image/node/*/bin/node \\
    "$HOME"/.local/share/mise/installs/node/*/bin/node \\
    "$HOME"/.asdf/installs/nodejs/*/bin/node; do
    if usable "$candidate"; then echo "$candidate"; return 0; fi
  done
  return 1
}
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  else echo "Wisp needs curl or wget on this machine to download Node.js. Install one, or Node.js 22.19 or later, then retry." >&2; exit 1
  fi
}
download_node() {
  if [ "$(uname -s)" != Linux ]; then
    echo "Wisp can download Node.js only on Linux. Install Node.js 22.19 or later there, then retry." >&2; exit 1
  fi
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    *) echo "Node.js has no build for $(uname -m). Install Node.js 22.19 or later there, then retry." >&2; exit 1 ;;
  esac
  line=$(fetch "$node_dist/SHASUMS256.txt" | grep " node-v22[.][0-9.]*-linux-$arch[.]tar[.]gz$" | head -n 1)
  if [ -z "$line" ]; then echo "Could not find Node.js 22 for linux-$arch at $node_dist." >&2; exit 1; fi
  file=\${line##* }; sum=\${line%% *}
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  echo "Downloading \${file%.tar.gz}…" >&2
  fetch "$node_dist/$file" > "$tmp/node.tar.gz"
  if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp/node.tar.gz"); else actual=$(shasum -a 256 "$tmp/node.tar.gz"); fi
  if [ "\${actual%% *}" != "$sum" ]; then echo "The Node.js download does not match its checksum. Retry later." >&2; exit 1; fi
  mkdir "$tmp/node"
  tar -xzf "$tmp/node.tar.gz" -C "$tmp/node" --strip-components=1
  mkdir -p "$(dirname "$wisp_node")"
  rm -rf "$wisp_node"
  mv "$tmp/node" "$wisp_node"
  rm -rf "$tmp"
  trap - EXIT
  echo "Installed \${file%.tar.gz} in $wisp_node." >&2
}
node=$(find_node) || { download_node; node="$wisp_node/bin/node"; }
bin=$(dirname "$node")
PATH="$bin:$PATH"
exec "$bin/npx" --yes ${WISP_SERVER_PACKAGE}@${version} setup --json --no-pair --until-stdin-closes --port ${serverPort}
`;
}

/** What the setup reported once it finished. */
export interface RemoteSetupResult {
  /** Things to do by hand, such as turning on linger. */
  warnings: string[];
}

/** Installs and starts the Wisp server on a machine reached over SSH, by running its `setup` there. */
export async function installRemoteServer(
  profile: SshConnectionProfile,
  options: SshInstallOptions,
): Promise<RemoteSetupResult> {
  const child = spawn(
    options.sshPath ?? "ssh",
    ["-T", ...sshArguments(profile, { identityFile: options.identityFile }), "--", profile.host, "sh -s"],
    // After the script, stdin stays open and silent: closing it is how the setup learns it was cancelled.
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  child.stdin?.on("error", () => undefined);
  child.stdin?.write(installScript(options.version, profile.serverPort));
  let stdout = "";
  let stderr = "";
  let pending = "";
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
      // npm's own chatter is not about Wisp.
      if (message && !/^npm /i.test(message)) options.onProgress?.(message.slice(0, 160));
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
  child.stdin?.destroy();
  options.signal?.removeEventListener("abort", stop);
  if (options.signal?.aborted) throw new FatalTransportError("Installing the server was cancelled.");
  const result = code === 0 ? /^\{.*\}$/m.exec(stdout)?.[0] : undefined;
  if (result) {
    try {
      const { warnings } = JSON.parse(result) as { warnings?: unknown };
      return {
        warnings: Array.isArray(warnings) ? warnings.filter((value): value is string => typeof value === "string") : [],
      };
    } catch {
      return { warnings: [] };
    }
  }
  throw explainInstallFailure(profile.host, options.version, code, stderr, timedOut, spawnError);
}

/** Why the setup over SSH failed, in terms of what to do on the server. */
export function explainInstallFailure(
  host: string,
  version: string,
  exitCode: number | null,
  stderr: string,
  timedOut: boolean,
  spawnError?: Error,
): FatalTransportError {
  if (timedOut) {
    return new FatalTransportError(
      `Installing on ${host} took more than ${INSTALL_TIMEOUT_MS / 60_000} minutes. Check its internet connection, or run \`npx ${WISP_SERVER_PACKAGE} setup\` there.`,
    );
  }
  // OpenSSH exits with 255 when the connection itself failed.
  if (spawnError || exitCode === 255) return new FatalTransportError(classify(stderr, host, spawnError).message);
  if (
    /npx: (command )?not found|npx: No such file|env: .?(node|npx).?: No such file/i.test(stderr) ||
    exitCode === 127
  ) {
    return new FatalTransportError(
      `Node.js is missing on ${host}, or not in the PATH of SSH commands. Install Node.js 22.19 or later there, then retry.`,
    );
  }
  const last = stderr
    .trim()
    .split("\n")
    .filter((line) => !/^npm (warn|notice)/i.test(line))
    .pop();
  if (/Wisp needs Node\.js/i.test(stderr)) {
    return new FatalTransportError(`${last ?? "Node.js is too old"} (on ${host})`);
  }
  if (/E404|404 Not Found|is not published on npm/i.test(stderr)) {
    return new FatalTransportError(
      `Wisp server ${version} is not published on npm, so ${host} cannot install it. Update Wisp to a released version, or set the server up by hand (see “How to set up a Wisp server”).`,
    );
  }
  return new FatalTransportError(`Could not set up the Wisp server on ${host}${last ? `: ${last}` : "."}`);
}
