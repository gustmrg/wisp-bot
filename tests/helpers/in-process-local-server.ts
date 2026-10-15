import { randomBytes } from "node:crypto";

import { StructuredLogger } from "../../backend/structured-logger.js";
import type { LocalServer, LocalServerExposure, RunningLocalServer } from "../../electron/local-server/local-server.js";
import type { AdminCommand } from "../../server/admin.js";
import { MasterKeyEncryption } from "../../server/master-key.js";
import { createWispServer, type WispServer } from "../../server/wisp-server.js";

const silent = new StructuredLogger({ info: () => undefined, warn: () => undefined });

/** The app's local server, run in the test process instead of a child process. */
export class InProcessLocalServer implements LocalServer {
  starts = 0;
  server: WispServer | undefined;
  private running: { info: RunningLocalServer; exit: () => void } | undefined;
  private starting: Promise<RunningLocalServer> | undefined;
  private exposure: LocalServerExposure | undefined;

  constructor(
    private readonly dataDirectory: string,
    readonly key: Buffer = randomBytes(32),
  ) {}

  /** The port remote access is exposed on, as a proxy such as Tailscale Serve would forward to. */
  get exposedPort(): number | undefined {
    return this.exposure?.port;
  }

  async setExposure(exposure: LocalServerExposure | undefined): Promise<void> {
    this.exposure = exposure;
    if (this.server) await this.server.admin(this.exposeCommand());
  }

  private exposeCommand(): AdminCommand {
    const { exposure } = this;
    return exposure ? { command: "expose", ...exposure } : { command: "expose" };
  }

  async admin(command: AdminCommand): Promise<unknown> {
    if (!this.server) throw new Error("Wisps on this computer are not running.");
    return this.server.admin(command);
  }

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
      if (this.exposure) await server.admin(this.exposeCommand()).catch(() => undefined);
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
