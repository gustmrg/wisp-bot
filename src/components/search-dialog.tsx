import { useDeferredValue, useState } from "react";
import { SearchIcon } from "lucide-react";

import type { ChatCollection, ChatId } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface SearchDialogProps {
  chats: ChatCollection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectChat: (chatId: ChatId) => void;
}

function SearchDialog({ chats, open, onOpenChange, onSelectChat }: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const matches = Object.values(chats).filter((chat) => {
    if (!deferredQuery) return true;
    const messageText = chat.messages.map((message) => "text" in message ? message.text : "").join(" ");
    return `${chat.name} ${chat.label} ${chat.description} ${messageText}`.toLocaleLowerCase().includes(deferredQuery);
  });

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { onOpenChange(nextOpen); if (!nextOpen) setQuery(""); }}>
      <DialogContent className="search-dialog" showCloseButton={false}>
        <DialogHeader className="sr-only"><DialogTitle>Search</DialogTitle><DialogDescription>Search Wisps, channels, and messages.</DialogDescription></DialogHeader>
        <div className="search-input-row"><SearchIcon aria-hidden="true" /><input autoFocus aria-label="Search" placeholder="Search Wisps, channels, and messages" value={query} onChange={(event) => setQuery(event.currentTarget.value)} /><kbd>esc</kbd></div>
        <div className="search-tabs"><span>All</span><span>Wisps</span><span>Messages</span></div>
        <div className="search-results">
          {matches.length ? matches.map((chat) => (
            <button type="button" key={chat.id} onClick={() => { onSelectChat(chat.id); onOpenChange(false); }}>
              <ChatAvatar chat={chat} />
              <span><strong>{chat.name}</strong><small>{chat.preview}</small></span>
              <em>{chat.isGroup ? "Channel" : "Wisp"}</em>
            </button>
          )) : <p>No results found</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { SearchDialog };
export type { SearchDialogProps };
