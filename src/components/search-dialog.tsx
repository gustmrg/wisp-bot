import { useDeferredValue, useState } from "react";
import { SearchIcon } from "lucide-react";

import type { Chat, ChatCollection, ChatId } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type SearchFilter = "all" | "wisps" | "messages";

const SEARCH_FILTERS: ReadonlyArray<{ id: SearchFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "wisps", label: "Wisps" },
  { id: "messages", label: "Messages" },
];

function chatMetadata(chat: Chat): string {
  return `${chat.name} ${chat.label} ${chat.description}`.toLocaleLowerCase();
}

function chatMessageText(chat: Chat): string {
  return chat.messages.map((message) => ("text" in message ? message.text : "")).join(" ").toLocaleLowerCase();
}

interface SearchDialogProps {
  chats: ChatCollection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectChat: (chatId: ChatId) => void;
}

function SearchDialog({ chats, open, onOpenChange, onSelectChat }: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SearchFilter>("all");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const matches = Object.values(chats).filter((chat) => {
    if (!deferredQuery) return true;
    if (filter === "wisps") return chatMetadata(chat).includes(deferredQuery);
    if (filter === "messages") return chatMessageText(chat).includes(deferredQuery);
    return chatMetadata(chat).includes(deferredQuery) || chatMessageText(chat).includes(deferredQuery);
  });

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { onOpenChange(nextOpen); if (!nextOpen) { setQuery(""); setFilter("all"); } }}>
      <DialogContent className="search-dialog" showCloseButton={false}>
        <DialogHeader className="sr-only"><DialogTitle>Search</DialogTitle><DialogDescription>Search Wisps, circles, and messages.</DialogDescription></DialogHeader>
        <div className="search-input-row"><SearchIcon aria-hidden="true" /><input autoFocus aria-label="Search" placeholder="Search Wisps, circles, and messages" value={query} onChange={(event) => setQuery(event.currentTarget.value)} /><kbd>esc</kbd></div>
        <div className="search-tabs" role="group" aria-label="Filter results">
          {SEARCH_FILTERS.map(({ id, label }) => (
            <button type="button" key={id} data-selected={filter === id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        <div className="search-results">
          {matches.length ? matches.map((chat) => {
            const matchedMessage = filter !== "wisps" && deferredQuery
              ? chat.messages.find((message) => "text" in message && message.text.toLocaleLowerCase().includes(deferredQuery))
              : undefined;
            return (
              <button type="button" key={chat.id} onClick={() => { onSelectChat(chat.id); onOpenChange(false); }}>
                <ChatAvatar chat={chat} chats={chats} />
                <span><strong>{chat.name}</strong><small>{matchedMessage && "text" in matchedMessage ? matchedMessage.text : chat.preview}</small></span>
                <em>{chat.isCircle ? "Circle" : "Wisp"}</em>
              </button>
            );
          }) : <p>No results found</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { SearchDialog };
export type { SearchDialogProps };
