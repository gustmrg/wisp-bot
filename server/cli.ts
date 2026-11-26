#!/usr/bin/env node
import "./node-version.js";

import os from "node:os";
import path from "node:path";

import { renderUnicodeCompact } from "uqr";

import { pairingLink } from "../shared/pairing-link.js";
import { adminRequest, ServerNotRunningError } from "./admin.js";
import { readAppVersion } from "./app-version.js";
import { createBackup, restoreBackup, verifyBackup } from "./backup.js";
import { defaultDataDirectory } from "./config.js";
import type { DeviceView, PairingCode } from "./device-auth.js";
import { InstanceLock } from "./instance-lock.js";
import { MasterKeyEncryption, readPrivateKeyFile } from "./master-key.js";
import {
  DEFAULT_LOG_LINES,
  describeDoctor,
  describeServerConfig,
  describeServiceAction,
  describeStatus,
  MAX_BACKUP_WAIT_SECONDS,
  MAX_LOG_LINES,
  type OpsHost,
  readServerConfig,
  readServerLogs,
  runDoctor,
  runServiceAction,
  type ServerStatus,
  systemOpsHost,
} from "./ops.js";
import { checkRuntime } from "./runtime-check.js";
import { describeSetup, findServerArchive, runSetup, setupPaths, systemHost } from "./setup.js";
import { isProcessAlive, readUpdateRecord } from "./update-record.js";
import { prepareServerData, readJournal } from "./update-transaction.js";
import { StructuredLogger } from "../backend/structured-logger.js";

export { describeDoctor, describeServerConfig, describeServiceAction, describeStatus };

const HELP = `Usage: wispctl <command> [options]

Commands:
  setup                    Install and start a Wisp server for this account: the package,
                           a master key, server.env, wispctl, and a systemd user service.
                           Safe to run again; it keeps the key and settings.
  keygen --output FILE     Write a new private 32-byte key (never overwrites)
  pair [--no-qr]           Print a one-time pairing code for a new device, with a QR code
                           to scan when the server has a public origin
  devices                  List paired devices
  revoke --device-id ID    Remove a device and end its sessions
  status                   Show the running server's identity and operational telemetry
  doctor                   Run read-only diagnostics on this host and Wisp installation
  logs [--lines N]         Print the latest log lines from backend/logs (default 50, max 1000)
  config                   Show the active server.env settings and resolved paths
  start | stop | restart   Control the wisp systemd user service on Linux
  version [--check]        Show this server's version and Node.js; --check also makes sure
                           this machine can run it (SQLite, PDF rendering)
  update-status [--id ID]  Show how the last setup or update ended; with --id, only if it
                           was that one (state "unknown" otherwise)
  backup --output FILE --key-file KEY [--wait SECONDS]
                           Write an encrypted backup of the data directory. A running
                           server writes it itself; with --wait, wait up to SECONDS
                           (max 600) for working Wisps to finish first.
  restore --input FILE --key-file KEY --target DIR
                           Restore a backup into a new, empty directory
  verify --input FILE --key-file KEY
                           Check that a backup is complete and readable with KEY

Options:
  --data-dir DIR           Server data directory (default: $WISP_DATA_DIR or ~/.local/share/wisp)
  --json                   Print compact JSON. pair, devices, status, doctor, config, and
                           service commands print JSON whenever stdout is not a terminal.
  --lines N                Number of log lines to read with logs (1-1000, default 50)
  --wait SECONDS           Wait up to SECONDS (0-600) for working Wisps to finish before backup

Options of setup:
  --port PORT              Port the server listens on (default 8787)
  --public-origin URL      The https address of a private proxy such as Tailscale Serve
  --web, --no-web          Serve the browser app, to use Wisp in a browser or install it on a
                           phone (default: off on a new server; kept as it was on an update)
  --package SPEC           npm package to install (default: this version)
  --no-service             Only install the files; do not set up the service
  --no-pair                Do not print a pairing code
  --until-stdin-closes     Stop when stdin closes, before starting the service (for the desktop app)
  --update-id ID           Name this run in the update record (for the desktop app)
`;

export interface CliOutput {
  /** Whether stdout is a terminal, where commands print text for people instead of JSON. */
  terminal?: boolean;
  now?: () => Date;
  /** Overrides host operations for doctor, logs, config, and service commands in tests. */
  opsHost?: OpsHost;
}

