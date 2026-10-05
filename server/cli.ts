#!/usr/bin/env node
import path from "node:path";

import { adminRequest } from "./admin.js";
import { defaultDataDirectory } from "./config.js";
import { MasterKeyEncryption } from "./master-key.js";

const HELP = `Usage: wispctl <command> [options]

Commands:
  keygen --output FILE     Write a new private master key (never overwrites)
  pair                     Print a one-time pairing code for a new device
  devices                  List paired devices
  revoke --device-id ID    Remove a device and end its sessions
  status                   Show the running server's identity

Options:
  --data-dir DIR           Server data directory (default: $WISP_DATA_DIR or ~/.local/share/wisp)
  --json                   Print compact JSON
`;

export async function runCli(args: readonly string[], write: (text: string) => void): Promise<void> {
  const [command = "help", ...rest] = args;
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!;
    if (!["--output", "--device-id", "--data-dir", "--json"].includes(flag)) throw new Error(`Unknown option ${flag}.`);
    if (flag === "--json") {
      flags.set(flag, true);
      continue;
    }
    const value = rest[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    flags.set(flag, value);
  }
  const option = (name: string): string => {
    const value = flags.get(name);
    if (typeof value !== "string") throw new Error(`Specify ${name}.`);
    return value;
  };
  const dataDirectory = flags.has("--data-dir") ? path.resolve(option("--data-dir")) : defaultDataDirectory();
  let result: unknown;
  switch (command) {
    case "help":
    case "--help":
      write(HELP);
      return;
    case "keygen":
      MasterKeyEncryption.generate(path.resolve(option("--output")));
      result = { created: path.resolve(option("--output")) };
      break;
    case "pair":
    case "devices":
    case "status":
      result = await adminRequest(dataDirectory, { command });
      break;
    case "revoke":
      result = await adminRequest(dataDirectory, { command, deviceId: option("--device-id") });
      break;
    default:
      throw new Error(`Unknown command ${command}. Run wispctl help.`);
  }
  write(`${JSON.stringify(result, null, flags.has("--json") ? undefined : 2)}\n`);
}

if (require.main === module) {
  runCli(process.argv.slice(2), (text) => process.stdout.write(text)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "The command failed."}\n`);
    process.exitCode = 1;
  });
}
