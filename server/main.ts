import { readFileSync } from "node:fs";
import path from "node:path";

import { FileLogSink } from "../backend/file-log-sink.js";
import { CompositeLogSink, StructuredLogger } from "../backend/structured-logger.js";
import { parseServerConfig } from "./config.js";
import { MasterKeyEncryption } from "./master-key.js";
import { createWispServer } from "./wisp-server.js";

/** The version of the package this file was built from, found next to the build output. */
export function readAppVersion(directory = __dirname): string {
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const { version } = JSON.parse(readFileSync(path.join(directory, candidate), "utf8")) as { version?: unknown };
      if (typeof version === "string") return version;
    } catch {
      // Try the next location.
    }
  }
  return "0.0.0";
}

async function main(): Promise<void> {
  const config = parseServerConfig(process.argv.slice(2));
  const logger = new StructuredLogger(
    new CompositeLogSink([console, new FileLogSink(path.join(config.dataDirectory, "backend", "logs"))]),
  );
  const encryption = MasterKeyEncryption.fromFile(config.keyFile);
  if (!encryption.isAvailable()) {
    logger.warn("master_key_missing", { detail: "Provider credentials cannot be saved without --key-file." });
  }
  const server = await createWispServer({
    dataDirectory: config.dataDirectory,
    host: config.host,
    port: config.port,
    allowExternalBind: config.allowExternalBind,
    ...(config.publicOrigin ? { publicOrigin: config.publicOrigin } : {}),
    encryption,
    logger,
    agentMode: config.agentMode,
    appVersion: readAppVersion(),
  });
  logger.info("server_started", { host: config.host, port: server.port, serverId: server.serverId });
  let stopping = false;
  const stop = (signal: string): void => {
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
