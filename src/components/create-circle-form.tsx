import { Checkbox } from "@base-ui/react/checkbox";
import { CheckIcon, XIcon } from "lucide-react";

import type { WispChat } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

interface CreateCircleFormProps {
  name: string;
  availableWisps: ReadonlyArray<WispChat>;
  memberIds: ReadonlyArray<string>;
  onNameChange: (name: string) => void;
  onMemberIdsChange: (memberIds: string[]) => void;
}

export function CreateCircleForm({
  name,
  availableWisps,
  memberIds,
  onNameChange,
  onMemberIdsChange,
}: CreateCircleFormProps) {
  const selectedWisps = availableWisps.filter((chat) => memberIds.includes(chat.id));
  const toggleMember = (id: string, selected: boolean) =>
    onMemberIdsChange(selected ? [...memberIds, id] : memberIds.filter((memberId) => memberId !== id));

  return (
    <FieldGroup className="min-h-0 gap-4 overflow-y-auto px-5 pt-[26px] pb-5 [&_[data-slot=field-label]]:pl-2.5 [&_[data-slot=field-label]]:text-dim [&_[data-slot=field-label]]:text-[15px] [&_[data-slot=field-label]]:font-normal">
      <Field>
        <FieldLabel htmlFor="agent-name">Name</FieldLabel>
        <Input
          id="agent-name"
          className="h-[42px] rounded-[11px] px-3.5 text-base"
          autoFocus
          maxLength={64}
          placeholder="Ex: Project Falcon"
          required
          value={name}
          onChange={(event) => onNameChange(event.currentTarget.value)}
        />
      </Field>
      <Field>
        <FieldLabel id="circle-wisps-label">Add Wisps</FieldLabel>
        <div
          className="overflow-hidden rounded-[11px] border border-border"
          role="group"
          aria-labelledby="circle-wisps-label"
        >
          <div
            className="flex min-h-16 max-h-[132px] flex-wrap items-center gap-2 overflow-y-auto border-b border-border p-3"
            aria-label="Selected Wisps"
          >
            {selectedWisps.length ? (
              selectedWisps.map((chat) => (
                <span
                  className="inline-flex max-w-full items-center gap-[7px] rounded-full bg-[#f0f0f0] px-[9px] py-[5px] dark:bg-[#292929]"
                  key={chat.id}
                >
                  <ChatAvatar chat={chat} size="sm" />
                  <span className="min-w-0 truncate">{chat.name}</span>
                  <button
                    className="inline-flex size-[22px] flex-none items-center justify-center rounded-full border-0 bg-transparent text-dim hover:bg-[#dedede] dark:hover:bg-[#3b3b3b] [&_svg]:size-3.5"
                    type="button"
                    aria-label={`Remove ${chat.name}`}
                    onClick={() => toggleMember(chat.id, false)}
                  >
                    <XIcon aria-hidden="true" />
                  </button>
                </span>
              ))
            ) : (
              <span className="p-2 text-dim text-[13px]">Select Wisps to add to this circle</span>
            )}
          </div>
          <div className="min-h-[208px] max-h-[260px] overflow-y-auto py-[3px]">
            {availableWisps.map((chat) => (
              <label
                className="flex min-h-[46px] cursor-pointer items-center gap-3 px-3.5 py-[7px] hover:bg-[#f0f0f0] focus-within:bg-[#f0f0f0] dark:hover:bg-[#292929] dark:focus-within:bg-[#292929]"
                key={chat.id}
              >
                <Checkbox.Root
                  className="inline-flex size-5 flex-none items-center justify-center rounded-[5px] border border-border bg-background focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-2 data-checked:border-foreground data-checked:bg-foreground data-checked:text-background [&_svg]:size-[15px]"
                  checked={memberIds.includes(chat.id)}
                  onCheckedChange={(checked) => toggleMember(chat.id, checked)}
                >
                  <Checkbox.Indicator>
                    <CheckIcon aria-hidden="true" />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                <ChatAvatar chat={chat} />
                <span className="min-w-0 text-base [overflow-wrap:anywhere]">{chat.name}</span>
              </label>
            ))}
            {!availableWisps.length ? (
              <p className="p-2 text-dim text-[13px]">No Wisps yet. You can create an empty circle.</p>
            ) : null}
          </div>
        </div>
      </Field>
    </FieldGroup>
  );
}
