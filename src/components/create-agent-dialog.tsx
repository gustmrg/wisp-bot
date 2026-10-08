import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { PlusIcon } from "lucide-react";

import type { AiSettingsView, ModelSelection } from "../../shared/contracts";
import { DEFAULT_WISP_APPEARANCE } from "../../shared/wisp-appearance";
import type { NewWisp } from "@/chat-data";
import {
  CreateWispModelSection,
  createDefaultWispModelDraft,
  isWispModelDraftInvalid,
  resolveWispModelSelection,
  type WispModelDraft,
} from "@/components/create-wisp-model-section";
import { CreateWispForm, type CreateWispStep } from "@/components/create-wisp-form";
import type { WispSettingsDraft } from "@/components/wisp-settings-fields";
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

interface CreateAgentDialogProps {
  onCreate: (
    wisp: NewWisp,
    options: { notifyOnUpdatesEnabled: boolean; model: ModelSelection | null },
  ) => Promise<boolean> | void;
  trigger?: ReactElement;
}

const DEFAULT_WISP: WispSettingsDraft = {
  name: "",
  role: "",
  soul: "",
  color: AVATAR_COLORS.find((color) => color.id === "violet")?.value,
  appearance: DEFAULT_WISP_APPEARANCE,
  notifyOnUpdatesEnabled: true,
};

function CreateAgentDialog({ onCreate, trigger }: CreateAgentDialogProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<CreateWispStep>("identity");
  const stepRef = useRef<HTMLDivElement>(null);
  const focusStep = useRef<CreateWispStep | null>(null);
  const [settings, setSettings] = useState<WispSettingsDraft>(DEFAULT_WISP);
  const [modelDraft, setModelDraft] = useState<WispModelDraft>(createDefaultWispModelDraft);
  const [modelView, setModelView] = useState<AiSettingsView | null>(null);
  const [modelLoadError, setModelLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { name, soul, color } = settings;
  const modelInvalid = isWispModelDraftInvalid(modelDraft, modelView);

  // Moving between steps unmounts the button that had focus, so hand it to the new step's first field.
  useEffect(() => {
    if (focusStep.current !== step) return;
    focusStep.current = null;
    stepRef.current?.querySelector<HTMLElement>("input, textarea")?.focus();
  }, [step]);

  function goToStep(nextStep: CreateWispStep) {
    focusStep.current = nextStep;
    setStep(nextStep);
  }

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
    setStep("identity");
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
          name: trimmedName,
          role: settings.role.trim(),
          soul: soul.trim(),
          appearance: settings.appearance,
          ...(color === undefined ? {} : { color }),
          ...(settings.avatarImage === undefined ? {} : { avatarImage: settings.avatarImage }),
        },
        { notifyOnUpdatesEnabled: settings.notifyOnUpdatesEnabled, model: resolveWispModelSelection(modelDraft) },
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
              className="w-full justify-center gap-2 px-3 text-base group-data-[collapsed=true]/sidebar:w-9 group-data-[collapsed=true]/sidebar:px-0"
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
          <DialogDescription>
            {step === "identity" ? "Step 1 of 2 · Appearance and name" : "Step 2 of 2 · Soul and behavior"}
          </DialogDescription>
        </DialogHeader>

        <form className="flex min-h-0 flex-col gap-5" onSubmit={(event) => void handleSubmit(event)}>
          <CreateWispForm
            ref={stepRef}
            step={step}
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
          {step === "identity" && (modelLoadError || (modelView && modelInvalid)) ? (
            <p className="text-xs text-dim" role="status">
              This Wisp needs a model before it can be created. Choose one in the next step.
            </p>
          ) : null}
          {error ? (
            <p className="text-base text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter className="flex-none">
            {step === "identity" ? (
              <>
                <DialogClose render={<Button variant="outline" type="button" disabled={saving} />}>Cancel</DialogClose>
                <Button
                  variant="outline"
                  type="button"
                  disabled={!name.trim() || saving}
                  onClick={() => goToStep("behavior")}
                >
                  Next
                </Button>
              </>
            ) : (
              <Button variant="outline" type="button" disabled={saving} onClick={() => goToStep("identity")}>
                Back
              </Button>
            )}
            <Button type="submit" disabled={!name.trim() || saving || modelInvalid}>
              {saving ? "Creating…" : "Create Wisp"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { CreateAgentDialog };
