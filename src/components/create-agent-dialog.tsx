import { useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { CircleIcon, PlusIcon } from "lucide-react";

import type { ChatCollection, NewChat, WispChat } from "@/chat-data";
import { CreateCircleForm } from "@/components/create-circle-form";
import { CreateWispForm } from "@/components/create-wisp-form";
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
import { Wisp } from "@/components/wisp";
import { FEATURE_FLAGS } from "@/lib/feature-flags";
import { cn } from "@/lib/utils";
import { AVATAR_COLORS } from "@/lib/wisp-appearance";

type NewAgent = NewChat;

interface CreateAgentDialogProps {
  chats: ChatCollection;
  onCreate: (agent: NewAgent) => void;
  trigger?: ReactElement;
}

const DEFAULT_WISP: WispChat = {
  id: "new-wisp",
  name: "",
  label: "",
  description: "",
  color: AVATAR_COLORS.find((color) => color.id === "violet")?.value,
  shape: "hexagon",
  kind: "wisp",
  notifyOnUpdatesEnabled: true,
  preview: "",
  timestamp: "",
  messages: [],
};

function CreateAgentDialog({ chats, onCreate, trigger }: CreateAgentDialogProps) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<WispChat>(DEFAULT_WISP);
  const { name, description, color } = settings;
  const [creationKind, setCreationKind] = useState<"wisp" | "circle">("wisp");
  const creatingCircle = FEATURE_FLAGS.circles && creationKind === "circle";
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const availableWisps = Object.values(chats).filter((chat) => chat.kind === "wisp");
  const selectedWisps = availableWisps.filter((chat) => memberIds.includes(chat.id));

  function resetForm() {
    setSettings(DEFAULT_WISP);
    setCreationKind("wisp");
    setMemberIds([]);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;

    onCreate(
      creatingCircle
        ? {
            kind: "circle",
            name: trimmedName,
            label: "Circle",
            description: "",
            memberIds: selectedWisps.map((chat) => chat.id),
            notifyOnUpdatesEnabled: true,
          }
        : {
            kind: "wisp",
            name: trimmedName,
            label: settings.label.trim(),
            description: description.trim(),
            color,
            shape: settings.shape,
            avatarImage: settings.avatarImage,
            notifyOnUpdatesEnabled: settings.notifyOnUpdatesEnabled,
          },
    );
    setOpen(false);
    resetForm();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) resetForm();
      }}
    >
      <DialogTrigger
        render={
          trigger ?? (
            <Button
              className="w-full justify-center gap-2 px-2 group-data-[collapsed=true]/sidebar:w-9 group-data-[collapsed=true]/sidebar:px-0"
              variant="ghost"
              size="sm"
              type="button"
              aria-label="Create Wisp"
            />
          )
        }
      >
        {trigger ? null : (
          <>
            <PlusIcon />
            <span className="group-data-[collapsed=true]/sidebar:hidden">Create Wisp</span>
          </>
        )}
      </DialogTrigger>

      <DialogContent
        className={cn(
          "flex max-h-[calc(100dvh-32px)] flex-col",
          creatingCircle
            ? "max-w-[640px] gap-0 overflow-hidden rounded-[20px] p-0 [&>[aria-label=Close]]:top-[18px] [&>[aria-label=Close]]:right-5"
            : "max-w-[530px]",
        )}
      >
        <DialogHeader className={cn("flex-none", creatingCircle && "border-b border-border py-[22px] pr-14 pl-6")}>
          <DialogTitle className={creatingCircle ? "text-[20px] font-[550]" : undefined}>
            {creatingCircle ? "New circle" : "Create new"}
          </DialogTitle>
          <DialogDescription className={creatingCircle ? "sr-only" : undefined}>
            {creatingCircle
              ? "Name your circle and choose the Wisps to add."
              : FEATURE_FLAGS.circles
                ? "Create a Wisp for focused work or a circle for a shared project."
                : "Create a Wisp for focused work."}
          </DialogDescription>
        </DialogHeader>

        <div
          className={cn(
            "grid flex-none gap-2",
            FEATURE_FLAGS.circles ? "grid-cols-2" : "grid-cols-1",
            creatingCircle && "px-5 pt-4",
          )}
          role="group"
          aria-label="Creation type"
        >
          <button
            className={cn(
              "flex items-center gap-2.5 rounded-[10px] border border-black/[0.07] bg-white p-[11px] text-left dark:border-white/[0.07] dark:bg-[#1d1d1d]",
              !creatingCircle && "border-black/30 bg-[#eeeeee] dark:border-white/30 dark:bg-[#303030]",
            )}
            type="button"
            onClick={() => setCreationKind("wisp")}
          >
            <Wisp
              color={color}
              shape={settings.shape}
              name={name || "New Wisp"}
              size="sm"
              className="size-7! flex-none"
            />
            <span className="flex flex-col gap-0.5">
              <strong>Wisp</strong>
              <small className="text-dim text-[11px]">An autonomous teammate</small>
            </span>
          </button>
          {FEATURE_FLAGS.circles ? (
            <button
              className={cn(
                "flex items-center gap-2.5 rounded-[10px] border border-black/[0.07] bg-white p-[11px] text-left dark:border-white/[0.07] dark:bg-[#1d1d1d]",
                creatingCircle && "border-black/30 bg-[#eeeeee] dark:border-white/30 dark:bg-[#303030]",
              )}
              type="button"
              onClick={() => setCreationKind("circle")}
            >
              <CircleIcon aria-hidden="true" className="size-7 flex-none" />
              <span className="flex flex-col gap-0.5">
                <strong>Circle</strong>
                <small className="text-dim text-[11px]">A shared workspace</small>
              </span>
            </button>
          ) : null}
        </div>

        <form className={cn("flex min-h-0 flex-col gap-5", creatingCircle && "gap-0")} onSubmit={handleSubmit}>
          {!creatingCircle ? (
            <CreateWispForm
              settings={settings}
              onChange={(changes) => setSettings((current) => ({ ...current, ...changes }))}
            />
          ) : (
            <CreateCircleForm
              name={name}
              availableWisps={availableWisps}
              memberIds={memberIds}
              onNameChange={(nextName) => setSettings((current) => ({ ...current, name: nextName }))}
              onMemberIdsChange={setMemberIds}
            />
          )}
          <DialogFooter
            className={cn(
              "flex-none",
              creatingCircle &&
                "flex-row justify-end border-t border-border px-5 py-4 [&_button]:h-10 [&_button]:min-w-[78px] [&_button]:rounded-[11px] [&_button]:text-base",
            )}
          >
            {!creatingCircle ? (
              <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            ) : null}
            <Button type="submit" disabled={!name.trim()}>
              {creatingCircle ? "Create" : "Create Wisp"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { CreateAgentDialog };
export type { NewAgent };
