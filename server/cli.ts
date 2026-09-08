#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { adminRequest } from "./admin.js";
import { createLocalMigration, readTransferKey, restoreBackup } from "./transfer/archive.js";

function parse(args: string[]): { command: string; flags: Map<string, string | boolean> } {
  const command = args[0] ?? "help";
  const flags = new Map<string, string | boolean>();
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--") || flags.has(arg)) throw new Error("Use unique named options.");
    if (["--json", "--dry-run"].includes(arg)) {
      flags.set(arg, true);
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
    flags.set(arg, value);
  }
  return { command, flags };
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { command, flags } = parse(args);
  const value = (name: string, required = true): string | undefined => {
    const v = flags.get(name);
    if (typeof v === "string") return v;
    if (required) throw new Error(`Specify ${name}.`);
    return undefined;
  };
  const directory = path.resolve(
    value("--data-dir", false) ??
      process.env.WISP_DATA_DIR ??
      path.join(process.env.HOME ?? process.cwd(), ".local/share/wisp"),
  );
  const allowed = new Set([
    "--json",
    "--dry-run",
    "--data-dir",
    "--key-file",
    "--input",
    "--output",
    "--source",
    "--target",
    "--device-id",
    "--time-zone",
  ]);
  for (const name of flags.keys()) if (!allowed.has(name)) throw new Error(`Unknown option ${name}.`);
  let result: unknown;
  if (command === "help") {
    process.stdout.write(
      "wispctl pair|status|devices|revoke|rotate-key|keygen|export-local|export|import|backup|restore [options]\n\nAll server commands use the owner-only administrative socket. Set WISP_DATA_DIR or --data-dir.\nPair: pair --json\nKey: keygen --output /private/archive.key\nExport local: export-local --source DIR --output FILE --key-file KEY [--time-zone IANA_ZONE] [--dry-run]\nExport/backup: export|backup --output FILE --key-file KEY [--dry-run]\nImport: import --input FILE --key-file KEY [--dry-run]\nRestore offline: restore --input FILE --target NEW_DIR --key-file KEY [--dry-run]\nRevoke: revoke --device-id ID\n",
    );
    return;
  }
  if (command === "keygen") {
    writeFileSync(value("--output")!, randomBytes(32), { flag: "wx", mode: 0o600 });
    result = { created: true };
  } else if (command === "export-local")
    result = createLocalMigration(value("--source")!, value("--output")!, readTransferKey(value("--key-file")!), {
      dryRun: flags.has("--dry-run"),
      timeZone: value("--time-zone", false),
    });
  else if (command === "restore")
    result = restoreBackup(value("--input")!, value("--target")!, readTransferKey(value("--key-file")!), {
      dryRun: flags.has("--dry-run"),
    });
  else if (["pair", "status", "devices", "rotate-key"].includes(command))
    result = await adminRequest(directory, { command });
  else if (command === "revoke") result = await adminRequest(directory, { command, deviceId: value("--device-id") });
  else if (["import", "export", "backup"].includes(command))
    result = await adminRequest(directory, {
      command,
      ...(command === "import"
        ? { inputFile: path.resolve(value("--input")!) }
        : { outputFile: path.resolve(value("--output")!) }),
      keyFile: path.resolve(value("--key-file")!),
      dryRun: flags.has("--dry-run"),
    });
  else throw new Error("Unknown command. Run wispctl help.");
  process.stdout.write(`${JSON.stringify(result, null, flags.has("--json") ? undefined : 2)}\n`);
}
if (require.main === module)
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "The administrative command failed."}\n`);
    process.exitCode = 1;
  });
