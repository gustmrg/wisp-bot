import os from "node:os";
import path from "node:path";

export interface ServerConfig {
  dataDirectory: string;
  host: string;
  port: number;
  allowExternalBind: boolean;
  publicOrigin?: string;
  keyFile?: string;
  agentMode: "pi" | "fake";
}

const FLAGS: Record<string, keyof ServerConfig> = {
  "--data-dir": "dataDirectory",
  "--host": "host",
  "--port": "port",
  "--public-origin": "publicOrigin",
  "--key-file": "keyFile",
  "--agent-mode": "agentMode",
};

export function defaultDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.WISP_DATA_DIR?.trim() || path.join(os.homedir(), ".local/share/wisp"));
}

/** Reads command-line flags, falling back to `WISP_*` environment variables. */
export function parseServerConfig(args: readonly string[], env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const values = new Map<keyof ServerConfig, string>();
  let allowExternalBind = env.WISP_ALLOW_EXTERNAL_BIND === "1";
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--allow-external-bind") {
      allowExternalBind = true;
      continue;
    }
    const key = FLAGS[flag];
    const value = args[index + 1];
    if (!key || value === undefined || value.startsWith("--")) throw new Error(`Unknown or incomplete option ${flag}.`);
    values.set(key, value);
    index++;
  }
  const pick = (key: keyof ServerConfig, variable: string): string | undefined =>
    values.get(key) ?? (env[variable]?.trim() || undefined);
  const port = Number(pick("port", "WISP_PORT") ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("The port must be between 0 and 65535.");
  const agentMode = pick("agentMode", "WISP_AGENT_MODE") ?? "pi";
  if (agentMode !== "pi" && agentMode !== "fake") throw new Error("The agent mode must be pi or fake.");
  const keyFile = pick("keyFile", "WISP_MASTER_KEY_FILE");
  const publicOrigin = pick("publicOrigin", "WISP_PUBLIC_ORIGIN");
  return {
    dataDirectory: values.has("dataDirectory") ? path.resolve(values.get("dataDirectory")!) : defaultDataDirectory(env),
    host: pick("host", "WISP_HOST") ?? "127.0.0.1",
    port,
    allowExternalBind,
    ...(publicOrigin ? { publicOrigin } : {}),
    ...(keyFile ? { keyFile: path.resolve(keyFile) } : {}),
    agentMode,
  };
}
