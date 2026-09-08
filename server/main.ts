#!/usr/bin/env node
import path from "node:path";
import { createWispServer } from "./application.js";

export async function main(): Promise<void> {
  const names: Record<string, string> = {
    "--data-dir": "WISP_DATA_DIR",
    "--host": "WISP_HOST",
    "--port": "WISP_PORT",
    "--public-origin": "WISP_PUBLIC_ORIGIN",
    "--allowed-origins": "WISP_ALLOWED_ORIGINS",
    "--key-file": "WISP_MASTER_KEY_FILE",
    "--previous-key-file": "WISP_PREVIOUS_MASTER_KEY_FILE",
    "--web-root": "WISP_WEB_ROOT",
    "--owner-name": "WISP_OWNER_NAME",
    "--time-zone": "WISP_TIMEZONE",
    "--agent-mode": "WISP_AGENT_MODE",
  };
  const args = process.argv.slice(2);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--help") {
      process.stdout.write(
        "wisp-server [--data-dir DIR] [--host 127.0.0.1] [--port 8787] [--key-file FILE] [--web-root DIR] [--public-origin HTTPS_ORIGIN] [--owner-name NAME] [--time-zone IANA_ZONE] [--agent-mode pi|fake] [--allowed-origins LIST] [--allow-external-bind]\n",
      );
      return;
    }
    if (seen.has(flag)) throw new Error("Options must be unique.");
    seen.add(flag);
    if (flag === "--allow-external-bind") {
      process.env.WISP_ALLOW_EXTERNAL_BIND = "1";
      continue;
    }
    const name = names[flag],
      value = args[++index];
    if (!name || !value || value.startsWith("--")) throw new Error("Unknown or incomplete server option.");
    process.env[name] = value;
  }
  const port = Number(process.env.WISP_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("WISP_PORT must be a valid TCP port.");
  if (process.env.WISP_AGENT_MODE && !["pi", "fake"].includes(process.env.WISP_AGENT_MODE))
    throw new Error("WISP_AGENT_MODE must be pi or fake.");
  const server = await createWispServer({
    dataDirectory: path.resolve(
      process.env.WISP_DATA_DIR ?? path.join(process.env.HOME ?? process.cwd(), ".local/share/wisp"),
    ),
    host: process.env.WISP_HOST ?? "127.0.0.1",
    port,
    publicOrigin: process.env.WISP_PUBLIC_ORIGIN || undefined,
    allowedOrigins: process.env.WISP_ALLOWED_ORIGINS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    allowExternalBind: process.env.WISP_ALLOW_EXTERNAL_BIND === "1",
    ownerName: process.env.WISP_OWNER_NAME,
    timeZone: process.env.WISP_TIMEZONE,
    agentMode: process.env.WISP_AGENT_MODE === "fake" ? "fake" : "pi",
    masterKeyFile:
      process.env.WISP_MASTER_KEY_FILE ||
      (process.env.CREDENTIALS_DIRECTORY ? path.join(process.env.CREDENTIALS_DIRECTORY, "master-key") : undefined),
    previousMasterKeyFile: process.env.WISP_PREVIOUS_MASTER_KEY_FILE || undefined,
    webRoot: process.env.WISP_WEB_ROOT || undefined,
  });
  process.stdout.write(
    `${JSON.stringify({ event: "server_ready", url: server.url, serverId: server.database.serverId, bootId: server.database.bootId })}\n`,
  );
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void server.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.stderr.write("Server shutdown failed.\n");
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
if (require.main === module)
  void main().catch(() => {
    process.stderr.write(
      "Wisp server startup failed. Check directory permissions, configuration, master key, and instance lock.\n",
    );
    process.exitCode = 1;
  });
