const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
/** Most bytes a workspace may hold, counting agent-written files and attachments, until its Wisp is given another size. */
export const WORKSPACE_QUOTA_BYTES = 512 * MIB;
/** Below this, packages installed by a Wisp's commands quickly fill its workspace. */
export const COMMAND_WORKSPACE_QUOTA_BYTES = 2 * GIB;
/** The sizes a Wisp's workspace can be given, smallest first; it can also be given none (`null`). */
export const WORKSPACE_QUOTA_PRESETS: ReadonlyArray<number> = [
  64 * MIB,
  128 * MIB,
  256 * MIB,
  WORKSPACE_QUOTA_BYTES,
  GIB,
  COMMAND_WORKSPACE_QUOTA_BYTES,
  10 * GIB,
  50 * GIB,
  100 * GIB,
];
/**
 * Free space a workspace without a size leaves on its disk: new files stop
 * there, so the conversations, sessions and settings beside it can still be saved.
 */
export const WORKSPACE_DISK_RESERVE_BYTES = GIB;
/** At this share of its size, a workspace is shown as nearly full. */
export const WORKSPACE_NEARLY_FULL_PERCENT = 90;
/** Most files a single attach request copies into the workspace. */
export const MAX_ATTACHMENTS_PER_REQUEST = 20;
/** Workspace folder, relative to its root, that receives attached files. */
export const WORKSPACE_INBOX_DIRECTORY = "inbox";

export interface WorkspaceView {
  usedBytes: number;
  /**
   * The workspace's size. With `unlimited`, what it can hold before its disk
   * reaches the reserve, so apps older than that field still show a usable bar.
   */
  quotaBytes: number;
  /** The largest size the workspace can be given now: the disk must have room to grow into it. */
  maxQuotaBytes: number;
  /**
   * The workspace has no size; only its disk's free space holds it back.
   * Absent from servers older than unlimited workspaces, which cannot be given one.
   */
  unlimited?: boolean;
  /** Free space on the disk holding the workspace; absent from older servers. */
  freeDiskBytes?: number;
}

export interface SetWorkspaceQuotaRequest {
  conversationId: string;
  /** One of `WORKSPACE_QUOTA_PRESETS`, or `null` for no size. */
  quotaBytes: number | null;
}

/**
 * What a workspace without a size can hold now: what it holds, plus its disk's
 * free space above the reserve. Checking new files against it is checking the reserve.
 */
export function unlimitedWorkspaceRoom(usedBytes: number, freeDiskBytes: number): number {
  return usedBytes + Math.max(0, freeDiskBytes - WORKSPACE_DISK_RESERVE_BYTES);
}

/** Why new files are refused in a workspace without a size; `before` says what to free space before. */
export function diskReserveMessage(freeDiskBytes: number, before: string): string {
  return `This workspace has no size limit, but its disk is almost full (${formatBytes(freeDiskBytes)} free; Wisp keeps ${formatBytes(WORKSPACE_DISK_RESERVE_BYTES)} free for conversations and settings). Free some space on the disk ${before}.`;
}

/** How a workspace's usage is shown. */
export interface WorkspaceUsage {
  /** Share of its size in use, rounded, above 100 past its size; null for a workspace without a size. */
  share: number | null;
  /** `share` capped at 100, for a usage bar. */
  percent: number | null;
  /** Close enough to its limit that the person should free space. */
  nearlyFull: boolean;
  /** New files are refused: past its size, or its disk down to the reserve. */
  full: boolean;
}

export function workspaceUsage(
  workspace: Pick<WorkspaceView, "usedBytes" | "quotaBytes" | "unlimited" | "freeDiskBytes">,
): WorkspaceUsage {
  if (workspace.unlimited) {
    const full = workspace.freeDiskBytes !== undefined && workspace.freeDiskBytes <= WORKSPACE_DISK_RESERVE_BYTES;
    return { share: null, percent: null, nearlyFull: full, full };
  }
  const share = workspace.quotaBytes > 0 ? Math.round((workspace.usedBytes / workspace.quotaBytes) * 100) : 100;
  return {
    share,
    percent: Math.min(100, share),
    nearlyFull: share >= WORKSPACE_NEARLY_FULL_PERCENT,
    full: workspace.usedBytes >= workspace.quotaBytes,
  };
}

