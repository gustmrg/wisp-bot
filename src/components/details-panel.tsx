import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { CheckIcon, ChevronLeftIcon, Share2Icon, XIcon } from "lucide-react";

import type { ChatChanges, ChatView, WispChanges, WispCollection } from "@/chat-data";
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
import { chatName } from "@/lib/chat-schema";
import { detailsLayoutStyle } from "@/lib/layout";
import { panelResizer } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";
import { serializeWispTemplate } from "@/lib/wisp-template";
import type { IntegrationSettingsTarget } from "@/lib/plugin-access";

interface DetailsPanelProps {
  mobile?: boolean;
  chat: ChatView;
  wisps: WispCollection;
  width: number;
  onChange: (changes: ChatChanges) => Promise<boolean> | void;
  onChangeWisp: (wispId: string, changes: WispChanges) => Promise<boolean> | void;
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
  onClose: () => void;
  onDelete: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

function DetailsPanel({
  chat,
  wisps,
  width,
  onChange,
  onChangeWisp,
  onOpenSettings,
  onClose,
  onDelete,
  onResizeStart,
  mobile = false,
}: DetailsPanelProps) {
  const copyFeedback = useCopyFeedback(chat.id);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusChatId = mobile ? chat.id : null;
  useEffect(() => {
    if (focusChatId) titleRef.current?.focus();
  }, [focusChatId]);

  /** Copies the Wisp's soul and the model it runs on, so it can be pasted when creating a Wisp. */
  async function shareTemplate(): Promise<void> {
    if (chat.kind !== "wisp") return;
    const model = await window.wisp.getConversationModel({ conversationId: chat.id }).catch(() => null);
    await copyFeedback.copy(serializeWispTemplate(chat.wisp, model?.ok ? model.value.effective : null));
  }

  const name = chatName(chat);
  const deleteControl = (
    <Dialog>
      <DialogTrigger render={<Button className="w-full" variant="destructive" type="button" />}>
        Delete {chat.kind === "circle" ? "circle" : "Wisp"}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription>
            This permanently deletes this {chat.kind === "circle" ? "circle" : "Wisp"}, including its conversation
            history and settings. This action cannot be undone.
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
  );
  const shareControl = (
    <>
      <span
        className="sr-only"
        role={copyFeedback.status === "error" ? "alert" : "status"}
        aria-live={copyFeedback.status === "error" ? "assertive" : "polite"}
      >
        {copyFeedback.message}
      </span>
      <Button className="w-full" variant="secondary" type="button" onClick={() => void shareTemplate()}>
        {copyFeedback.status === "success" ? <CheckIcon /> : <Share2Icon />}
        {copyFeedback.status === "copying"
          ? "Copying template…"
          : copyFeedback.status === "success"
            ? "Template copied"
            : copyFeedback.status === "error"
              ? "Could not copy template"
              : "Share as template"}
      </Button>
    </>
  );

  return (
    <aside
      className={cn(
        "wisp-details-panel relative flex min-h-0 animate-panel-in flex-none flex-col bg-panel",
        mobile
          ? "w-full min-w-0"
          : "min-w-(--details-min-width) w-(--details-width) border-l border-black/[0.055] max-[900px]:absolute max-[900px]:inset-y-0 max-[900px]:right-0 max-[900px]:z-[8] max-[900px]:shadow-[-20px_0_50px_rgba(0,0,0,0.114)] dark:border-white/[0.055] dark:max-[900px]:shadow-[-20px_0_50px_rgba(0,0,0,0.38)]",
      )}
      style={detailsLayoutStyle(width)}
      aria-label={`${name} settings`}
    >
      {!mobile ? (
        <div
          className={cn(panelResizer, "-left-1")}
          role="separator"
          aria-orientation="vertical"
          onPointerDown={onResizeStart}
        />
      ) : null}
      <header className="details-header grid h-11 flex-none grid-cols-[28px_1fr_28px] items-center border-b border-black/[0.04] px-[9px] dark:border-white/[0.04]">
        <h2 ref={titleRef} tabIndex={-1} className="col-start-2 text-center text-sm font-semibold outline-none">
          {mobile ? "Wisp settings" : "Settings"}
        </h2>
        <Button
          className={mobile ? "details-back" : undefined}
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label={mobile ? "Back to conversation" : "Close details"}
          onClick={onClose}
        >
          {mobile ? <ChevronLeftIcon aria-hidden="true" /> : <XIcon />}
        </Button>
      </header>

      {chat.kind === "wisp" ? (
        <WispDetails
          key={chat.id}
          chat={chat}
          onChangeWisp={(changes) => onChangeWisp(chat.wispId, changes)}
          onChangeNotifications={(notifyOnUpdatesEnabled) => onChange({ kind: "wisp", notifyOnUpdatesEnabled })}
          onOpenSettings={onOpenSettings}
          generalActions={
            <>
              {shareControl}
              {deleteControl}
            </>
          }
        />
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
            <CircleDetails chat={chat} wisps={wisps} onChange={onChange} />
            <div className="mt-[18px]">{deleteControl}</div>
          </div>
        </div>
      )}
    </aside>
  );
}

export { DetailsPanel };
export type { DetailsPanelProps };
