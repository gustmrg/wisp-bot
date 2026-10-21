import type { ReactNode } from "react";

import { MENTION_CHIP } from "@/components/wisp-mention";
import { fileMentionRanges } from "../../shared/file-mentions";

/** A plain text with its `@` mentions of workspace files set apart, like a circle's mentions of members. */
export function FileMentionedText({ text }: { text: string }) {
  const ranges = fileMentionRanges(text);
  if (!ranges.length) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  for (const { start, end, path } of ranges) {
    parts.push(text.slice(from, start));
    parts.push(
      <span key={start} className={MENTION_CHIP} title={`${path} in the workspace`}>
        {text.slice(start, end)}
      </span>,
    );
    from = end;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}
