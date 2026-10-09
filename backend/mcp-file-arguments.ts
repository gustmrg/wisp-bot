import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { WispBackendError } from "./backend-error.js";
import { resolveWorkspacePath } from "./workspace-path.js";

/**
 * Marks a tool argument as a workspace file the host sends in the model's
 * place, so the file's bytes never pass through the model's tokens.
 */
export const WISP_FILE_PREFIX = "wisp-file:";
/** Most bytes the files in one tool call may hold, before encoding. */
export const MAX_FILE_ARGUMENT_BYTES = 10 * 1024 * 1024;
/** Most files one tool call may send. */
export const MAX_FILE_ARGUMENTS_PER_CALL = 5;
/** Nesting walked when looking for file fields; deeper fields are not offered. */
const MAX_SCHEMA_DEPTH = 6;
/** Constraints that describe the encoded content, which a file reference cannot meet. */
const CONTENT_CONSTRAINTS = ["pattern", "format", "minLength", "maxLength"];

type FileEncoding = "base64" | "data_url";

/** Where file fields sit in a tool's input schema. */
interface FileFieldTree {
  encoding?: FileEncoding;
  properties?: Record<string, FileFieldTree>;
  items?: FileFieldTree;
}

/** One file reference found in a call's arguments, checked but not yet read. */
export interface PlannedFileArgument {
  holder: Record<string, unknown> | unknown[];
  key: string | number;
  requestedPath: string;
  relativePath: string;
  canonicalPath: string;
  size: number;
  mediaType: string;
  encoding: FileEncoding;
}

const MEDIA_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * The schema the model sees: file fields explain the reference and drop
 * constraints on the encoded content, so Pi's validation accepts a reference.
 */
export function withFileReferenceHints(schema: Record<string, unknown>): Record<string, unknown> {
  const tree = fileFieldTree(schema, undefined, 0);
  if (!tree) return schema;
  return hintedNode(structuredClone(schema), tree) as Record<string, unknown>;
}

/**
 * Finds every file reference in the arguments and checks it against the
 * workspace without reading the files, so the approval can name them.
 */
export async function planFileArguments(
  schema: unknown,
  args: Record<string, unknown>,
  workspaceDirectory: string | undefined,
): Promise<PlannedFileArgument[]> {
  const found: Array<Omit<PlannedFileArgument, "relativePath" | "canonicalPath" | "size" | "mediaType">> = [];
  collectReferences(args, fileFieldTree(schema, undefined, 0), found);
  if (!found.length) return [];
  if (!workspaceDirectory) {
    throw new WispBackendError("invalid_request", "Workspace files cannot be sent from this conversation.");
  }
  if (found.length > MAX_FILE_ARGUMENTS_PER_CALL) {
    throw new WispBackendError(
      "invalid_request",
      `Send at most ${MAX_FILE_ARGUMENTS_PER_CALL} files in one tool call.`,
    );
  }
  const planned: PlannedFileArgument[] = [];
  let total = 0;
  for (const reference of found) {
    const resolved = await resolveWorkspacePath(workspaceDirectory, reference.requestedPath, false);
    const info = await stat(resolved.canonicalPath);
    if (!info.isFile()) {
      throw new WispBackendError("invalid_request", `"${resolved.relativePath}" is not a file.`);
    }
    total += info.size;
    if (total > MAX_FILE_ARGUMENT_BYTES) {
      throw new WispBackendError(
        "invalid_request",
        `The files in one tool call can hold at most ${formatBytes(MAX_FILE_ARGUMENT_BYTES)}.`,
      );
    }
    planned.push({
      ...reference,
      relativePath: resolved.relativePath,
      canonicalPath: resolved.canonicalPath,
      size: info.size,
      mediaType: MEDIA_TYPES[path.extname(resolved.relativePath).toLowerCase()] ?? "application/octet-stream",
    });
  }
  return planned;
}

/**
 * Replaces each planned reference with the file's encoded contents. Runs after
 * approval and refuses a file that moved or changed size since it was shown.
 */
export async function expandFileArguments(
  planned: ReadonlyArray<PlannedFileArgument>,
  workspaceDirectory: string,
): Promise<void> {
  for (const file of planned) {
    const resolved = await resolveWorkspacePath(workspaceDirectory, file.requestedPath, false);
    const content = resolved.canonicalPath === file.canonicalPath ? await readFile(resolved.canonicalPath) : undefined;
    if (!content || content.byteLength !== file.size) {
      throw new WispBackendError("tool_blocked", `"${file.relativePath}" changed before the tool could run.`);
    }
    const encoded = content.toString("base64");
    const value = file.encoding === "data_url" ? `data:${file.mediaType};base64,${encoded}` : encoded;
    (file.holder as Record<string | number, unknown>)[file.key] = value;
  }
}

