import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import type { SshQuestion } from "../../shared/connections.js";

const MAX_REQUEST = 8 * 1024;

/** A question from OpenSSH; resolves with the answer, or undefined to refuse. */
export type AskpassHandler = (prompt: SshQuestion) => Promise<string | undefined>;

/**
 * Lets OpenSSH ask its questions (an unknown host key, a password, a key
 * passphrase) in the app rather than in a terminal. OpenSSH runs the program
 * in SSH_ASKPASS for each question; that program is a small script, private
 * to this user, that passes the question to the app over a Unix socket and
 * prints the answer. Answers are never stored.
 */
export class AskpassBroker {
  private ready: Promise<{ directory: string; script: string; server: Server }> | undefined;

  constructor(
    private readonly handler: AskpassHandler,
    /** The Node.js that runs the helper; Electron's own, as Node. */
    private readonly execPath: string = process.execPath,
  ) {}

  /** The environment that makes an `ssh` ask through this app. */
  async env(): Promise<Record<string, string>> {
    const { script } = await this.start();
    // OpenSSH 8.4 and later use the program even without a display.
    return { SSH_ASKPASS: script, SSH_ASKPASS_REQUIRE: "force" };
  }

  async dispose(): Promise<void> {
    const ready = this.ready;
    this.ready = undefined;
    if (!ready) return;
    const { directory, server } = await ready.catch(() => ({ directory: undefined, server: undefined }));
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  private start(): Promise<{ directory: string; script: string; server: Server }> {
    this.ready ??= (async () => {
      // mkdtemp creates the directory with mode 700: only this user reaches the socket and scripts.
      const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-askpass-"));
      const socketPath = path.join(directory, "s");
      const token = randomBytes(16).toString("hex");
      const server = createServer((socket) => this.serve(socket, token));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => resolve());
      });
      server.unref();
      const helper = path.join(directory, "askpass.cjs");
      await writeFile(helper, helperSource(socketPath, token), { mode: 0o600 });
      const script = path.join(directory, "askpass");
      await writeFile(
        script,
        `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(this.execPath)} ${shellQuote(helper)} "$@"\n`,
        { mode: 0o700 },
      );
      await chmod(script, 0o700);
      return { directory, script, server };
    })();
    return this.ready;
  }

  private serve(socket: Socket, token: string): void {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > MAX_REQUEST) socket.destroy();
      if (!text.includes("\n")) return;
      socket.removeAllListeners("data");
      let request: { token?: unknown; prompt?: unknown; mode?: unknown };
      try {
        request = JSON.parse(text.slice(0, text.indexOf("\n")));
      } catch {
        socket.destroy();
        return;
      }
      if (request.token !== token || typeof request.prompt !== "string") {
        socket.destroy();
        return;
      }
      const mode = typeof request.mode === "string" ? request.mode : "";
      // "none" only informs, such as "touch your security key"; OpenSSH does not wait for it.
      if (mode === "none") {
        socket.end(`${JSON.stringify({ answer: "" })}\n`);
        return;
      }
      void this.handler(describePrompt(request.prompt, mode)).then(
        (answer) => socket.end(`${JSON.stringify(answer === undefined ? {} : { answer })}\n`),
        () => socket.end("{}\n"),
      );
    });
  }
}

/** What kind of question OpenSSH asks, from its text and SSH_ASKPASS_PROMPT. */
export function describePrompt(prompt: string, mode = ""): SshQuestion {
  const message = prompt.trim().slice(0, 2000);
  const host = /authenticity of host '([^']+)'/i.exec(message)?.[1];
  if (host) {
    const fingerprint = /\b(SHA256:[A-Za-z0-9+/=]+)/.exec(message)?.[1];
    const keyType = /\b([A-Z0-9-]+) key fingerprint is/i.exec(message)?.[1];
    return {
      kind: "hostKey",
      host,
      ...(keyType ? { keyType } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      message,
    };
  }
  if (mode === "confirm") return { kind: "confirm", message };
  return { kind: "secret", message };
}

/** The helper OpenSSH runs: one question in, one answer out. Exit status 1 refuses. */
function helperSource(socketPath: string, token: string): string {
  return `"use strict";
const net = require("node:net");
const socket = net.connect(${JSON.stringify(socketPath)});
let text = "";
socket.setEncoding("utf8");
socket.on("connect", () => {
  const prompt = process.argv.slice(2).join(" ");
  socket.write(JSON.stringify({ token: ${JSON.stringify(token)}, prompt, mode: process.env.SSH_ASKPASS_PROMPT || "" }) + "\\n");
});
socket.on("data", (chunk) => (text += chunk));
socket.on("end", () => {
  try {
    const { answer } = JSON.parse(text);
    if (typeof answer === "string") {
      process.stdout.write(answer + "\\n");
      process.exit(0);
    }
  } catch {}
  process.exit(1);
});
socket.on("error", () => process.exit(1));
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
