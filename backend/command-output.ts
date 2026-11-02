import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, rm, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { formatBytes } from "../shared/workspace.js";
import { resolveWorkspacePath } from "./workspace-path.js";

/** Folder in a Wisp's home folder that holds the full output of commands whose result was cut. */
export const COMMAND_OUTPUT_DIRECTORY = "command-output";
/** The most kept of one command's output: its first and last half, around a note of what was left out. */
export const MAX_KEPT_OUTPUT_BYTES = 1024 * 1024;
/** How many full outputs a home folder keeps; each new one deletes the oldest past this. */
export const KEPT_OUTPUTS = 5;

const KEPT_OUTPUT_NAME = /^\d{8}T\d{6}Z-[0-9a-f]{8}\.log$/;
/** The files Pi's shell tool writes in the server's temporary folder. */
const TEMPORARY_OUTPUT_NAME = /^pi-bash-[0-9a-f]+\.log$/;

/** A full output moved into the workspace. */
export interface KeptOutput {
  /** Its path in the container, which the file tools also take. */
  path: string;
  bytes: number;
  keptBytes: number;
}

/** A temporary file Pi named, and what became of it. */
export interface MovedOutput {
  temporaryFile: string;
  /** Null when it could not be kept. */
  kept: KeptOutput | null;
}

/** The file where Pi's shell tool saved the full output, from a result's or a progress update's details. */
export function temporaryOutputFile(details: unknown): string | undefined {
  const file = (details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
  return typeof file === "string" ? file : undefined;
}

/** Details without the server path of Pi's temporary file. */
export function withoutTemporaryOutputFile<TDetails>(details: TDetails): TDetails {
  if (!details || typeof details !== "object" || !("fullOutputPath" in details)) return details;
  const { fullOutputPath: _fullOutputPath, ...rest } = details as Record<string, unknown>;
  return rest as TDetails;
}

/**
 * Moves the full output of a command whose result was cut from Pi's
 * temporary file on the server, which a Wisp cannot read, into its home
 * folder in the workspace, which its file tools and commands both reach.
 * Output past `MAX_KEPT_OUTPUT_BYTES` keeps its beginning and its end.
 * The temporary file is deleted whether or not the output could be kept.
 */
export async function keepFullOutput(
  temporaryFile: string,
  workspaceDirectory: string,
  homeDirectory: string,
  now = new Date(),
): Promise<MovedOutput> {
  // Only a file Pi wrote is read and deleted, whatever the details say.
  if (path.dirname(temporaryFile) !== os.tmpdir() || !TEMPORARY_OUTPUT_NAME.test(path.basename(temporaryFile))) {
    return { temporaryFile, kept: null };
  }
  try {
    const folder = path.posix.join(homeDirectory, COMMAND_OUTPUT_DIRECTORY);
    const directory = await prepareFolder(workspaceDirectory, folder);
    const name = `${timestamp(now)}-${randomBytes(4).toString("hex")}.log`;
    const source = await open(temporaryFile, "r");
    let bytes: number;
    let contents: Buffer;
    try {
      bytes = (await source.stat()).size;
      contents = bytes <= MAX_KEPT_OUTPUT_BYTES ? await readRange(source, 0, bytes) : await readEnds(source, bytes);
    } finally {
      await source.close();
    }
    // `wx` never follows a link the container left at the name.
    const target = await open(path.join(directory, name), "wx", 0o600);
    try {
      await target.writeFile(contents);
    } finally {
      await target.close();
    }
    await pruneKeptOutputs(directory);
    return {
      temporaryFile,
      kept: { path: path.posix.join(folder, name), bytes, keptBytes: Math.min(bytes, MAX_KEPT_OUTPUT_BYTES) },
    };
  } catch {
    return { temporaryFile, kept: null };
  } finally {
    await rm(temporaryFile, { force: true });
  }
}

/** Replaces Pi's pointer to its temporary file with one to the kept output, or with a note that there is none. */
export function pointToKeptOutput(text: string, { temporaryFile, kept }: MovedOutput): string {
  return text.replaceAll(`Full output: ${temporaryFile}`, describeKeptOutput(kept));
}

/** A shell tool result that names the kept output instead of Pi's temporary file. */
export function withKeptOutput<
  TResult extends { content: Array<{ type: string; text?: string }>; details?: unknown; structuredContent?: unknown },
>(result: TResult, moved: MovedOutput): TResult {
  const { kept } = moved;
  const details = withoutTemporaryOutputFile(result.details);
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  return {
    ...result,
    content: result.content.map((part) =>
      part.type === "text" && part.text !== undefined ? { ...part, text: pointToKeptOutput(part.text, moved) } : part,
    ),
    details: details && kept ? { ...(details as object), fullOutputPath: kept.path } : details,
    ...(structured && typeof structured === "object" && "full_output_path" in structured
      ? {
          structuredContent: { ...withoutFullOutputPath(structured), ...(kept ? { full_output_path: kept.path } : {}) },
        }
      : {}),
  } as TResult;
}

function withoutFullOutputPath(structured: Record<string, unknown>): Record<string, unknown> {
  const { full_output_path: _fullOutputPath, ...rest } = structured;
  return rest;
}

function describeKeptOutput(kept: KeptOutput | null): string {
  if (!kept) return "The full output could not be kept";
  if (kept.keptBytes === kept.bytes) return `Full output: ${kept.path}`;
  return `Full output, its first and last ${formatBytes(kept.keptBytes / 2)} of ${formatBytes(kept.bytes)}: ${kept.path}`;
}

/**
 * The container can replace any folder of the workspace with a link, so the
 * folder is resolved inside the workspace before it is created and again
 * after, as the file tools do before they write.
 */
async function prepareFolder(workspaceDirectory: string, folder: string): Promise<string> {
  const planned = await resolveWorkspacePath(workspaceDirectory, folder, true);
  await mkdir(planned.canonicalPath, { recursive: true, mode: 0o700 });
  return (await resolveWorkspacePath(workspaceDirectory, folder, false)).canonicalPath;
}

/** Deletes all but the newest `KEPT_OUTPUTS`; names start with the time they were kept. */
async function pruneKeptOutputs(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && KEPT_OUTPUT_NAME.test(entry.name))
    .map(({ name }) => name)
    .sort();
  await Promise.all(names.slice(0, -KEPT_OUTPUTS).map((name) => rm(path.join(directory, name), { force: true })));
}

async function readEnds(file: FileHandle, bytes: number): Promise<Buffer> {
  const half = MAX_KEPT_OUTPUT_BYTES / 2;
  const [head, tail] = await Promise.all([readRange(file, 0, half), readRange(file, bytes - half, half)]);
  const note = Buffer.from(`\n\n[${formatBytes(bytes - MAX_KEPT_OUTPUT_BYTES)} left out]\n\n`);
  return Buffer.concat([head, note, tail]);
}

async function readRange(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await file.read(buffer, read, length - read, position + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return buffer.subarray(0, read);
}

/** `20261102T153012Z`: sorts by time and is safe in any file system. */
function timestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}
