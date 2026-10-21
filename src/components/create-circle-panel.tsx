import { useEffect, useState, type FormEvent } from "react";

import { circleLeadId, withCircleLead } from "../../shared/conversations";
import type { NewCircle, Wisp, WispId } from "@/chat-data";
import { CircleLeadPicker } from "@/components/circle-lead-picker";
import { CircleMemberPicker } from "@/components/circle-member-picker";
import { Button } from "@/components/ui/button";
import type { CreatePanelStatus } from "@/components/create-wisp-panel";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface CreateCirclePanelProps {
  /** The Wisps that can join. */
  wisps: ReadonlyArray<Wisp>;
  /** Resolves true once the circle exists. */
  onCreate: (circle: NewCircle) => Promise<boolean>;
  onStatusChange: (status: CreatePanelStatus) => void;
  /** Called once the circle exists. */
  onDone: () => void;
}

const DESCRIPTION = "Talk with several Wisps in one conversation.";

/** Creates a circle: its name, purpose, members, and lead (ADR 011). The dialog around it resets it by remounting it. */
function CreateCirclePanel({ wisps, onCreate, onStatusChange, onDone }: CreateCirclePanelProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // In order, the lead first.
  const [memberIds, setMemberIds] = useState<WispId[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const available = new Map(wisps.map((wisp) => [wisp.id, wisp]));
  const members = memberIds.flatMap((id) => {
    const wisp = available.get(id);
    return wisp ? [wisp] : [];
  });
  const canCreate = Boolean(name.trim()) && members.length > 0 && !saving;

  useEffect(() => {
    onStatusChange({ description: DESCRIPTION, saving, done: false });
  }, [onStatusChange, saving]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;
    setSaving(true);
    setError("");
    try {
      const created = await onCreate({
        kind: "circle",
        name: name.trim(),
        label: "",
        description: description.trim(),
        notifyOnUpdatesEnabled: true,
        memberIds: members.map(({ id }) => id),
      });
      if (!created) {
        setError("Could not create this circle. Your draft is still here; try again.");
        return;
      }
      onDone();
    } catch {
      setError("Could not create this circle. Your draft is still here; try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-1"
      onSubmit={(event) => void handleSubmit(event)}
    >
      <Field>
        <FieldLabel htmlFor="create-circle-name">Name</FieldLabel>
        <Input
          id="create-circle-name"
          value={name}
          maxLength={64}
          placeholder="Launch team"
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="create-circle-description">Purpose (optional)</FieldLabel>
        <Textarea
          id="create-circle-description"
          rows={3}
          value={description}
          maxLength={240}
          placeholder="What this circle works on. Its Wisps read it."
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
      </Field>
      <CircleMemberPicker
        label="Wisps"
        availableWisps={wisps}
        selectedIds={memberIds}
        onChange={(ids) => setMemberIds(ids)}
      />
      <CircleLeadPicker
        members={members}
        leadId={circleLeadId({ memberIds: members.map(({ id }) => id) })}
        onChange={(leadId) => setMemberIds((current) => withCircleLead(current, leadId))}
      />
      {error ? (
        <p className="m-0 text-base text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <DialogFooter className="mt-auto flex-none">
        <DialogClose render={<Button variant="outline" type="button" disabled={saving} />}>Cancel</DialogClose>
        <Button type="submit" disabled={!canCreate}>
          {saving ? "Creating…" : "Create circle"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export { CreateCirclePanel };
export type { CreateCirclePanelProps };