export interface WorkspaceAttachment {
  name: string;
  /** Path relative to the workspace root, with forward slashes. */
  path: string;
  size: number;
}

export interface AttachWorkspaceFilesResult {
  /** Empty when the user dismissed the file picker. */
  files: ReadonlyArray<WorkspaceAttachment>;
  workspace: WorkspaceView;
}

/** Where a device sending chosen files to a server is; a computer copying files itself reports nothing. */
export type AttachWorkspaceFilesProgress =
  | { phase: "checking"; count: number }
  | { phase: "sending"; name: string; index: number; count: number };

export interface AttachWorkspaceFilesOptions {
  /** Stops sending; files already in the workspace stay there. */
  signal?: AbortSignal;
  onProgress?: (progress: AttachWorkspaceFilesProgress) => void;
}

export interface SearchWorkspaceFilesRequest {
  conversationId: string;
  /** What follows the `@` being typed; empty lists the shallowest files. */
  query: string;
}

export interface WorkspaceFileSearch {
  /** The best matching paths, relative to the workspace root with forward slashes. */
  paths: ReadonlyArray<string>;
  /** The workspace has no files at all, as opposed to none matching. */
  empty: boolean;
}

/** The message text sent to a Wisp: what the user typed, followed by where its attachments landed. */
export function messageWithAttachments(
  text: string,
  attachments: ReadonlyArray<Pick<WorkspaceAttachment, "path">>,
): string {
  if (!attachments.length) return text;
  const list = attachments.map((file) => `- \`${file.path}\``).join("\n");
  return `${text ? `${text}\n\n` : ""}Attached to the workspace:\n${list}`;
}

/** A message as people read it: what was typed, or the attached files' names when nothing was. */
export function messagePreview(message: string): string {
  const { text, attachments } = splitMessageAttachments(message);
  return text || attachments.map(({ name }) => name).join(", ");
}

const ATTACHMENT_HEADING = "Attached to the workspace:";
const ATTACHMENT_LINE = /^- `(.+)`$/;

/**
 * Splits a sent message back into what the user typed and the files listed by
 * `messageWithAttachments`, so the list can be shown as files again. A message
 * that does not end with such a list comes back whole, with no files.
 */
export function splitMessageAttachments(message: string): {
  text: string;
  attachments: ReadonlyArray<Pick<WorkspaceAttachment, "name" | "path">>;
} {
  const start = message.endsWith(ATTACHMENT_HEADING) ? -1 : message.lastIndexOf(`${ATTACHMENT_HEADING}\n`);
  if (start < 0 || (start > 0 && !message.slice(0, start).endsWith("\n\n"))) return { text: message, attachments: [] };
  const attachments: Array<Pick<WorkspaceAttachment, "name" | "path">> = [];
  for (const line of message.slice(start + ATTACHMENT_HEADING.length + 1).split("\n")) {
    const path = ATTACHMENT_LINE.exec(line)?.[1];
    if (!path) return { text: message, attachments: [] };
    attachments.push({ name: path.slice(path.lastIndexOf("/") + 1), path });
  }
  return { text: message.slice(0, Math.max(0, start - 2)), attachments };
}

/** Image types the read tool sends to models that accept images. */
const IMAGE_ATTACHMENT_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

/**
 * What a model without image input misses in these attachments: images
 * entirely, and the scanned pages of PDFs (their text layer is still read).
 */
export function attachmentsNeedingVision(attachments: ReadonlyArray<Pick<WorkspaceAttachment, "name">>): {
  images: number;
  pdfs: number;
} {
  let images = 0;
  let pdfs = 0;
  for (const { name } of attachments) {
    const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
    if (IMAGE_ATTACHMENT_EXTENSIONS.has(extension)) images += 1;
    else if (extension === ".pdf") pdfs += 1;
  }
  return { images, pdfs };
}

/** Binary units: the labels match the 1024 base used by the workspace quota. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
