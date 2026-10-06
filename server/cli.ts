#!/usr/bin/env node
import "./node-version.js";

import path from "node:path";

import { adminRequest, ServerNotRunningError } from "./admin.js";
import { readAppVersion } from "./app-version.js";
import { createBackup, restoreBackup, verifyBackup } from "./backup.js";
import { defaultDataDirectory } from "./config.js";
import { InstanceLock } from "./instance-lock.js";
import { MasterKeyEncryption, readPrivateKeyFile } from "./master-key.js";
import { describeSetup, runSetup, systemHost } from "./setup.js";

const HELP = `Usage: wispctl <command> [options]

Commands:
  setup                    Install and start a Wisp server for this account: the package,
                           a master key, server.env, wispctl, and a systemd user service.
                           Safe to run again; it keeps the key and settings.
  keygen --output FILE     Write a new private 32-byte key (never overwrites)
  pair                     Print a one-time pairing code for a new device
  devices                  List paired devices
  revoke --device-id ID    Remove a device and end its sessions
  status                   Show the running server's identity
  backup --output FILE --key-file KEY
                           Write an encrypted backup of the data directory. A running
                           server writes it itself; otherwise the directory must be idle.
  restore --input FILE --key-file KEY --target DIR
                           Restore a backup into a new, empty directory
  verify --input FILE --key-file KEY
                           Check that a backup is complete and readable with KEY

Options:
  --data-dir DIR           Server data directory (default: $WISP_DATA_DIR or ~/.local/share/wisp)
  --json                   Print compact JSON

Options of setup:
  --port PORT              Port the server listens on (default 8787)
  --public-origin URL      The https address of a private proxy such as Tailscale Serve
  --package SPEC           npm package to install (default: this version)
  --no-service             Only install the files; do not set up the service
  --no-pair                Do not print a pairing code
  --until-stdin-closes     Stop when stdin closes, before starting the service (for the desktop app)
`;

export async function runCli(args: readonly string[], write: (text: string) => void): Promise<void> {
  const [command = "help", ...rest] = args;
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!;
    if (
      ![
        "--output",
        "--device-id",
        "--data-dir",
        "--json",
        "--key-file",
        "--input",
        "--target",
        "--port",
        "--public-origin",
        "--package",
        "--no-service",
        "--no-pair",
        "--until-stdin-closes",
      ].includes(flag)
    ) {
      throw new Error(`Unknown option ${flag}.`);
    }
    if (["--json", "--no-service", "--no-pair", "--until-stdin-closes"].includes(flag)) {
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
    case "setup": {
      // The desktop app runs setup over SSH and cancels it by closing stdin.
      const cancel = new AbortController();
      const stopOnClose = (): void => cancel.abort();
      if (flags.has("--until-stdin-closes")) {
        process.stdin.once("end", stopOnClose).once("close", stopOnClose).resume();
      }
      let outcome: Awaited<ReturnType<typeof runSetup>>;
      try {
        outcome = await runSetup(
          {
            service: !flags.has("--no-service"),
            pair: !flags.has("--no-pair"),
            signal: cancel.signal,
            ...(flags.has("--package") ? { packageSpec: option("--package") } : {}),
            ...(flags.has("--port") ? { port: Number(option("--port")) } : {}),
            ...(flags.has("--public-origin") ? { publicOrigin: option("--public-origin") } : {}),
            ...(flags.has("--data-dir") ? { dataDirectory: dataDirectory } : {}),
          },
          // Progress goes to stderr, so `--json` leaves stdout for the result alone.
          systemHost(readAppVersion(), (message) => process.stderr.write(`${message}\n`)),
        );
      } finally {
        if (flags.has("--until-stdin-closes"))
          process.stdin.off("end", stopOnClose).off("close", stopOnClose).destroy();
      }
      if (!flags.has("--json")) {
        write(describeSetup(outcome));
        return;
      }
      result = outcome;
      break;
    }
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
    case "backup": {
      const output = path.resolve(option("--output"));
      const keyFile = path.resolve(option("--key-file"));
      try {
        result = await adminRequest(dataDirectory, { command, output, keyFile });
      } catch (error) {
        if (!(error instanceof ServerNotRunningError)) throw error;
        result = await backUpIdleDirectory(dataDirectory, output, readPrivateKeyFile(keyFile));
      }
      break;
    }
    case "restore":
      result = await restoreBackup({
        input: path.resolve(option("--input")),
        key: readPrivateKeyFile(path.resolve(option("--key-file"))),
        target: path.resolve(option("--target")),
      });
      break;
    case "verify":
      result = await verifyBackup({
        input: path.resolve(option("--input")),
        key: readPrivateKeyFile(path.resolve(option("--key-file"))),
      });
      break;
    default:
      throw new Error(`Unknown command ${command}. Run wispctl help.`);
  }
  write(`${JSON.stringify(result, null, flags.has("--json") ? undefined : 2)}\n`);
}

/** Backs up a directory no server is using, holding its lock so none starts meanwhile. */
async function backUpIdleDirectory(dataDirectory: string, output: string, key: Buffer): Promise<unknown> {
  let lock: InstanceLock;
  try {
    lock = InstanceLock.acquire(dataDirectory);
  } catch (error) {
    if (error instanceof Error && /already using/.test(error.message)) {
      throw new Error(
        `Wisp is using ${dataDirectory} without an admin socket, as the desktop app does. Quit it, then back up again.`,
      );
    }
    throw error;
  }
  try {
    return await createBackup({ dataDirectory, output, key, appVersion: readAppVersion() });
  } finally {
    lock.release();
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2), (text) => process.stdout.write(text)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "The command failed."}\n`);
    process.exitCode = 1;
  });
}
