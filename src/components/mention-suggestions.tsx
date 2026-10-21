import { FileIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import type { Wisp } from "@/chat-data";
import { WispAvatar } from "@/components/chat-avatar";
import { cn } from "@/lib/utils";
import { fileMentionText } from "../../shared/file-mentions";

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

/** Something an `@` can mention. */
export interface MentionSuggestion {
  key: string;
  /** Written after the `@` when it is picked. */
  text: string;
  /** How it shows in the list. */
  content: ReactNode;
}

const MAX_SUGGESTIONS = 8;

/** A circle's members whose name starts with what follows the `@` (ADR 011). */
export function memberSuggestions(members: ReadonlyArray<Wisp>, query: string): MentionSuggestion[] {
  return members
    .filter(({ name }) => name.toLowerCase().startsWith(query.toLowerCase()))
    .slice(0, MAX_SUGGESTIONS)
    .map((member) => ({
      key: member.id,
      text: member.name,
      content: (
        <>
          <WispAvatar wisp={member} size="sm" />
          <span className="min-w-0 truncate">{member.name}</span>
          {member.role ? <small className="min-w-0 truncate text-faint">{member.role}</small> : null}
        </>
      ),
    }));
}

/** Workspace files found for what follows the `@`, already in the order to offer them. */
export function fileSuggestions(paths: ReadonlyArray<string>): MentionSuggestion[] {
  return paths.map((path) => {
    const name = baseName(path);
    const folder = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    return {
      key: path,
      text: fileMentionText(path),
      content: (
        <>
          <FileIcon aria-hidden="true" className="size-4 flex-none text-dim" />
          <span className="min-w-0 flex-none truncate">{name}</span>
          {folder ? <small className="min-w-0 truncate text-faint">{folder}</small> : null}
        </>
      ),
    };
  });
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
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
 * Completes `@` mentions: typing `@` lists what `suggest` offers for what
 * follows it, a circle's members (ADR 011) or a Wisp's workspace files, and
 * picking one writes it in full. `onQuery` follows what is typed after the
 * `@`, null once no list is shown, for suggestions found elsewhere. When nothing matches,
 * `empty` can say why in place of the list; Enter still sends then.
 */
export function useMentionSuggestions({
  suggest,
  label,
  onQuery,
  empty,
  draft,
  onDraftChange,
  textareaRef,
}: {
  suggest: (query: string) => ReadonlyArray<MentionSuggestion>;
  /** Names the list for assistive technology. */
  label: string;
  onQuery?: (query: string | null) => void;
  /** Shown when nothing matches what follows the `@`; null shows nothing, as while the list loads. */
  empty?: () => string | null;
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
  const query = queryAt(draft, caret);
  const matches = query ? suggest(query.text) : [];
  const shown = Boolean(query && dismissed !== query.start);
  // The latest handler, so a new one each render does not count as another query.
  const latestOnQuery = useRef(onQuery);
  latestOnQuery.current = onQuery;
  const shownQuery = shown ? query!.text : null;
  useEffect(() => {
    latestOnQuery.current?.(shownQuery);
  }, [shownQuery]);
  const open = shown && matches.length > 0;
  const emptyMessage = shown && !matches.length ? (empty?.() ?? null) : null;
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));

  function readCaret() {
    const textarea = textareaRef.current;
    setCaret(textarea ? textarea.selectionStart : null);
  }

  function pick(suggestion: MentionSuggestion) {
    if (!query) return;
    const end = query.start + 1 + query.text.length;
    const inserted = `@${suggestion.text} `;
    onDraftChange(`${draft.slice(0, query.start)}${inserted}${draft.slice(end).replace(/^ /, "")}`);
    const position = query.start + inserted.length;
    pendingCaret.current = position;
    setCaret(position);
    setActive(0);
  }

  function handleKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (emptyMessage && event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      setDismissed(query!.start);
      return true;
    }
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
        aria-label={label}
        className="absolute right-3 bottom-full left-3 z-20 m-0 mb-1 max-w-[320px] list-none rounded-xl border border-border bg-card p-1 shadow-lg"
      >
        {matches.map((suggestion, index) => (
          <li
            key={suggestion.key}
            id={optionId(index)}
            role="option"
            aria-selected={index === activeIndex}
            className={cn(
              "flex min-h-9 cursor-default items-center gap-2.5 rounded-lg px-2 text-sm select-none",
              index === activeIndex && "bg-muted",
            )}
            // Picking must not take the focus away from the draft.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pick(suggestion)}
            onMouseEnter={() => setActive(index)}
          >
            {suggestion.content}
          </li>
        ))}
      </ul>
    ) : emptyMessage ? (
      <div
        role="status"
        className="absolute right-3 bottom-full left-3 z-20 mb-1 flex min-h-11 max-w-[320px] items-center rounded-xl border border-border bg-card px-3 text-sm text-dim shadow-lg select-none"
      >
        {emptyMessage}
      </div>
    ) : null,
  };
}
