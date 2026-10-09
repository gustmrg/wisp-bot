import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import type { SshPromptKind } from "../../shared/connections.js";

const MAX_REQUEST = 4 * 1024;
const MAX_PROMPT = 1024;

/**
 * Runs as OpenSSH's SSH_ASKPASS program: sends the question to the app over
 * a private socket and prints the answer. Exiting with an error declines it.
 * `SSH_ASKPASS_PROMPT=none` only tells the person to touch a security key, so
 * there is nothing to answer.
 */
const HELPER_SOURCE = `"use strict";
const net = require("node:net");
const mode = process.env.SSH_ASKPASS_PROMPT || "";
if (mode === "none") process.exit(0);
const socket = net.connect(process.env.WISP_ASKPASS_SOCKET || "");
let reply = "";
socket.setEncoding("utf8");
socket.on("connect", () => {
  const request = { token: process.env.WISP_ASKPASS_TOKEN || "", prompt: process.argv[2] || "", mode };
  socket.write(JSON.stringify(request) + "\\n");
});
socket.on("data", (chunk) => (reply += chunk));
socket.on("end", () => {
  let answer;
  try {
    answer = JSON.parse(reply).answer;
  } catch {}
  if (typeof answer !== "string") process.exit(1);
  process.stdout.write(answer + "\\n", () => process.exit(0));
});
socket.on("error", () => process.exit(1));
`;

export interface SshQuestion {
  kind: SshPromptKind;
  /** OpenSSH's text for the question. */
  message: string;
}

/** Answers one question; undefined declines it. */
export type SshQuestionHandler = (question: SshQuestion) => Promise<string | undefined>;

/**
 * Lets OpenSSH ask the person questions instead of failing in BatchMode: it
 * runs a helper as SSH_ASKPASS, and the helper reaches this server over a
 * socket only this user can open, with a token for each ssh process. Answers
 * go straight back to OpenSSH; nothing is written down.
 */
export class SshAskpass {
  private readonly handlers = new Map<string, SshQuestionHandler>();

  private constructor(
    private readonly directory: string,
    private readonly socketPath: string,
    private readonly program: string,
    private readonly server: Server,
  ) {
    server.on("connection", (socket) => this.answer(socket));
  }

  /** Starts the server; `execPath` runs the helper as Node.js, as Electron does with ELECTRON_RUN_AS_NODE. */
  static async start(execPath = process.execPath): Promise<SshAskpass> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-askpass-"));
    try {
      await chmod(directory, 0o700);
      const helper = path.join(directory, "askpass.cjs");
      const program = path.join(directory, "askpass");
      await writeFile(helper, HELPER_SOURCE, { mode: 0o600 });
      await writeFile(
        program,
        `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(execPath)} ${shellQuote(helper)} "$@"\n`,
        { mode: 0o700 },
      );
      const socketPath = path.join(directory, "socket");
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return new SshAskpass(directory, socketPath, program, server);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * The environment for one ssh process, whose questions go to `handler`.
   * Call `dispose` once the process has exited.
   */
  register(handler: SshQuestionHandler): { env: NodeJS.ProcessEnv; dispose: () => void } {
    const token = randomBytes(24).toString("hex");
    this.handlers.set(token, handler);
    return {
      env: {
        ...process.env,
        SSH_ASKPASS: this.program,
        SSH_ASKPASS_REQUIRE: "force",
        WISP_ASKPASS_SOCKET: this.socketPath,
        WISP_ASKPASS_TOKEN: token,
      },
      dispose: () => void this.handlers.delete(token),
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(this.directory, { recursive: true, force: true });
  }

  private answer(socket: Socket): void {
    let request = "";
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      request += chunk;
      if (request.length > MAX_REQUEST) {
        socket.destroy();
        return;
      }
      const end = request.indexOf("\n");
      if (end < 0) return;
      socket.removeAllListeners("data");
      void this.reply(request.slice(0, end)).then((answer) =>
        socket.end(JSON.stringify(answer === undefined ? {} : { answer })),
      );
    });
  }

  private async reply(line: string): Promise<string | undefined> {
    let parsed: { token?: unknown; prompt?: unknown; mode?: unknown };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      return undefined;
    }
    const handler = typeof parsed.token === "string" ? this.handlers.get(parsed.token) : undefined;
    if (!handler || typeof parsed.prompt !== "string") return undefined;
    const message = parsed.prompt.slice(0, MAX_PROMPT).trim();
    const kind = questionKind(message, typeof parsed.mode === "string" ? parsed.mode : "");
    try {
      const answer = await handler({ kind, message });
      // A confirmation is answered by the helper exiting successfully.
      return kind === "confirm" && answer !== undefined ? "" : answer;
    } catch {
      return undefined;
    }
  }
}

/** What kind of question an OpenSSH prompt is, from its text. */
export function questionKind(message: string, mode: string): SshPromptKind {
  if (mode === "confirm") return "confirm";
  if (/authenticity of host|continue connecting/i.test(message)) return "host_key";
  if (/passphrase|Enter PIN/i.test(message)) return "passphrase";
  if (/password/i.test(message)) return "password";
  return "secret";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