/** How the approval card names the files a call sends. */
export function describeFileArguments(planned: ReadonlyArray<PlannedFileArgument>): string {
  const files = planned.map(({ relativePath, size }) => `${relativePath} (${formatBytes(size)})`);
  return `sends ${files.length === 1 ? "file" : "files"} ${files.join(", ")}`;
}

/** Whether a value is a file reference, used to show it as one in summaries. */
export function isFileReference(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(WISP_FILE_PREFIX);
}

function fileFieldTree(node: unknown, key: string | undefined, depth: number): FileFieldTree | undefined {
  if (!node || typeof node !== "object" || Array.isArray(node) || depth > MAX_SCHEMA_DEPTH) return undefined;
  const schema = node as Record<string, unknown>;
  const encoding = key === undefined ? undefined : fileEncoding(key, schema);
  if (encoding) return { encoding };
  const tree: FileFieldTree = {};
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    for (const [name, child] of Object.entries(schema.properties)) {
      const childTree = fileFieldTree(child, name, depth + 1);
      if (childTree) (tree.properties ??= {})[name] = childTree;
    }
  }
  // Array items take their meaning from the array's own name and description.
  const items = fileFieldTree(schema.items, key === undefined ? undefined : `${key} ${describe(schema)}`, depth + 1);
  if (items) tree.items = items;
  return tree.properties || tree.items ? tree : undefined;
}

/**
 * A string field carries file content when its schema says it is base64 or a
 * data URL, by annotation or in its name or description.
 */
function fileEncoding(key: string, schema: Record<string, unknown>): FileEncoding | undefined {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.includes("string")) return undefined;
  if (schema.contentEncoding === "base64") return "base64";
  if (schema.format === "data-url" || schema.format === "data-uri") return "data_url";
  const text = `${key} ${describe(schema)}`;
  if (/base64/i.test(text)) return "base64";
  if (/data[\s_-]?ur[il]/i.test(text)) return "data_url";
  return undefined;
}

function describe(schema: Record<string, unknown>): string {
  return typeof schema.description === "string" ? schema.description : "";
}

function hintedNode(node: unknown, tree: FileFieldTree): unknown {
  const schema = node as Record<string, unknown>;
  if (tree.encoding) {
    for (const constraint of CONTENT_CONSTRAINTS) delete schema[constraint];
    const hint =
      `To send a file from your workspace, pass "${WISP_FILE_PREFIX}<path>" (for example "${WISP_FILE_PREFIX}inbox/bill.pdf"); ` +
      `Wisp sends the file's contents ${tree.encoding === "data_url" ? "as a data URL" : "base64-encoded"}. Never encode files yourself.`;
    schema.description = describe(schema) ? `${describe(schema)} ${hint}` : hint;
    return schema;
  }
  for (const [name, childTree] of Object.entries(tree.properties ?? {})) {
    const properties = schema.properties as Record<string, unknown>;
    properties[name] = hintedNode(properties[name], childTree);
  }
  if (tree.items) schema.items = hintedNode(schema.items, tree.items);
  return schema;
}

function collectReferences(
  value: unknown,
  tree: FileFieldTree | undefined,
  found: Array<Omit<PlannedFileArgument, "relativePath" | "canonicalPath" | "size" | "mediaType">>,
): void {
  const visit = (
    holder: Record<string, unknown> | unknown[],
    key: string | number,
    child: FileFieldTree | undefined,
  ) => {
    const entry = (holder as Record<string | number, unknown>)[key];
    if (isFileReference(entry)) {
      // A reference outside a file field would reach the server as a literal string.
      if (!child?.encoding) {
        throw new WispBackendError(
          "invalid_request",
          `"${String(key)}" does not take file content, so it cannot receive a workspace file.`,
        );
      }
      const requestedPath = entry.slice(WISP_FILE_PREFIX.length).trim();
      if (!requestedPath) throw new WispBackendError("invalid_request", "The workspace file path is empty.");
      found.push({ holder, key, requestedPath, encoding: child.encoding });
      return;
    }
    collectReferences(entry, child?.encoding ? undefined : child, found);
  };
  if (Array.isArray(value)) {
    value.forEach((_, index) => visit(value, index, tree?.items));
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) visit(value as Record<string, unknown>, key, tree?.properties?.[key]);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
