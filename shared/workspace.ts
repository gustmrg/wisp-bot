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
export function messageWithAttachments(text: string, attachments: ReadonlyArray<WorkspaceAttachment>): string {
  if (!attachments.length) return text;
  const list = attachments.map((file) => `- \`${file.path}\``).join("\n");
  return `${text ? `${text}\n\n` : ""}Attached to the workspace:\n${list}`;
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
