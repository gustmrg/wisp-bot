import { randomBytes } from "node:crypto";

import { StructuredLogger } from "../../backend/structured-logger.js";
import type { LocalServer, RunningLocalServer } from "../../electron/local-server/local-server.js";
import { MasterKeyEncryption } from "../../server/master-key.js";
import { createWispServer, type WispServer } from "../../server/wisp-server.js";

const silent = new StructuredLogger({ info: () => undefined, warn: () => undefined });

/** The app's local server, run in the test process instead of a child process. */
export class InProcessLocalServer implements LocalServer {
  starts = 0;
  server: WispServer | undefined;
  private running: { info: RunningLocalServer; exit: () => void } | undefined;
  private starting: Promise<RunningLocalServer> | undefined;

  constructor(
    private readonly dataDirectory: string,
    readonly key: Buffer = randomBytes(32),
  ) {}

  ensureRunning(): Promise<RunningLocalServer> {
    if (this.running) return Promise.resolve(this.running.info);
    this.starting ??= (async () => {
      this.starts++;
      const localPairingCode = randomBytes(16).toString("hex").toUpperCase();
      const server = await createWispServer({
        dataDirectory: this.dataDirectory,
        host: "127.0.0.1",
        port: 0,
        encryption: new MasterKeyEncryption(this.key),
        logger: silent,
        agentMode: "fake",
        appVersion: "0.0.0-test",
        allowModelNetwork: false,
        localPairingCode,
        adminSocket: false,
        requirePrivateDirectory: false,
      });
      let exit!: () => void;
      const exited = new Promise<void>((resolve) => {
        exit = resolve;
      });
      this.server = server;
      this.running = { info: { baseUrl: server.url, localPairingCode, exited }, exit };
      return this.running.info;
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** Stops the server, as when the app quits or switches away. */
  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const running = this.running;
    this.running = undefined;
    if (!running) return;
    await this.server?.close();
    this.server = undefined;
    running.exit();
  }
}
