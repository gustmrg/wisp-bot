import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SshConfigHost } from "../../shared/connections.js";

// OpenSSH stops following Include at this depth, too.
const MAX_INCLUDE_DEPTH = 16;
const MAX_HOSTS = 200;
const RESOLVE_TIMEOUT_MS = 5_000;
const RESOLVE_CONCURRENCY = 8;
const MAX_OUTPUT = 64 * 1024;

export interface SshConfigOptions {
  /** The home directory whose ~/.ssh/config is read. */
  home?: string;
  /** The OpenSSH client; tests substitute a fake. */
  sshPath?: string;
}

/**
 * The machines declared in the user's ~/.ssh/config, following Include. Each
 * alias is resolved by `ssh -G`, which prints the settings OpenSSH would use
 * without connecting, so the list shows what ssh really does. Patterns with
 * wildcards or negations are left out: they name no single machine.
 */
export async function listSshConfigHosts(options: SshConfigOptions = {}): Promise<SshConfigHost[]> {
  const home = options.home ?? os.homedir();
  const aliases = await readAliases(path.join(home, ".ssh", "config"), home);
  const resolved = new Array<SshConfigHost>(aliases.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < aliases.length) {
      const index = next++;
      const alias = aliases[index]!;
      resolved[index] = { alias, ...(await resolveAlias(alias, options.sshPath ?? "ssh")) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, aliases.length) }, worker));
  return resolved;
}

/** The concrete `Host` names of a config file and the files it includes, in order and without repeats. */
export async function readAliases(file: string, home: string): Promise<string[]> {
  const aliases = new Set<string>();
  const visited = new Set<string>();
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > MAX_INCLUDE_DEPTH || visited.has(current)) return;
    visited.add(current);
    let text: string;
    try {
      text = await readFile(current, "utf8");
    } catch {
      return;
    }
    for (const line of text.split(/\r?\n/)) {
      const [keyword, ...values] = splitDirective(line);
      if (!keyword) continue;
      const name = keyword.toLowerCase();
      if (name === "host") {
        for (const pattern of values) {
          if (aliases.size < MAX_HOSTS && isConcreteHost(pattern)) aliases.add(pattern);
        }
      } else if (name === "include") {
        for (const value of values) {
          for (const included of await expandInclude(value, home)) await visit(included, depth + 1);
        }
      }
    }
  };
  await visit(file, 0);
  return [...aliases];
}

/** A config line's keyword and arguments: `Keyword arg "quoted arg"` or `Keyword=arg`. */
export function splitDirective(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return [];
  const match = /^([A-Za-z]+)\s*(?:=\s*|\s+)(.*)$/.exec(trimmed);
  if (!match) return [];
  const words = [match[1]!];
  for (const [, quoted, plain] of match[2]!.matchAll(/"([^"]*)"|(\S+)/g)) {
    const word = quoted ?? plain!;
    if (word.startsWith("#")) break;
    if (word) words.push(word);
  }
  return words;
}

function isConcreteHost(pattern: string): boolean {
  return pattern.length <= 253 && !/[*?!,]/.test(pattern) && !pattern.startsWith("-");
}

/**
 * The files an `Include` names: `~` is the home, relative paths are in ~/.ssh,
 * and `*` or `?` match file names, as OpenSSH's glob does.
 */
async function expandInclude(value: string, home: string): Promise<string[]> {
  let target = value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
  if (!path.isAbsolute(target)) target = path.join(home, ".ssh", target);
  const parts = path.normalize(target).split(path.sep);
  let candidates = [`${parts[0] ?? ""}${path.sep}`];
  for (const part of parts.slice(1)) {
    if (!part) continue;
    if (!/[*?]/.test(part)) {
      candidates = candidates.map((directory) => path.join(directory, part));
      continue;
    }
    const pattern = new RegExp(
      `^${part
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    );
    const matched: string[] = [];
    for (const directory of candidates) {
      const names = await readdir(directory).catch(() => []);
      for (const name of names.sort()) {
        if (pattern.test(name) && !name.startsWith(".")) matched.push(path.join(directory, name));
      }
    }
    candidates = matched;
  }
  return candidates;
}

/** What `ssh -G` says OpenSSH would use for an alias; nothing when it cannot tell. */
async function resolveAlias(alias: string, ssh: string): Promise<Omit<SshConfigHost, "alias">> {
  const output = await new Promise<string>((resolve) => {
    // `--` keeps an alias from being read as an option.
    const child = spawn(ssh, ["-G", "--", alias], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let text = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (text.length < MAX_OUTPUT) text += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), RESOLVE_TIMEOUT_MS);
    child.once("error", () => resolve(""));
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? text : "");
    });
  });
  const settings = new Map<string, string>();
  for (const line of output.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) settings.set(line.slice(0, space).toLowerCase(), line.slice(space + 1).trim());
  }
  const hostname = settings.get("hostname");
  const user = settings.get("user");
  const port = Number(settings.get("port"));
  return {
    ...(hostname ? { hostname } : {}),
    ...(user ? { user } : {}),
    ...(Number.isInteger(port) && port > 0 && port < 65536 ? { port } : {}),
  };
}
