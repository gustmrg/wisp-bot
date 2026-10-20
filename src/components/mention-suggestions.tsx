import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";

import type { Wisp } from "@/chat-data";
import { WispAvatar } from "@/components/chat-avatar";
import { cn } from "@/lib/utils";

/** The `@` being typed right before the caret, unless it is inside a word, as in an email address. */
const MENTION_AT_CARET = /(?:^|[^\p{L}\p{N}_])@([^\s@]{0,64})$/u;

interface MentionQuery {
  /** Where the `@` is. */
  start: number;
  text: string;
}

function queryAt(draft: string, caret: number | null): MentionQuery | null {
  if (caret === null) return null;
  const match = MENTION_AT_CARET.exec(draft.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1]!.length - 1, text: match[1]! };
}

export interface MentionSuggestions {
  /** Spread on the textarea: the combobox's attributes, and what keeps the caret known. */
  inputProps: {
    "aria-autocomplete": "list";
    "aria-controls": string | undefined;
    "aria-expanded": boolean;
    "aria-activedescendant": string | undefined;
    onSelect: () => void;
    onClick: () => void;
  };
  /** Moves through and picks a suggestion; true when it handled the key. */
  handleKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Call after the draft changed, with the textarea's caret. */
  follow: (caret: number | null) => void;
  list: ReactNode;
}

/**
 * Completes `@` mentions of a circle's members (ADR 011): typing `@` lists
 * the members whose name starts with what follows it, and picking one writes
 * its full name.
 */
export function useMentionSuggestions({
  members,
  draft,
  onDraftChange,
  textareaRef,
}: {
  members: ReadonlyArray<Wisp>;
  draft: string;
  onDraftChange: (draft: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}): MentionSuggestions {
  const listId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  // Where the caret goes once a picked name is in the draft; checked after every render.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const position = pendingCaret.current;
    const textarea = textareaRef.current;
    if (position === null || !textarea) return;
    pendingCaret.current = null;
    textarea.focus();
    textarea.setSelectionRange(position, position);
  });
  const query = members.length ? queryAt(draft, caret) : null;
  const matches = query
    ? members.filter(({ name }) => name.toLowerCase().startsWith(query.text.toLowerCase())).slice(0, 8)
    : [];
  const open = Boolean(query && matches.length && dismissed !== query.start);
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));

  function readCaret() {
    const textarea = textareaRef.current;
    setCaret(textarea ? textarea.selectionStart : null);
  }

  function pick(member: Wisp) {
    if (!query) return;
    const end = query.start + 1 + query.text.length;
    const inserted = `@${member.name} `;
    onDraftChange(`${draft.slice(0, query.start)}${inserted}${draft.slice(end).replace(/^ /, "")}`);
    const position = query.start + inserted.length;
    pendingCaret.current = position;
    setCaret(position);
    setActive(0);
  }

  function handleKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + matches.length) % matches.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      pick(matches[activeIndex]!);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(query!.start);
      return true;
    }
    return false;
  }

  const optionId = (index: number) => `${listId}-option-${index}`;
  return {
    inputProps: {
      "aria-autocomplete": "list",
      "aria-controls": open ? listId : undefined,
      "aria-expanded": open,
      "aria-activedescendant": open ? optionId(activeIndex) : undefined,
      onSelect: readCaret,
      onClick: readCaret,
    },
    handleKey,
    follow: (position) => {
      setCaret(position);
      setActive(0);
    },
    list: open ? (
      <ul
        id={listId}
        role="listbox"
        aria-label="Mention a Wisp"
        className="absolute right-3 bottom-full left-3 z-20 m-0 mb-1 max-w-[320px] list-none rounded-xl border border-border bg-card p-1 shadow-lg"
      >
        {matches.map((member, index) => (
          <li
            key={member.id}
            id={optionId(index)}
            role="option"
            aria-selected={index === activeIndex}
            className={cn(
              "flex min-h-9 cursor-default items-center gap-2.5 rounded-lg px-2 text-sm select-none",
              index === activeIndex && "bg-muted",
            )}
            // Picking must not take the focus away from the draft.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pick(member)}
            onMouseEnter={() => setActive(index)}
          >
            <WispAvatar wisp={member} size="sm" />
            <span className="min-w-0 truncate">{member.name}</span>
            {member.role ? <small className="min-w-0 truncate text-faint">{member.role}</small> : null}
          </li>
        ))}
      </ul>
    ) : null,
  };
}
