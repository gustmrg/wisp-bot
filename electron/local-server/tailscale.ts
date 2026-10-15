import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { TailscaleView } from "../../shared/remote-access.js";

const STATUS_TIMEOUT_MS = 10_000;
const SERVE_TIMEOUT_MS = 30_000;
const ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";

export interface TailscaleRunResult {
  code: number | null;
  output: string;
}

/** Runs the Tailscale CLI; stops early once its output matches `until`. Tests substitute a fake. */
export type TailscaleRunner = (
  executable: string,
  args: readonly string[],
  options: { timeoutMs: number; until?: RegExp },
) => Promise<TailscaleRunResult>;

export interface TailscaleOptions {
  /** Where the CLI is, or undefined when it is not installed. */
  locate(): string | undefined;
  run?: TailscaleRunner;
}

/** Why Tailscale Serve could not be set up, in words for the person. */
export class TailscaleError extends Error {
  override name = "TailscaleError";
}

interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

/**
 * Sets up Tailscale Serve for remote access to this computer: HTTPS on port
 * 443 of this machine's tailnet name, forwarded to Wisp's loopback port. It
 * never uses Funnel, never replaces a serve someone else set up, and removes
 * only the one it added.
 */
export class Tailscale {
  private readonly run: TailscaleRunner;

  constructor(private readonly options: TailscaleOptions) {
    this.run = options.run ?? runTailscale;
  }

  /** Whether Tailscale can serve this computer, and at which address. */
  async detect(): Promise<TailscaleView> {
    const executable = this.options.locate();
    if (!executable) {
      return { status: "not_installed", message: "Tailscale is not installed on this computer." };
    }
    let status: {
      BackendState?: string;
      CertDomains?: string[] | null;
      Self?: { DNSName?: string };
    };
    try {
      const result = await this.run(executable, ["status", "--json"], { timeoutMs: STATUS_TIMEOUT_MS });
      status = JSON.parse(result.output) as typeof status;
    } catch {
      return { status: "not_running", message: "Tailscale is not running on this computer. Open it and sign in." };
    }
    const host = status.Self?.DNSName?.replace(/\.$/, "");
    if (status.BackendState !== "Running" || !host) {
      return { status: "not_running", message: "Tailscale is not signed in on this computer. Open it and sign in." };
    }
    return {
      status: "ready",
      origin: `https://${host}`,
      // Without HTTPS certificates, serving starts by asking to turn them on.
      httpsEnabled: (status.CertDomains ?? []).includes(host),
    };
  }

  /**
   * Serves `https://<this machine>` to Wisp's port. Resolves with the address,
   * and whether this call added the serve (false when it was already there).
   */
  async serve(port: number): Promise<{ origin: string; created: boolean }> {
    const state = await this.detect();
    if (state.status !== "ready") throw new TailscaleError(state.message);
    const executable = this.options.locate()!;
    const target = targetOf(port);
    const current = await this.rootHandler(executable, state.origin);
    if (current === target) return { origin: state.origin, created: false };
    if (current !== undefined) {
      throw new TailscaleError(
        `Tailscale Serve already shares something else at ${state.origin}. Wisp will not replace it: remove it with tailscale serve reset, or set remote access up by hand.`,
      );
    }
    const result = await this.run(executable, ["serve", "--bg", "--yes", "--https=443", target], {
      timeoutMs: SERVE_TIMEOUT_MS,
      until: CONSENT_URL,
    });
    if (result.code !== 0 || (await this.rootHandler(executable, state.origin)) !== target) {
      throw new TailscaleError(describeFailure(result.output));
    }
    return { origin: state.origin, created: true };
  }

  /** Removes the serve to Wisp's port, and nothing else; does nothing when it is gone or was changed. */
  async unserve(port: number): Promise<void> {
    const state = await this.detect();
    if (state.status !== "ready") return;
    const executable = this.options.locate()!;
    if ((await this.rootHandler(executable, state.origin)) !== targetOf(port)) return;
    const result = await this.run(executable, ["serve", "--yes", "--https=443", "--set-path=/", "off"], {
      timeoutMs: SERVE_TIMEOUT_MS,
    });
    if (result.code !== 0) throw new TailscaleError(describeFailure(result.output));
  }

  /** What `https://<this machine>/` forwards to, if anything. */
  private async rootHandler(executable: string, origin: string): Promise<string | undefined> {
    const result = await this.run(executable, ["serve", "status", "--json"], { timeoutMs: STATUS_TIMEOUT_MS });
    let config: ServeConfig;
    try {
      config = JSON.parse(result.output || "{}") as ServeConfig;
    } catch {
      throw new TailscaleError("Wisp could not read the Tailscale Serve settings.");
    }
    const handler = config.Web?.[`${new URL(origin).hostname}:443`]?.Handlers?.["/"];
    if (handler) return handler.Proxy ?? "something other than a server";
    // Port 443 taken by a raw TCP forward is something else too.
    const tcp = config.TCP?.["443"];
    return tcp && !tcp.HTTPS ? "a TCP forward" : undefined;
  }
}

const CONSENT_URL = /https:\/\/login\.tailscale\.com\/f\/serve\S*/;

const targetOf = (port: number): string => `http://127.0.0.1:${port}`;

function describeFailure(output: string): string {
  const consent = CONSENT_URL.exec(output)?.[0];
  if (consent) return `Turn on Tailscale Serve for your tailnet at ${consent}, then try again.`;
  if (/access denied|permission denied|operator/i.test(output)) {
    return "Tailscale did not let Wisp change its settings. Run sudo tailscale set --operator=$USER once, then try again.";
  }
  if (/https|certificate/i.test(output)) {
    return `Turn on HTTPS certificates for your tailnet at ${ADMIN_DNS_URL}, then try again.`;
  }
  const last = output.trim().split("\n").pop()?.trim();
  return last ? `Tailscale could not set up Serve: ${last}` : "Tailscale could not set up Serve.";
}

/**
 * Finds the CLI where each platform installs it: apps started from a desktop
 * do not get a shell's PATH, so the usual places are checked too.
 */
export function locateTailscale(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
): string | undefined {
  const name = platform === "win32" ? "tailscale.exe" : "tailscale";
  const known =
    platform === "darwin"
      ? [
          "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
          "/opt/homebrew/bin/tailscale",
          "/usr/local/bin/tailscale",
        ]
      : platform === "win32"
        ? [path.win32.join(env.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe")]
        : ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale", "/snap/bin/tailscale"];
  const delimiter = platform === "win32" ? ";" : ":";
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const onPath = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, name));
  return [...onPath, ...known].find((file) => exists(file));
}

export const runTailscale: TailscaleRunner = (executable, args, { timeoutMs, until }) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const finish = (code: number | null): void => {
      clearTimeout(timer);
      resolve({ code, output });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-64 * 1024);
      // Serving waits for the person to consent in a browser; Wisp shows the link instead.
      if (until?.test(output)) {
        child.kill();
        finish(null);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => finish(code));
  });