export async function runCli(
  args: readonly string[],
  write: (text: string) => void,
  output: CliOutput = {},
): Promise<void> {
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
        "--no-qr",
        "--web",
        "--no-web",
        "--check",
        "--update-id",
        "--id",
        "--lines",
        "--wait",
      ].includes(flag)
    ) {
      throw new Error(`Unknown option ${flag}.`);
    }
    if (
      [
        "--json",
        "--no-service",
        "--no-pair",
        "--until-stdin-closes",
        "--no-qr",
        "--web",
        "--no-web",
        "--check",
      ].includes(flag)
    ) {
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
            ...(flags.has("--web") || flags.has("--no-web") ? { web: !flags.has("--no-web") } : {}),
            ...(flags.has("--data-dir") ? { dataDirectory: dataDirectory } : {}),
            ...(flags.has("--update-id") ? { updateId: option("--update-id") } : {}),
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
    case "version":
    case "--version": {
      const archive = findServerArchive();
      const checks = flags.has("--check") ? await checkRuntime() : undefined;
      const info = {
        version: readAppVersion(),
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        install: archive ? "archive" : "npm",
        ...(checks ? { checks } : {}),
      };
      const failed = checks?.find(({ ok }) => !ok);
      if (failed) {
        throw new Error(
          `Wisp server ${info.version} cannot run on this machine (${info.platform} ${info.arch}): the ${failed.name} check failed: ${failed.error}`,
        );
      }
      if (flags.has("--json")) {
        result = info;
        break;
      }
      write(
        `Wisp server ${info.version} (Node.js ${info.node}, ${info.platform} ${info.arch}, ${info.install})${checks ? "\nThis machine can run it." : ""}\n`,
      );
      return;
    }
    case "prepare-data": {
      // Only the setup runs this, inside an update it holds the data directory's lock for.
      const id = process.env.WISP_UPDATE_TRANSACTION;
      const journal = await readJournal(dataDirectory);
      if (!id || journal?.id !== id || journal.step !== "trying") {
        throw new Error("prepare-data runs only inside a server update.");
      }
      // The setup lets go of the lock while this runs; nothing else may open the data meanwhile.
      const lock = InstanceLock.acquire(dataDirectory);
      try {
        await prepareServerData({
          dataDirectory,
          encryption: MasterKeyEncryption.fromFile(path.resolve(option("--key-file"))),
          logger: new StructuredLogger({ info: () => undefined, warn: (event) => process.stderr.write(`${event}\n`) }),
          appVersion: readAppVersion(),
        });
      } finally {
        lock.release();
      }
      result = { prepared: true };
      break;
    }
    case "update-status": {
      const record = await readUpdateRecord(setupPaths(os.homedir()).updateRecord, isProcessAlive);
      const wanted = flags.has("--id") ? option("--id") : undefined;
      result = record && (wanted === undefined || record.id === wanted) ? record : { state: "unknown" };
      break;
    }
    case "keygen":
      MasterKeyEncryption.generate(path.resolve(option("--output")));
      result = { created: path.resolve(option("--output")) };
      break;
    case "pair":
    case "devices": {
      result = await adminRequest(dataDirectory, { command });
      if (!output.terminal || flags.has("--json")) break;
      if (command === "devices") {
        write(describeDevices(result as DeviceView[]));
        return;
      }
      // Only for the address to open.
      const { publicOrigin, web } = (await adminRequest(dataDirectory, { command: "status" })) as {
        publicOrigin?: string;
        web: boolean;
      };
      write(
        describePairing(result as PairingCode, publicOrigin, output.now?.() ?? new Date(), {
          qr: !flags.has("--no-qr"),
          web,
        }),
      );
      return;
    }
    case "status": {
      result = await adminRequest(dataDirectory, { command });
      if (!output.terminal || flags.has("--json")) break;
      write(describeStatus(result as ServerStatus));
      return;
    }
    case "doctor": {
      const host = output.opsHost ?? systemOpsHost();
      const doctor = await runDoctor(
        {
          ...(flags.has("--data-dir") ? { dataDirectory } : {}),
          ...(flags.has("--key-file") ? { keyFile: path.resolve(option("--key-file")) } : {}),
        },
        host,
      );
      if (output.terminal && !flags.has("--json")) {
        write(describeDoctor(doctor));
      } else {
        write(`${JSON.stringify(doctor, null, flags.has("--json") ? undefined : 2)}\n`);
      }
      if (!doctor.ok) {
        const failedCount = doctor.checks.filter((check) => check.status === "fail").length;
        throw new Error(`Doctor found ${failedCount} failing check${failedCount === 1 ? "" : "s"}.`);
      }
      return;
    }
    case "logs": {
      const maxLines = flags.has("--lines") ? Number(option("--lines")) : DEFAULT_LOG_LINES;
      if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > MAX_LOG_LINES) {
        throw new Error(`--lines must be a whole number between 1 and ${MAX_LOG_LINES}.`);
      }
      const host = output.opsHost ?? systemOpsHost();
      const resolvedDir = flags.has("--data-dir") ? dataDirectory : (await readServerConfig({}, host)).dataDirectory;
      const logs = await readServerLogs(resolvedDir, maxLines);
      if (flags.has("--json")) {
        result = logs;
        break;
      }
      write(logs.lines.length === 0 ? `No log entries found in ${logs.directory}.\n` : `${logs.lines.join("\n")}\n`);
      return;
    }
    case "config": {
      const host = output.opsHost ?? systemOpsHost();
      const config = await readServerConfig({ ...(flags.has("--data-dir") ? { dataDirectory } : {}) }, host);
      if (!output.terminal || flags.has("--json")) {
        result = config;
        break;
      }
      write(describeServerConfig(config));
      return;
    }
    case "start":
    case "stop":
    case "restart": {
      const host = output.opsHost ?? systemOpsHost();
      const outcome = await runServiceAction(command, host);
      if (!output.terminal || flags.has("--json")) {
        result = outcome;
        break;
      }
      write(describeServiceAction(outcome));
      return;
    }
    case "revoke":
      result = await adminRequest(dataDirectory, { command, deviceId: option("--device-id") });
      break;
    case "backup": {
      const outputPath = path.resolve(option("--output"));
      const keyFile = path.resolve(option("--key-file"));
      const waitSeconds = flags.has("--wait") ? Number(option("--wait")) : 0;
      if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_BACKUP_WAIT_SECONDS) {
        throw new Error(`--wait must be between 0 and ${MAX_BACKUP_WAIT_SECONDS} seconds.`);
      }
      try {
        result = await adminRequest(dataDirectory, {
          command,
          output: outputPath,
          keyFile,
          ...(waitSeconds > 0 ? { waitSeconds } : {}),
        });
      } catch (error) {
        if (!(error instanceof ServerNotRunningError)) throw error;
        result = await backUpIdleDirectory(dataDirectory, outputPath, readPrivateKeyFile(keyFile));
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

/**
 * A pairing code as a person reads it: the code, how long it lasts, and where
 * to enter it, with a QR code of the pairing link when the server has a public
 * origin and serves the browser app the link opens.
 */
export function describePairing(
  pairing: PairingCode,
  publicOrigin: string | undefined,
  now: Date,
  { qr = true, web = true }: { qr?: boolean; web?: boolean } = {},
): string {
  const expiresAt = new Date(pairing.expiresAt);
  const minutes = Math.max(1, Math.round((expiresAt.getTime() - now.getTime()) / 60_000));
  const until = expiresAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const lines = [
    `Pairing code: ${pairing.code}`,
    `Valid for ${minutes} minute${minutes === 1 ? "" : "s"} (until ${until}).`,
    "",
  ];
  if (!web) {
    lines.push(
      "Enter the code in the Wisp app when it connects to this server.",
      "This server does not serve the browser app; to pair a phone's browser, see `wispctl setup --web`.",
    );
  } else if (publicOrigin) {
    const link = pairingLink(publicOrigin, pairing.code);
    if (qr) {
      // Light modules are drawn as blocks, so the code reads on a dark terminal background.
      lines.push("Scan this with your phone to pair:", "", renderUnicodeCompact(link, { border: 2 }), "");
    }
    lines.push(
      `${qr ? "Or open" : "Open"} ${link} on your phone or browser to pair,`,
      `or open ${publicOrigin} and enter the code.`,
      "",
      `Anyone with this ${qr ? "QR code, link," : "link"} or code can pair: do not share it or leave it on screen.`,
    );
  } else {
    lines.push(
      "Open this server's address on your phone or browser and enter the code to pair.",
      "To reach it from a phone, or pair by scanning a QR code, see `wispctl setup --public-origin`.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Paired devices as a person reads them, with the IDs `wispctl revoke` takes. */
export function describeDevices(devices: readonly DeviceView[]): string {
  if (devices.length === 0) return "No paired devices. Run `wispctl pair` to pair one.\n";
  const when = (iso: string): string =>
    new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const lines = [`${devices.length} paired device${devices.length === 1 ? "" : "s"}:`];
  for (const device of devices) {
    lines.push(
      "",
      `${device.name}${device.local ? " (the desktop app on this computer)" : ""}`,
      `  ID: ${device.id}`,
      `  Paired ${when(device.createdAt)}, last seen ${device.lastSeenAt ? when(device.lastSeenAt) : "never"}`,
    );
  }
  return `${lines.join("\n")}\n`;
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
  runCli(process.argv.slice(2), (text) => process.stdout.write(text), { terminal: process.stdout.isTTY }).catch(
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "The command failed."}\n`);
      process.exitCode = 1;
    },
  );
}
