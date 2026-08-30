import { useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { Checkbox } from "@base-ui/react/checkbox";
import { CheckIcon, CircleIcon, PlusIcon, XIcon } from "lucide-react";

import type { AgentSettings, ChatCollection } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { WispSettingsFields } from "@/components/wisp-settings-fields";
import { AVATAR_COLORS, Wisp } from "@/components/wisp";
import { cn } from "@/lib/utils";

type NewAgent = Omit<AgentSettings, "id" | "isActive" | "unread">;

interface CreateAgentDialogProps {
  chats: ChatCollection;
  onCreate: (agent: NewAgent) => void;
  trigger?: ReactElement;
}

const DEFAULT_WISP: AgentSettings = {
  id: "new-wisp",
  name: "",
  label: "",
  description: "",
  color: AVATAR_COLORS.find((color) => color.id === "violet")?.value,
  shape: "hexagon",
  isCircle: false,
  notifyOnUpdatesEnabled: true,
};

function CreateAgentDialog({ chats, onCreate, trigger }: CreateAgentDialogProps) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<AgentSettings>(DEFAULT_WISP);
  const { name, description, color } = settings;
  const [isCircle, setIsCircle] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const availableWisps = Object.values(chats).filter((chat) => !chat.isCircle);
  const selectedWisps = availableWisps.filter((chat) => memberIds.includes(chat.id));

  function resetForm() {
    setSettings(DEFAULT_WISP);
    setIsCircle(false);
    setMemberIds([]);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;

    onCreate({
      name: trimmedName,
      label: isCircle ? "Circle" : settings.label.trim(),
      description: isCircle ? "" : description.trim(),
      color,
      shape: isCircle ? "circle" : settings.shape,
      avatarImage: isCircle ? undefined : settings.avatarImage,
      isCircle,
      ...(isCircle ? { memberIds: selectedWisps.map((chat) => chat.id) } : {}),
      notifyOnUpdatesEnabled: isCircle || settings.notifyOnUpdatesEnabled,
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
            <Button variant="ghost" size="icon-sm" type="button" aria-label="New Wisp or circle" />
          )
        }
      >
        {trigger ? null : <PlusIcon />}
      </DialogTrigger>

      <DialogContent
        className={cn(
          "flex max-h-[calc(100dvh-32px)] flex-col",
          isCircle
            ? "max-w-[640px] gap-0 overflow-hidden rounded-[20px] p-0 [&>[aria-label=Close]]:top-[18px] [&>[aria-label=Close]]:right-5"
            : "max-w-[530px]",
        )}
      >
        <DialogHeader className={cn("flex-none", isCircle && "border-b border-border py-[22px] pr-14 pl-6")}>
          <DialogTitle className={isCircle ? "text-[20px] font-[550]" : undefined}>{isCircle ? "New circle" : "Create new"}</DialogTitle>
          <DialogDescription className={isCircle ? "sr-only" : undefined}>{isCircle ? "Name your circle and choose the Wisps to add." : "Create a Wisp for focused work or a circle for a shared project."}</DialogDescription>
        </DialogHeader>

        <div className={cn("grid flex-none grid-cols-2 gap-2", isCircle && "px-5 pt-4")} role="group" aria-label="Creation type">
          <button
            className={cn(
              "flex items-center gap-2.5 rounded-[10px] border border-black/[0.07] bg-white p-[11px] text-left dark:border-white/[0.07] dark:bg-[#1d1d1d]",
              !isCircle && "border-black/30 bg-[#eeeeee] dark:border-white/30 dark:bg-[#303030]",
            )}
            type="button"
            onClick={() => setIsCircle(false)}
          >
            <Wisp color={color} shape={settings.shape} name={name || "New Wisp"} size="sm" className="size-7! flex-none" />
            <span className="flex flex-col gap-0.5"><strong>Wisp</strong><small className="text-dim text-[11px]">An autonomous teammate</small></span>
          </button>
          <button
            className={cn(
              "flex items-center gap-2.5 rounded-[10px] border border-black/[0.07] bg-white p-[11px] text-left dark:border-white/[0.07] dark:bg-[#1d1d1d]",
              isCircle && "border-black/30 bg-[#eeeeee] dark:border-white/30 dark:bg-[#303030]",
            )}
            type="button"
            onClick={() => setIsCircle(true)}
          >
            <CircleIcon aria-hidden="true" className="size-7 flex-none" />
            <span className="flex flex-col gap-0.5"><strong>Circle</strong><small className="text-dim text-[11px]">A shared workspace</small></span>
          </button>
        </div>

        <form className={cn("flex min-h-0 flex-col gap-5", isCircle && "gap-0")} onSubmit={handleSubmit}>
          {!isCircle ? (
            <div
              className="min-h-0 overflow-y-auto px-1 pb-1 [&_[data-slot=color-grid]]:max-w-none [&_[data-slot=color-grid]]:gap-3 [&_[data-slot=color-grid]_button]:w-[26px] [&_[data-slot=shape-grid]]:mb-[18px] [&_[data-slot=shape-grid]]:grid-cols-8 [&_[data-slot=shape-grid]]:gap-1.5 [&_[data-slot=shape-grid]_button]:h-11 max-[540px]:[&_[data-slot=shape-grid]]:grid-cols-4"
            >
              <WispSettingsFields settings={settings} onChange={(changes) => setSettings((current) => ({ ...current, ...changes }))} />
            </div>
          ) : (
            <FieldGroup
              className="min-h-0 gap-4 overflow-y-auto px-5 pt-[26px] pb-5 [&_[data-slot=field-label]]:pl-2.5 [&_[data-slot=field-label]]:text-dim [&_[data-slot=field-label]]:text-[15px] [&_[data-slot=field-label]]:font-normal"
            >
              <Field>
                <FieldLabel htmlFor="agent-name">Name</FieldLabel>
                <Input id="agent-name" className="h-[42px] rounded-[11px] px-3.5 text-base" autoFocus maxLength={64} placeholder="Ex: Project Falcon" required value={name} onChange={(event) => setSettings((current) => ({ ...current, name: event.currentTarget.value }))} />
              </Field>
              <Field>
                <FieldLabel id="circle-wisps-label">Add Wisps</FieldLabel>
                <div className="overflow-hidden rounded-[11px] border border-border" role="group" aria-labelledby="circle-wisps-label">
                  <div className="flex min-h-16 max-h-[132px] flex-wrap items-center gap-2 overflow-y-auto border-b border-border p-3" aria-label="Selected Wisps">
                    {selectedWisps.length ? selectedWisps.map((chat) => (
                      <span className="inline-flex max-w-full items-center gap-[7px] rounded-full bg-[#f0f0f0] px-[9px] py-[5px] dark:bg-[#292929]" key={chat.id}>
                        <ChatAvatar chat={chat} size="sm" />
                        <span className="min-w-0 truncate">{chat.name}</span>
                        <button className="inline-flex size-[22px] flex-none items-center justify-center rounded-full border-0 bg-transparent text-dim hover:bg-[#dedede] dark:hover:bg-[#3b3b3b] [&_svg]:size-3.5" type="button" aria-label={`Remove ${chat.name}`} onClick={() => setMemberIds((current) => current.filter((id) => id !== chat.id))}><XIcon aria-hidden="true" /></button>
                      </span>
                    )) : <span className="p-2 text-dim text-[13px]">Select Wisps to add to this circle</span>}
                  </div>
                  <div className="min-h-[208px] max-h-[260px] overflow-y-auto py-[3px]">
                    {availableWisps.map((chat) => (
                      <label className="flex min-h-[46px] cursor-pointer items-center gap-3 px-3.5 py-[7px] hover:bg-[#f0f0f0] focus-within:bg-[#f0f0f0] dark:hover:bg-[#292929] dark:focus-within:bg-[#292929]" key={chat.id}>
                        <Checkbox.Root
                          className="inline-flex size-5 flex-none items-center justify-center rounded-[5px] border border-border bg-background focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-2 data-checked:border-foreground data-checked:bg-foreground data-checked:text-background [&_svg]:size-[15px]"
                          checked={memberIds.includes(chat.id)}
                          onCheckedChange={(checked) => setMemberIds((current) => checked ? [...current, chat.id] : current.filter((id) => id !== chat.id))}
                        >
                          <Checkbox.Indicator><CheckIcon aria-hidden="true" /></Checkbox.Indicator>
                        </Checkbox.Root>
                        <ChatAvatar chat={chat} />
                        <span className="min-w-0 text-base [overflow-wrap:anywhere]">{chat.name}</span>
                      </label>
                    ))}
                    {!availableWisps.length ? <p className="p-2 text-dim text-[13px]">No Wisps yet. You can create an empty circle.</p> : null}
                  </div>
                </div>
              </Field>
            </FieldGroup>
          )}
          <DialogFooter className={cn("flex-none", isCircle && "flex-row justify-end border-t border-border px-5 py-4 [&_button]:h-10 [&_button]:min-w-[78px] [&_button]:rounded-[11px] [&_button]:text-base")}>
            {!isCircle ? <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose> : null}
            <Button type="submit" disabled={!name.trim()}>{isCircle ? "Create" : "Create Wisp"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { CreateAgentDialog };
export type { NewAgent };
