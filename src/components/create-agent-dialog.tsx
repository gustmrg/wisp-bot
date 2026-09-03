import { useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { PlusIcon } from "lucide-react";

import type { NewWisp, WispChat } from "@/chat-data";
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
import { AVATAR_COLORS } from "@/lib/wisp-appearance";

type NewAgent = NewWisp;

interface CreateAgentDialogProps {
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

function CreateAgentDialog({ onCreate, trigger }: CreateAgentDialogProps) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<WispChat>(DEFAULT_WISP);
  const { name, description, color } = settings;

  function resetForm() {
    setSettings(DEFAULT_WISP);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;

    onCreate({
      kind: "wisp",
      name: trimmedName,
      label: settings.label.trim(),
      description: description.trim(),
      color,
      shape: settings.shape,
      avatarImage: settings.avatarImage,
      notifyOnUpdatesEnabled: settings.notifyOnUpdatesEnabled,
    });
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
              className="w-fit justify-center gap-2 px-3 text-sm group-data-[collapsed=true]/sidebar:w-9 group-data-[collapsed=true]/sidebar:px-0"
              variant="ghost"
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

      <DialogContent className="flex max-h-[calc(100dvh-32px)] max-w-[530px] flex-col">
        <DialogHeader className="flex-none">
          <DialogTitle>Create new Wisp</DialogTitle>
          <DialogDescription>Create a Wisp for focused work.</DialogDescription>
        </DialogHeader>

        <form className="flex min-h-0 flex-col gap-5" onSubmit={handleSubmit}>
          <CreateWispForm
            settings={settings}
            onChange={(changes) => setSettings((current) => ({ ...current, ...changes }))}
          />
          <DialogFooter className="flex-none">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!name.trim()}>
              Create Wisp
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { CreateAgentDialog };
export type { NewAgent };
