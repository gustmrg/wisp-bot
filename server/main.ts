import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import { FileLogSink } from "../backend/file-log-sink.js";
import { CompositeLogSink, StructuredLogger } from "../backend/structured-logger.js";
import { readAppVersion } from "./app-version.js";
import { parseServerConfig } from "./config.js";
import { MasterKeyEncryption } from "./master-key.js";
import { createWispServer } from "./wisp-server.js";

/** What the desktop app hands a server it starts, as one JSON line on stdin. */
export interface ServerBootstrap {
  /** Base64 of the 32-byte credential key, kept by the app in the system keychain. */
  masterKey?: string;
  localPairingCode: string;
}

/** Reads the bootstrap line; `onClose` runs when the app closes stdin, i.e. when it quits or dies. */
function readBootstrap(onClose: () => void): Promise<ServerBootstrap> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
    let received = false;
    lines.once("line", (line) => {
      received = true;
      try {
        const value = JSON.parse(line) as Partial<ServerBootstrap>;
        if (
          typeof value.localPairingCode !== "string" ||
          (value.masterKey !== undefined && typeof value.masterKey !== "string")
        ) {
          throw new Error("invalid");
        }
        resolve(value as ServerBootstrap);
      } catch {
        reject(new Error("The bootstrap line from the desktop app is invalid."));
      }
    });
    lines.once("close", () => {
      if (!received) reject(new Error("The desktop app closed before sending the bootstrap line."));
      else onClose();
    });
  });
}

/** An explicit web root, or the `web/` folder next to an installed server package when it exists. */
function webRootOption(configured: string | undefined): { webRoot?: string } {
  if (configured) return { webRoot: configured };
  const bundled = path.join(__dirname, "..", "web");
  return existsSync(path.join(bundled, "index.html")) ? { webRoot: bundled } : {};
}

async function main(): Promise<void> {
  const config = parseServerConfig(process.argv.slice(2));
  const logger = new StructuredLogger(
    new CompositeLogSink([console, new FileLogSink(path.join(config.dataDirectory, "backend", "logs"))]),
  );
  let stop: (reason: string) => void = () => process.exit(0);
  const bootstrap = config.bootstrapStdin ? await readBootstrap(() => stop("parent_closed")) : undefined;
  const encryption = bootstrap
    ? new MasterKeyEncryption(bootstrap.masterKey ? Buffer.from(bootstrap.masterKey, "base64") : undefined)
    : MasterKeyEncryption.fromFile(config.keyFile);
  if (!encryption.isAvailable()) {
    logger.warn("master_key_missing", { detail: "Provider credentials cannot be saved without --key-file." });
  }
  const server = await createWispServer({
    dataDirectory: config.dataDirectory,
    host: config.host,
    port: config.port,
    allowExternalBind: config.allowExternalBind,
    ...(config.publicOrigin ? { publicOrigin: config.publicOrigin } : {}),
    // The desktop app's own server needs no browser app.
    ...(bootstrap ? {} : webRootOption(config.webRoot)),
    encryption,
    logger,
    agentMode: config.agentMode,
    appVersion: readAppVersion(),
    ...(bootstrap
      ? { localPairingCode: bootstrap.localPairingCode, adminSocket: false, requirePrivateDirectory: false }
      : {}),
  });
  logger.info("server_started", { host: config.host, port: server.port, serverId: server.serverId });
  let stopping = false;
  stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info("server_stopping", { signal });
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`Wisp server could not start: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exit(1);
  });
}
