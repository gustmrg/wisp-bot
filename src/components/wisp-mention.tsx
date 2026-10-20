import type { ReactNode } from "react";

import type { Wisp } from "@/chat-data";
import { cn } from "@/lib/utils";
import { mentionRanges } from "../../shared/circle-mentions";

/** The circle's members a message's mentions refer to, and what a click on one does. */
export interface WispMentions {
  members: ReadonlyArray<Pick<Wisp, "id" | "name">>;
  onOpenWisp?: (wispId: string) => void;
}

/** An `@` mention of a member, set apart like an attached file; it opens its Wisp's conversation. */
export function WispMention({
  memberId,
  mentions,
  children,
}: {
  memberId: string;
  mentions: WispMentions;
  children: ReactNode;
}) {
  const chip = "rounded-md bg-current/10 px-1 py-px font-medium";
  const { onOpenWisp } = mentions;
  if (!onOpenWisp) return <span className={chip}>{children}</span>;
  const name = mentions.members.find(({ id }) => id === memberId)?.name ?? "this Wisp";
  return (
    <button
      type="button"
      className={cn(chip, "cursor-pointer border-0 text-inherit hover:bg-current/20 focus-visible:outline-2")}
      title={`Open ${name}'s conversation and settings`}
      onClick={() => onOpenWisp(memberId)}
    >
      {children}
    </button>
  );
}

/** A plain text with its mentions of members set apart. */
export function MentionedText({ text, mentions }: { text: string; mentions: WispMentions }) {
  const ranges = mentions.members.length ? mentionRanges(text, mentions.members) : [];
  if (!ranges.length) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  for (const { start, end, memberId } of ranges) {
    parts.push(text.slice(from, start));
    parts.push(
      <WispMention key={start} memberId={memberId} mentions={mentions}>
        {text.slice(start, end)}
      </WispMention>,
    );
    from = end;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

/** The attribute that marks a mention in rendered Markdown, carrying the member's ID. */
export const MENTION_ATTRIBUTE = "data-wisp-mention";

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName?: string; hProperties?: Record<string, string> };
}

// Text inside these is not prose: a link's text (an autolinked email address
// among them), code and raw HTML stay as written.
const VERBATIM = new Set(["link", "linkReference", "inlineCode", "code", "html", "definition"]);

/**
 * A remark plugin that turns the mentions of members in a Markdown text's
 * prose into spans marked with `MENTION_ATTRIBUTE`. Mentions follow the same
 * rule that routes a circle's messages, so an `@` inside a word, as in
 * `ada@example.com`, mentions no one.
 */
export function remarkWispMentions(members: WispMentions["members"]) {
  const split = (node: MarkdownNode): MarkdownNode[] => {
    const text = node.value ?? "";
    const ranges = mentionRanges(text, members);
    if (!ranges.length) return [node];
    const parts: MarkdownNode[] = [];
    let from = 0;
    for (const { start, end, memberId } of ranges) {
      if (start > from) parts.push({ type: "text", value: text.slice(from, start) });
      parts.push({
        type: "wispMention",
        data: { hName: "span", hProperties: { [MENTION_ATTRIBUTE]: memberId } },
        children: [{ type: "text", value: text.slice(start, end) }],
      });
      from = end;
    }
    if (from < text.length) parts.push({ type: "text", value: text.slice(from) });
    return parts;
  };
  const visit = (node: MarkdownNode) => {
    if (!node.children || VERBATIM.has(node.type)) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return split(child);
      visit(child);
      return [child];
    });
  };
  return () => (tree: MarkdownNode) => {
    if (members.length) visit(tree);
  };
}
