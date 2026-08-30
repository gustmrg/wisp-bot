import { useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { HashIcon, PlusIcon } from "lucide-react";

import type { AgentSettings } from "@/chat-data";
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
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AVATAR_COLORS, Wisp } from "@/components/wisp";

type NewAgent = Omit<AgentSettings, "id" | "isActive" | "unread">;

interface CreateAgentDialogProps {
  onCreate: (agent: NewAgent) => void;
  trigger?: ReactElement;
}

const DEFAULT_COLOR = AVATAR_COLORS[6].value;

function CreateAgentDialog({ onCreate, trigger }: CreateAgentDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [isGroup, setIsGroup] = useState(false);

  function resetForm() {
    setName("");
    setDescription("");
    setColor(DEFAULT_COLOR);
    setIsGroup(false);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;

    onCreate({
      name: trimmedName,
      label: isGroup ? "Channel" : "",
      description: description.trim(),
      color,
      shape: isGroup ? "circle" : "hexagon",
      isGroup,
      notifyOnUpdatesEnabled: true,
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

      <DialogContent className="create-dialog">
        <DialogHeader>
          <DialogTitle>Create new</DialogTitle>
          <DialogDescription>Create a Wisp for focused work or a channel for a shared project.</DialogDescription>
        </DialogHeader>

        <div className="create-kind" role="group" aria-label="Creation type">
          <button className={!isGroup ? "selected" : ""} type="button" onClick={() => setIsGroup(false)}>
            <Wisp color={color} name={name || "New Wisp"} size="sm" />
            <span><strong>Wisp</strong><small>An autonomous teammate</small></span>
          </button>
          <button className={isGroup ? "selected" : ""} type="button" onClick={() => setIsGroup(true)}>
            <HashIcon aria-hidden="true" />
            <span><strong>Channel</strong><small>A shared workspace</small></span>
          </button>
        </div>

        <form className="create-form" onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="agent-name">Name</FieldLabel>
              <Input id="agent-name" autoFocus maxLength={64} placeholder={isGroup ? "e.g. Product launch" : "e.g. Research assistant"} required value={name} onChange={(event) => setName(event.currentTarget.value)} />
            </Field>
            {!isGroup ? (
              <Field>
                <FieldLabel id="agent-color-label">Color</FieldLabel>
                <ToggleGroup aria-labelledby="agent-color-label" value={[color]} onValueChange={(colors) => colors[0] && setColor(colors[0])}>
                  {AVATAR_COLORS.map((avatarColor) => (
                    <ToggleGroupItem aria-label={avatarColor.label} key={avatarColor.id} value={avatarColor.value}>
                      <span aria-hidden="true" className="color-swatch" style={{ backgroundColor: avatarColor.value }} />
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="agent-description">Description</FieldLabel>
              <Textarea id="agent-description" maxLength={240} placeholder="What should this workspace take care of?" value={description} onChange={(event) => setDescription(event.currentTarget.value)} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!name.trim()}>Create {isGroup ? "channel" : "Wisp"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { CreateAgentDialog };
export type { NewAgent };
