import { useEffect, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { PlusIcon } from "lucide-react";

import type { AiSettingsView, ModelSelection } from "../../shared/contracts";
import type { NewWisp, WispChat } from "@/chat-data";
import {
  CreateWispModelSection,
  createDefaultWispModelDraft,
  isWispModelDraftInvalid,
  resolveWispModelSelection,
  type WispModelDraft,
} from "@/components/create-wisp-model-section";
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
import { storedWispTone } from "../../shared/wisp-tone";

type NewAgent = NewWisp;

interface CreateAgentDialogProps {
  onCreate: (agent: NewAgent, model: ModelSelection | null) => Promise<boolean> | void;
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
  const [modelDraft, setModelDraft] = useState<WispModelDraft>(createDefaultWispModelDraft);
  const [modelView, setModelView] = useState<AiSettingsView | null>(null);
  const [modelLoadError, setModelLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { name, description, color } = settings;

  useEffect(() => {
    if (!open || modelView) return;
    let active = true;
    void window.wisp
      .getAiSettings()
      .then((result) => {
        if (!active) return;
        if (!result.ok) throw new Error(result.error.message);
        setModelView(result.value);
      })
      .catch((cause) => {
        if (active) setModelLoadError(cause instanceof Error ? cause.message : "Could not load model settings.");
      });
    return () => {
      active = false;
    };
  }, [open, modelView]);

  function resetForm() {
    setSettings(DEFAULT_WISP);
    setModelDraft(createDefaultWispModelDraft());
    setModelView(null);
    setModelLoadError("");
    setError("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || saving) return;

    setSaving(true);
    setError("");
    try {
      const created = await onCreate(
        {
          kind: "wisp",
          name: trimmedName,
          label: settings.label.trim(),
          description: description.trim(),
          color,
          shape: settings.shape,
          avatarImage: settings.avatarImage,
          notifyOnUpdatesEnabled: settings.notifyOnUpdatesEnabled,
          tone: storedWispTone(settings.tone),
        },
        resolveWispModelSelection(modelDraft),
      );
      if (created === false) {
        setError("Could not create this Wisp. Your draft is still here; try again.");
        return;
      }
      setOpen(false);
      resetForm();
    } catch {
      setError("Could not create this Wisp. Your draft is still here; try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (saving) return;
        setOpen(nextOpen);
        if (!nextOpen) resetForm();
      }}
    >
      <DialogTrigger
        render={
          trigger ?? (
            <Button
              className="w-full justify-center gap-2 px-3 text-sm group-data-[collapsed=true]/sidebar:w-9 group-data-[collapsed=true]/sidebar:px-0"
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

      <DialogContent
        mobileFullscreen
        className="create-wisp-dialog flex max-h-[calc(100dvh-32px)] max-w-[530px] flex-col"
      >
        <DialogHeader className="flex-none">
          <DialogTitle>Create new Wisp</DialogTitle>
          <DialogDescription>Create a Wisp for focused work.</DialogDescription>
        </DialogHeader>

        <form className="flex min-h-0 flex-col gap-5" onSubmit={(event) => void handleSubmit(event)}>
          <CreateWispForm
            settings={settings}
            onChange={(changes) => setSettings((current) => ({ ...current, ...changes }))}
          >
            <CreateWispModelSection
              view={modelView}
              loadError={modelLoadError}
              draft={modelDraft}
              onChange={setModelDraft}
            />
          </CreateWispForm>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter className="flex-none">
            <DialogClose render={<Button variant="outline" type="button" disabled={saving} />}>Cancel</DialogClose>
            <Button type="submit" disabled={!name.trim() || saving || isWispModelDraftInvalid(modelDraft, modelView)}>
              {saving ? "Creating…" : "Create Wisp"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { CreateAgentDialog };
export type { NewAgent };
