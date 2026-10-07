import { useDeferredValue, useState } from "react";
import { ChevronLeftIcon, SearchIcon } from "lucide-react";

import type { ChatId, ChatView, ChatViewCollection } from "@/chat-data";
import { chatName } from "@/lib/chat-schema";
import { ChatAvatar } from "@/components/chat-avatar";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { canSearchMessages, useMessageSearch } from "@/hooks/use-message-search";
import { chatActivityLabel } from "@/lib/date-dividers";
import { MIN_MESSAGE_SEARCH_LENGTH } from "../../shared/message-search";

type SearchFilter = "all" | "wisps" | "messages";

const SEARCH_FILTERS: ReadonlyArray<{ id: SearchFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "wisps", label: "Wisps" },
  { id: "messages", label: "Messages" },
];

const resultRow =
  "flex w-full items-center gap-2.5 rounded-lg border-0 bg-transparent p-2 text-left hover:bg-secondary";

function chatMetadata(chat: ChatView): string {
  const fields =
    chat.kind === "wisp" ? [chat.wisp.name, chat.wisp.role] : [chatName(chat), chat.label, chat.description];
  return fields.join(" ").toLocaleLowerCase();
}

function hitTime(createdAt: string | undefined): string | null {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? null : chatActivityLabel(date);
}

interface SearchDialogProps {
  chats: ChatViewCollection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectChat: (chatId: ChatId) => void;
  onSelectMessage: (chatId: ChatId, messageId: string) => void;
}

function SearchDialog({ chats, open, onOpenChange, onSelectChat, onSelectMessage }: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SearchFilter>("all");
  const trimmedQuery = query.trim();
  const deferredQuery = useDeferredValue(trimmedQuery.toLocaleLowerCase());
  // Names, labels, and descriptions are matched here; message text is matched by the backend index.
  const chatMatches =
    deferredQuery && filter === "messages"
      ? []
      : Object.values(chats).filter((chat) => !deferredQuery || chatMetadata(chat).includes(deferredQuery));
  const searchesMessages = Boolean(trimmedQuery) && filter !== "wisps";
  const messageSearch = useMessageSearch(
    open && searchesMessages && canSearchMessages(trimmedQuery) ? trimmedQuery : null,
  );
  const messageMatches = messageSearch.hits.flatMap((hit) => {
    const chat = chats[hit.conversationId];
    return chat ? [{ hit, chat }] : [];
  });
  const needsMoreCharacters = searchesMessages && !canSearchMessages(trimmedQuery);
  const empty = chatMatches.length === 0 && messageMatches.length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          setQuery("");
          setFilter("all");
        }
      }}
    >
      <DialogContent
        mobileFullscreen
        className="search-dialog mt-[9vh] max-w-[620px] gap-0 self-start overflow-hidden p-0"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>Search Wisps, circles, and messages.</DialogDescription>
        </DialogHeader>
        <div className="mobile-search-header">
          <DialogClose render={<Button variant="ghost" size="icon" type="button" aria-label="Back to conversations" />}>
            <ChevronLeftIcon aria-hidden="true" />
          </DialogClose>
          <h2>Search conversations</h2>
        </div>
        <div className="flex h-[50px] items-center gap-[9px] border-b border-black/[0.07] px-3.5 dark:border-white/[0.07]">
          <SearchIcon aria-hidden="true" className="size-[15px] text-dim" />
          <input
            className="min-w-0 flex-1 border-0 bg-transparent text-foreground outline-none"
            autoFocus
            aria-label="Search"
            placeholder="Search Wisps, circles, and messages"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <kbd className="rounded-[5px] border border-border px-1.5 py-0.5 text-2xs text-dim [font-family:inherit]">
            esc
          </kbd>
        </div>
        <div className="flex gap-1 px-2.5 pt-[9px] pb-1.5" role="group" aria-label="Filter results">
          {SEARCH_FILTERS.map(({ id, label }) => (
            <button
              type="button"
              key={id}
              data-selected={filter === id}
              className="rounded-[7px] border-0 bg-transparent px-[9px] py-1 text-xs text-dim hover:not-data-[selected=true]:bg-muted hover:not-data-[selected=true]:text-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="search-results max-h-[360px] overflow-y-auto px-1.5 pt-1 pb-2">
          {chatMatches.map((chat) => (
            <button
              type="button"
              key={chat.id}
              className={resultRow}
              onClick={() => {
                onSelectChat(chat.id);
                onOpenChange(false);
              }}
            >
              <ChatAvatar chat={chat} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="truncate">{chatName(chat)}</strong>
                <small className="truncate text-dim">{chat.preview}</small>
              </span>
              <em className="text-xs not-italic text-dim">{chat.kind === "circle" ? "Circle" : "Wisp"}</em>
            </button>
          ))}
          {messageMatches.map(({ hit, chat }) => {
            const time = hitTime(hit.createdAt);
            return (
              <button
                type="button"
                key={`${hit.conversationId}:${hit.messageId}`}
                className={resultRow}
                onClick={() => {
                  onSelectMessage(hit.conversationId, hit.messageId);
                  onOpenChange(false);
                }}
              >
                <ChatAvatar chat={chat} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <strong className="truncate">{chatName(chat)}</strong>
                  <small className="truncate text-dim">{hit.snippet}</small>
                </span>
                {time ? (
                  <time className="text-xs text-dim" dateTime={hit.createdAt}>
                    {time}
                  </time>
                ) : null}
              </button>
            );
          })}
          {needsMoreCharacters ? (
            <p className={empty ? "p-[35px] text-center text-dim" : "px-2 pt-2 pb-1 text-xs text-dim"}>
              Type at least {MIN_MESSAGE_SEARCH_LENGTH} characters to search messages.
            </p>
          ) : empty ? (
            <p className="p-[35px] text-center text-dim" role="status">
              {messageSearch.searching ? "Searching…" : "No results found"}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { SearchDialog };
export type { SearchDialogProps };
