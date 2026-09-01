import { useDeferredValue, useState } from "react";
import { SearchIcon } from "lucide-react";

import type { Chat, ChatCollection, ChatId } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { findMessageSearchMatch } from "@/lib/message-search";

type SearchFilter = "all" | "wisps" | "messages";

const SEARCH_FILTERS: ReadonlyArray<{ id: SearchFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "wisps", label: "Wisps" },
  { id: "messages", label: "Messages" },
];

function chatMetadata(chat: Chat): string {
  return `${chat.name} ${chat.label} ${chat.description}`.toLocaleLowerCase();
}

interface SearchDialogProps {
  chats: ChatCollection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectChat: (chatId: ChatId) => void;
}

interface SearchResult {
  chat: Chat;
  snippet?: string;
}

function SearchDialog({ chats, open, onOpenChange, onSelectChat }: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SearchFilter>("all");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const matches = Object.values(chats).flatMap<SearchResult>((chat) => {
    if (!deferredQuery) return [{ chat }];

    const metadataMatches = filter !== "messages" && chatMetadata(chat).includes(deferredQuery);
    const messageMatch = filter === "wisps" ? undefined : findMessageSearchMatch(chat.messages, deferredQuery);
    if (!metadataMatches && !messageMatch) return [];

    return [{ chat, snippet: metadataMatches ? undefined : messageMatch?.snippet }];
  });

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
      <DialogContent className="mt-[9vh] max-w-[620px] gap-0 self-start overflow-hidden p-0" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>Search Wisps, circles, and messages.</DialogDescription>
        </DialogHeader>
        <div className="flex h-[50px] items-center gap-[9px] border-b border-black/[0.07] px-3.5 dark:border-white/[0.07]">
          <SearchIcon aria-hidden="true" className="size-[15px] text-[#686868] dark:text-[#888888]" />
          <input
            className="min-w-0 flex-1 border-0 bg-transparent text-[#222222] outline-none dark:text-[#eeeeee]"
            autoFocus
            aria-label="Search"
            placeholder="Search Wisps, circles, and messages"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <kbd className="rounded-[5px] border border-black/[0.08] px-1.5 py-0.5 text-[10px] text-[#666666] [font-family:inherit] dark:border-white/[0.08] dark:text-[#777777]">
            esc
          </kbd>
        </div>
        <div className="flex gap-1 px-2.5 pt-[9px] pb-1.5" role="group" aria-label="Filter results">
          {SEARCH_FILTERS.map(({ id, label }) => (
            <button
              type="button"
              key={id}
              data-selected={filter === id}
              className="rounded-[7px] border-0 bg-transparent px-[9px] py-1 text-[11.5px] text-[#606060] hover:not-data-[selected=true]:bg-[#efefef] hover:not-data-[selected=true]:text-[#333333] data-[selected=true]:bg-[#e4e4e4] data-[selected=true]:text-[#222222] dark:text-[#aaaaaa] dark:hover:not-data-[selected=true]:bg-[#232323] dark:hover:not-data-[selected=true]:text-[#dddddd] dark:data-[selected=true]:bg-[#303030] dark:data-[selected=true]:text-[#eeeeee]"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="max-h-[360px] overflow-y-auto px-1.5 pt-1 pb-2">
          {matches.length ? (
            matches.map(({ chat, snippet }) => {
              return (
                <button
                  type="button"
                  key={chat.id}
                  className="flex w-full items-center gap-2.5 rounded-lg border-0 bg-transparent p-2 text-left hover:bg-[#e9e9e9] dark:hover:bg-[#292929]"
                  onClick={() => {
                    onSelectChat(chat.id);
                    onOpenChange(false);
                  }}
                >
                  <ChatAvatar chat={chat} chats={chats} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <strong className="truncate">{chat.name}</strong>
                    <small className="truncate text-dim">{snippet ?? chat.preview}</small>
                  </span>
                  <em className="text-[11px] not-italic text-[#646464] dark:text-[#747474]">
                    {chat.isCircle ? "Circle" : "Wisp"}
                  </em>
                </button>
              );
            })
          ) : (
            <p className="p-[35px] text-center text-dim">No results found</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { SearchDialog };
export type { SearchDialogProps };
