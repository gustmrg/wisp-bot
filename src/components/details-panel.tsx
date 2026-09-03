import type { PointerEvent as ReactPointerEvent } from "react";
import { CheckIcon, Share2Icon, XIcon } from "lucide-react";

import type { Chat, ChatChanges, ChatCollection } from "@/chat-data";
import { CircleDetails } from "@/components/circle-details";
import { WispDetails } from "@/components/wisp-details";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { canDeleteChat } from "@/lib/chat-schema";
import { detailsLayoutStyle } from "@/lib/layout";
import { panelResizer } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";

interface DetailsPanelProps {
  chat: Chat;
  chats: ChatCollection;
  width: number;
  onChange: (changes: ChatChanges) => Promise<boolean> | void;
  onClose: () => void;
  onDelete: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

function DetailsPanel({ chat, chats, width, onChange, onClose, onDelete, onResizeStart }: DetailsPanelProps) {
  const copyFeedback = useCopyFeedback(chat.id);

  function shareTemplate() {
    void copyFeedback.copy(`wisp://template/${chat.id}`);
  }

  return (
    <aside
      className="relative flex min-h-0 min-w-(--details-min-width) w-(--details-width) animate-panel-in flex-none flex-col border-l border-black/[0.055] bg-panel max-[900px]:absolute max-[900px]:inset-y-0 max-[900px]:right-0 max-[900px]:z-[8] max-[900px]:shadow-[-20px_0_50px_rgba(0,0,0,0.114)] dark:border-white/[0.055] dark:max-[900px]:shadow-[-20px_0_50px_rgba(0,0,0,0.38)]"
      style={detailsLayoutStyle(width)}
    >
      <div
        className={cn(panelResizer, "-left-1")}
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onResizeStart}
      />
      <header className="grid h-11 flex-none grid-cols-[28px_1fr_28px] items-center border-b border-black/[0.04] px-[9px] dark:border-white/[0.04]">
        <strong className="col-start-2 text-center text-[12.5px]">Settings</strong>
        <Button variant="ghost" size="icon-sm" type="button" aria-label="Close details" onClick={onClose}>
          <XIcon />
        </Button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
          {chat.kind === "wisp" ? (
            <WispDetails key={chat.id} chat={chat} onChange={onChange} />
          ) : (
            <CircleDetails chat={chat} chats={chats} onChange={onChange} />
          )}

          {canDeleteChat(chat) ? (
            <Dialog>
              <DialogTrigger render={<Button className="mt-[18px] w-full" variant="destructive" type="button" />}>
                Delete {chat.kind === "circle" ? "circle" : "Wisp"}
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete {chat.name}?</DialogTitle>
                  <DialogDescription>
                    This permanently deletes this {chat.kind === "circle" ? "circle" : "Wisp"}, including its
                    conversation history and settings. This action cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
                  <DialogClose render={<Button variant="destructive" type="button" onClick={onDelete} />}>
                    Confirm deletion
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : null}
        </div>

        <footer className="flex-none px-3.5 pt-2.5 pb-3">
          <span
            className="sr-only"
            role={copyFeedback.status === "error" ? "alert" : "status"}
            aria-live={copyFeedback.status === "error" ? "assertive" : "polite"}
          >
            {copyFeedback.message}
          </span>
          <Button className="w-full" variant="secondary" type="button" onClick={shareTemplate}>
            {copyFeedback.status === "success" ? <CheckIcon /> : <Share2Icon />}
            {copyFeedback.status === "copying"
              ? "Copying template link…"
              : copyFeedback.status === "success"
                ? "Template link copied"
                : copyFeedback.status === "error"
                  ? "Could not copy template link"
                  : "Share as template"}
          </Button>
        </footer>
      </div>
    </aside>
  );
}

export { DetailsPanel };
export type { DetailsPanelProps };
