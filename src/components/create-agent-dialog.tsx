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

      <DialogContent className={isCircle ? "create-dialog circle-dialog" : "create-dialog"}>
        <DialogHeader>
          <DialogTitle>{isCircle ? "New circle" : "Create new"}</DialogTitle>
          <DialogDescription className={isCircle ? "sr-only" : undefined}>{isCircle ? "Name your circle and choose the Wisps to add." : "Create a Wisp for focused work or a circle for a shared project."}</DialogDescription>
        </DialogHeader>

        <div className="create-kind" role="group" aria-label="Creation type">
          <button className={!isCircle ? "selected" : ""} type="button" onClick={() => setIsCircle(false)}>
            <Wisp color={color} shape={settings.shape} name={name || "New Wisp"} size="sm" />
            <span><strong>Wisp</strong><small>An autonomous teammate</small></span>
          </button>
          <button className={isCircle ? "selected" : ""} type="button" onClick={() => setIsCircle(true)}>
            <CircleIcon aria-hidden="true" />
            <span><strong>Circle</strong><small>A shared workspace</small></span>
          </button>
        </div>

        <form className="create-form" onSubmit={handleSubmit}>
          {!isCircle ? <div className="wisp-create-fields"><WispSettingsFields settings={settings} onChange={(changes) => setSettings((current) => ({ ...current, ...changes }))} /></div> : <FieldGroup className="circle-form-body">
            <Field>
              <FieldLabel htmlFor="agent-name">Name</FieldLabel>
              <Input id="agent-name" autoFocus maxLength={64} placeholder="Ex: Project Falcon" required value={name} onChange={(event) => setSettings((current) => ({ ...current, name: event.currentTarget.value }))} />
            </Field>
            <Field>
              <FieldLabel id="circle-wisps-label">Add Wisps</FieldLabel>
              <div className="circle-wisp-picker" role="group" aria-labelledby="circle-wisps-label">
                <div className="circle-selected-wisps" aria-label="Selected Wisps">
                  {selectedWisps.length ? selectedWisps.map((chat) => (
                    <span className="circle-wisp-chip" key={chat.id}>
                      <ChatAvatar chat={chat} size="sm" />
                      <span>{chat.name}</span>
                      <button type="button" aria-label={`Remove ${chat.name}`} onClick={() => setMemberIds((current) => current.filter((id) => id !== chat.id))}><XIcon aria-hidden="true" /></button>
                    </span>
                  )) : <span className="circle-picker-placeholder">Select Wisps to add to this circle</span>}
                </div>
                <div className="circle-wisp-options">
                  {availableWisps.map((chat) => (
                    <label className="circle-wisp-option" key={chat.id}>
                      <Checkbox.Root className="circle-wisp-checkbox" checked={memberIds.includes(chat.id)} onCheckedChange={(checked) => setMemberIds((current) => checked ? [...current, chat.id] : current.filter((id) => id !== chat.id))}>
                        <Checkbox.Indicator><CheckIcon aria-hidden="true" /></Checkbox.Indicator>
                      </Checkbox.Root>
                      <ChatAvatar chat={chat} />
                      <span>{chat.name}</span>
                    </label>
                  ))}
                  {!availableWisps.length ? <p className="circle-picker-placeholder">No Wisps yet. You can create an empty circle.</p> : null}
                </div>
              </div>
            </Field>
          </FieldGroup>}
          <DialogFooter>
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
