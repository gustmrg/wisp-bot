import { useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { Checkbox } from "@base-ui/react/checkbox";
import { CheckIcon, HashIcon, PlusIcon, XIcon } from "lucide-react";

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
  isGroup: false,
  notifyOnUpdatesEnabled: true,
};

function CreateAgentDialog({ chats, onCreate, trigger }: CreateAgentDialogProps) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<AgentSettings>(DEFAULT_WISP);
  const { name, description, color } = settings;
  const [isGroup, setIsGroup] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const availableWisps = Object.values(chats).filter((chat) => !chat.isGroup);
  const selectedWisps = availableWisps.filter((chat) => memberIds.includes(chat.id));

  function resetForm() {
    setSettings(DEFAULT_WISP);
    setIsGroup(false);
    setMemberIds([]);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;

    onCreate({
      name: trimmedName,
      label: isGroup ? "Channel" : settings.label.trim(),
      description: isGroup ? "" : description.trim(),
      color,
      shape: isGroup ? "circle" : settings.shape,
      avatarImage: isGroup ? undefined : settings.avatarImage,
      isGroup,
      ...(isGroup ? { memberIds: selectedWisps.map((chat) => chat.id) } : {}),
      notifyOnUpdatesEnabled: isGroup || settings.notifyOnUpdatesEnabled,
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
            <Button variant="ghost" size="icon-sm" type="button" aria-label="New Wisp or channel" />
          )
        }
      >
        {trigger ? null : <PlusIcon />}
      </DialogTrigger>

      <DialogContent className={isGroup ? "create-dialog channel-dialog" : "create-dialog"}>
        <DialogHeader>
          <DialogTitle>{isGroup ? "New channel" : "Create new"}</DialogTitle>
          <DialogDescription className={isGroup ? "sr-only" : undefined}>{isGroup ? "Name your channel and choose the Wisps to add." : "Create a Wisp for focused work or a channel for a shared project."}</DialogDescription>
        </DialogHeader>

        {!isGroup ? <div className="create-kind" role="group" aria-label="Creation type">
          <button className={!isGroup ? "selected" : ""} type="button" onClick={() => setIsGroup(false)}>
            <Wisp color={color} shape={settings.shape} name={name || "New Wisp"} size="sm" />
            <span><strong>Wisp</strong><small>An autonomous teammate</small></span>
          </button>
          <button className={isGroup ? "selected" : ""} type="button" onClick={() => setIsGroup(true)}>
            <HashIcon aria-hidden="true" />
            <span><strong>Channel</strong><small>A shared workspace</small></span>
          </button>
        </div> : null}

        <form className="create-form" onSubmit={handleSubmit}>
          {!isGroup ? <div className="wisp-create-fields"><WispSettingsFields settings={settings} onChange={(changes) => setSettings((current) => ({ ...current, ...changes }))} /></div> : <FieldGroup className="channel-form-body">
            <Field>
              <FieldLabel htmlFor="agent-name">Name</FieldLabel>
              <Input id="agent-name" autoFocus maxLength={64} placeholder="Ex: Project Falcon" required value={name} onChange={(event) => setSettings((current) => ({ ...current, name: event.currentTarget.value }))} />
            </Field>
            <Field>
              <FieldLabel id="channel-wisps-label">Add Wisps</FieldLabel>
              <div className="channel-wisp-picker" role="group" aria-labelledby="channel-wisps-label">
                <div className="channel-selected-wisps" aria-label="Selected Wisps">
                  {selectedWisps.length ? selectedWisps.map((chat) => (
                    <span className="channel-wisp-chip" key={chat.id}>
                      <ChatAvatar chat={chat} size="sm" />
                      <span>{chat.name}</span>
                      <button type="button" aria-label={`Remove ${chat.name}`} onClick={() => setMemberIds((current) => current.filter((id) => id !== chat.id))}><XIcon aria-hidden="true" /></button>
                    </span>
                  )) : <span className="channel-picker-placeholder">Select Wisps to add to this channel</span>}
                </div>
                <div className="channel-wisp-options">
                  {availableWisps.map((chat) => (
                    <label className="channel-wisp-option" key={chat.id}>
                      <Checkbox.Root className="channel-wisp-checkbox" checked={memberIds.includes(chat.id)} onCheckedChange={(checked) => setMemberIds((current) => checked ? [...current, chat.id] : current.filter((id) => id !== chat.id))}>
                        <Checkbox.Indicator><CheckIcon aria-hidden="true" /></Checkbox.Indicator>
                      </Checkbox.Root>
                      <ChatAvatar chat={chat} />
                      <span>{chat.name}</span>
                    </label>
                  ))}
                  {!availableWisps.length ? <p className="channel-picker-placeholder">No Wisps yet. You can create an empty channel.</p> : null}
                </div>
              </div>
            </Field>
          </FieldGroup>}
          <DialogFooter>
            {!isGroup ? <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose> : null}
            <Button type="submit" disabled={!name.trim()}>{isGroup ? "Create" : "Create Wisp"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { CreateAgentDialog };
export type { NewAgent };
