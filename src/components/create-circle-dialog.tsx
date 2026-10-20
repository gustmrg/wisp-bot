import { useState, type FormEvent } from "react";

import { circleLeadId, withCircleLead } from "../../shared/conversations";
import type { NewCircle, Wisp, WispId } from "@/chat-data";
import { CircleLeadPicker } from "@/components/circle-lead-picker";
import { CircleMemberPicker } from "@/components/circle-member-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface CreateCircleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Wisps that can join. */
  wisps: ReadonlyArray<Wisp>;
  /** Resolves true once the circle exists. */
  onCreate: (circle: NewCircle) => Promise<boolean>;
}

/** Creates a circle: its name, purpose, members, and lead (ADR 011). */
function CreateCircleDialog({ open, onOpenChange, wisps, onCreate }: CreateCircleDialogProps) {
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

  function reset() {
    setName("");
    setDescription("");
    setMemberIds([]);
    setError("");
  }

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
      onOpenChange(false);
      reset();
    } catch {
      setError("Could not create this circle. Your draft is still here; try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (saving) return;
        onOpenChange(nextOpen);
        if (!nextOpen) reset();
      }}
    >
      <DialogContent mobileFullscreen className="flex max-h-[calc(100dvh-32px)] max-w-[530px] flex-col">
        <DialogHeader className="flex-none">
          <DialogTitle>Create new circle</DialogTitle>
          <DialogDescription>Talk with several Wisps in one conversation.</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col gap-5 overflow-y-auto px-1"
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
          <DialogFooter className="flex-none">
            <DialogClose render={<Button variant="outline" type="button" disabled={saving} />}>Cancel</DialogClose>
            <Button type="submit" disabled={!canCreate}>
              {saving ? "Creating…" : "Create circle"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { CreateCircleDialog };
export type { CreateCircleDialogProps };
