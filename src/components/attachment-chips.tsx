import { FileIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { WorkspaceAttachment } from "../../shared/workspace";

/** Read-only chips for the files attached to a message, named as in the composer. */
export function AttachmentChips({
  attachments,
  className,
  chipClassName,
}: {
  attachments: ReadonlyArray<Pick<WorkspaceAttachment, "name" | "path">>;
  className?: string;
  chipClassName?: string;
}) {
  if (!attachments.length) return null;
  return (
    <ul className={cn("m-0 flex list-none flex-wrap gap-1.5 p-0", className)} aria-label="Attached files">
      {attachments.map((file) => (
        <li
          key={file.path}
          className={cn(
            "flex max-w-[240px] items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs [&_svg]:size-3",
            chipClassName ?? "border-border bg-background",
          )}
        >
          <FileIcon aria-hidden="true" className="flex-none" />
          <span className="truncate" title={file.path}>
            {file.name}
          </span>
        </li>
      ))}
    </ul>
  );
}
