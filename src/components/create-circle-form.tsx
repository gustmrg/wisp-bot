import type { WispChat } from "@/chat-data";
import { CircleMemberPicker } from "@/components/circle-member-picker";
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
        <CircleMemberPicker availableWisps={availableWisps} selectedIds={memberIds} onChange={onMemberIdsChange} />
      </Field>
    </FieldGroup>
  );
}
