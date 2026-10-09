/** Most bytes a Wisp's workspace may hold, counting agent-written files and attachments. */
export const WORKSPACE_QUOTA_BYTES = 512 * 1024 * 1024;
/** Most files a single attach request copies into the workspace. */
export const MAX_ATTACHMENTS_PER_REQUEST = 20;
/** Workspace folder, relative to its root, that receives attached files. */
export const WORKSPACE_INBOX_DIRECTORY = "inbox";

export interface WorkspaceView {
  usedBytes: number;
  quotaBytes: number;
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
