import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { StructuredLogger } from "../../backend/structured-logger.js";
import type { SshConnectionProfile, SshPromptKind, SshPromptView } from "../../shared/connections.js";
import type { SshAskpass, SshQuestion } from "./ssh-askpass.js";

const LOOKUP_TIMEOUT_MS = 5_000;
const KEY_LINE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) ([A-Za-z0-9+/]+={0,3})(?: (.*))?$/;
// The key files `ssh` tries when `ssh -G` cannot say.
const DEFAULT_KEYS = ["id_ed25519", "id_ecdsa", "id_rsa"];

/** How Wisp asks the person what OpenSSH needs to know; without it, SSH runs in BatchMode. */
export interface SshInteraction {
  askpass: SshAskpass;
  /** Shows a question; resolves undefined when the person declines it or connecting stops. */
  ask(prompt: Omit<SshPromptView, "id">, signal?: AbortSignal): Promise<string | undefined>;
  /** The public key a password adds to the server; tests substitute fixed ones. */
  publicKeys?: () => Promise<string[]>;
  logger?: Pick<StructuredLogger, "warn">;
}

/**
 * The questions of one ssh process. A password is only ever used to add this
 * computer's public key to the server, after which Wisp connects with it, so
 * a password is not asked for when this computer has no key to add.
 */
export class SshQuestions {
  /** The environment for the ssh process; undefined runs it in BatchMode. */
  readonly env: NodeJS.ProcessEnv | undefined;
  /** The kind of question the person declined, which ended the connection. */
  declined: SshPromptKind | undefined;
  /** Set when the server asked for a password but this computer has no SSH key to authorize with it. */
  noKey = false;
  /** The password the server accepted or rejected, kept only until the keys are added. */
  password: string | undefined;
  keys: string[] = [];
  private readonly dispose: (() => void) | undefined;
  private readonly asked = new Map<SshPromptKind, number>();
  private waiting = 0;
  private answeredAt = 0;

  constructor(
    private readonly interaction: SshInteraction | undefined,
    /** The OpenSSH client, which says which key it would use. */
    private readonly ssh: string,
    private readonly profile: SshConnectionProfile,
    private readonly signal?: AbortSignal,
    /** Answers the first password question with this, without asking; for adding keys after a password worked. */
    private reusePassword?: string,
  ) {
    const registration = interaction?.askpass.register((question) => this.handle(question));
    this.env = registration?.env;
    this.dispose = registration?.dispose;
  }

  get interactive(): boolean {
    return Boolean(this.env);
  }

  /** Whether a question is open, or was answered within `ms`: time spent answering does not count against SSH. */
  busy(ms: number): boolean {
    return this.waiting > 0 || Date.now() - this.answeredAt < ms;
  }

  /** Whether the person typed a password, which the server did not accept if ssh still failed. */
  get passwordTried(): boolean {
    return (this.asked.get("password") ?? 0) > 0 && this.password !== undefined;
  }

  close(): void {
    this.dispose?.();
  }

  private async handle(question: SshQuestion): Promise<string | undefined> {
    const interaction = this.interaction;
    if (!interaction || this.signal?.aborted) return undefined;
    if (question.kind === "password") {
      if (this.reusePassword !== undefined) {
        const password = this.reusePassword;
        // Asked again means it no longer works; the person is not asked here.
        this.reusePassword = undefined;
        return password;
      }
      if (this.asked.get("password") === undefined) {
        const find = interaction.publicKeys ?? (() => findPublicKeys(this.ssh, this.profile));
        this.keys = await find().catch(() => []);
      }
      if (this.keys.length === 0) {
        this.noKey = true;
        return undefined;
      }
    }
    const times = this.asked.get(question.kind) ?? 0;
    this.asked.set(question.kind, times + 1);
    this.waiting++;
    let answer: string | undefined;
    try {
      answer = await interaction.ask(
        {
          kind: question.kind,
          host: this.profile.host,
          message: question.message,
          ...(question.kind === "password" ? { keys: this.keys.map(describeKey) } : {}),
          ...(times > 0 ? { retry: true } : {}),
        },
        this.signal,
      );
    } finally {
      this.waiting--;
      this.answeredAt = Date.now();
    }
    if (answer === undefined) {
      if (!this.signal?.aborted) this.declined = question.kind;
      return undefined;
    }
    if (question.kind === "password") this.password = answer;
    return answer;
  }
}

/**
 * The one public key a password adds to the server: the first key file
 * OpenSSH would use for this host (`ssh -G`, so ~/.ssh/config counts), or
 * else the first key in ssh-agent. Never every key in the agent: it may hold
 * keys meant for other machines, such as deploy keys.
 */
export async function findPublicKeys(ssh: string, profile: SshConnectionProfile): Promise<string[]> {
  for (const file of await identityFiles(ssh, profile)) {
    const key = publicKeyLine((await readFile(`${file}.pub`, "utf8").catch(() => "")).trim());
    if (key) return [key];
  }
  // Exits with 1 when the agent has no keys, and 2 when there is no agent.
  const agent = (await output("ssh-add", ["-L"])).split("\n").flatMap((line) => publicKeyLine(line) ?? []);
  return agent.slice(0, 1);
}

/** The key files OpenSSH would try for this host, in order. */
async function identityFiles(ssh: string, profile: SshConnectionProfile): Promise<string[]> {
  const config = await output(ssh, [
    "-G",
    ...(profile.sshPort ? ["-p", String(profile.sshPort)] : []),
    ...(profile.user ? ["-l", profile.user] : []),
    "--",
    profile.host,
  ]);
  const files = config.split("\n").flatMap((line) => {
    const file = /^identityfile (.+)$/i.exec(line.trim())?.[1];
    // Tokens such as %h would need OpenSSH's own expansion.
    if (!file || file.includes("%")) return [];
    return [file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file];
  });
  return files.length > 0 ? files : DEFAULT_KEYS.map((name) => path.join(os.homedir(), ".ssh", name));
}

/** A public key as one authorized_keys line without options, or undefined when the line is not one. */
export function publicKeyLine(line: string): string | undefined {
  const match = KEY_LINE.exec(line.trim());
  if (!match) return undefined;
  const comment = (match[3] ?? "")
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, 100);
  return `${match[1]} ${match[2]}${comment ? ` ${comment}` : ""}`;
}

/** A key as `ssh-add -l` shows it: its comment and SHA256 fingerprint. */
export function describeKey(line: string): string {
  const [type = "", data = "", ...comment] = line.split(" ");
  const fingerprint = createHash("sha256").update(Buffer.from(data, "base64")).digest("base64").replace(/=+$/, "");
  return `${comment.join(" ") || type} (SHA256:${fingerprint})`;
}

/** What a command prints, or nothing when it fails. */
function output(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let text = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      text += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), LOOKUP_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? text : "");
    });
  });
}
