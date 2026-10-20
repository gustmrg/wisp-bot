import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { ClipboardPasteIcon } from "lucide-react";

import type { AiSettingsView, ModelSelection } from "../../shared/contracts";
import type { WispSetupView } from "../../shared/execution";
import { DEFAULT_WISP_APPEARANCE } from "../../shared/wisp-appearance";
import type { NewWisp } from "@/chat-data";
import {
  CreateWispModelSection,
  createDefaultWispModelDraft,
  isWispModelDraftInvalid,
  resolveWispModelSelection,
  wispModelDraftFromTemplate,
  type WispModelDraft,
} from "@/components/create-wisp-model-section";
import { CreateWispForm, type CreateWispStep } from "@/components/create-wisp-form";
import {
  CreateWispSetupSection,
  DEFAULT_WISP_SETUP,
  applyWispSetup,
  type WispSetupDraft,
} from "@/components/create-wisp-setup-section";
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
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { AVATAR_COLORS } from "@/lib/wisp-appearance";
import { parseWispTemplate } from "@/lib/wisp-template";

interface CreateAgentDialogProps {
  /** Resolves with the new Wisp's conversation ID, or null when it could not be created. */
  onCreate: (
    wisp: NewWisp,
    options: { notifyOnUpdatesEnabled: boolean; model: ModelSelection | null },
  ) => Promise<string | null>;
  /** The button that opens the dialog; without it, `open` and `onOpenChange` control it. */
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const STEPS: ReadonlyArray<CreateWispStep> = ["identity", "behavior", "setup"];
const STEP_TITLES: Record<CreateWispStep, string> = {
  identity: "Appearance and name",
  behavior: "Soul and behavior",
  setup: "Workspace and commands",
};

const DEFAULT_WISP: WispSettingsDraft = {
  name: "",
  role: "",
  soul: "",
  color: AVATAR_COLORS.find((color) => color.id === "violet")?.value,
  appearance: DEFAULT_WISP_APPEARANCE,
  notifyOnUpdatesEnabled: true,
};

function CreateAgentDialog({ onCreate, trigger, open: controlledOpen, onOpenChange }: CreateAgentDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  function setOpen(nextOpen: boolean) {
    setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }
  const [step, setStep] = useState<CreateWispStep>("identity");
  const stepRef = useRef<HTMLDivElement>(null);
  const focusStep = useRef<CreateWispStep | null>(null);
  const [settings, setSettings] = useState<WispSettingsDraft>(DEFAULT_WISP);
  const [modelDraft, setModelDraft] = useState<WispModelDraft>(createDefaultWispModelDraft);
  const [modelView, setModelView] = useState<AiSettingsView | null>(null);
  const [modelLoadError, setModelLoadError] = useState("");
  const [modelNotice, setModelNotice] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [templateText, setTemplateText] = useState("");
  const [importError, setImportError] = useState("");
  const [imported, setImported] = useState(false);
  const [setupDraft, setSetupDraft] = useState<WispSetupDraft>(DEFAULT_WISP_SETUP);
  const [setupView, setSetupView] = useState<WispSetupView | null>(null);
  const [setupLoadError, setSetupLoadError] = useState("");
  const [setupUnsupported, setSetupUnsupported] = useState(false);
  // Set when the Wisp exists but part of its setup could not be applied: the dialog only reports it.
  const [setupFailure, setSetupFailure] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { name, soul, color } = settings;
  const modelInvalid = isWispModelDraftInvalid(modelDraft, modelView);
  const stepIndex = STEPS.indexOf(step);

  // Moving between steps unmounts the button that had focus, so hand it to the new step's first field.
  useEffect(() => {
    if (focusStep.current !== step) return;
    focusStep.current = null;
    const fields = stepRef.current;
    (
      fields?.querySelector<HTMLElement>('textarea, input:not([aria-hidden="true"]):not([tabindex="-1"])') ??
      fields?.querySelector<HTMLElement>("button")
    )?.focus();
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

  useEffect(() => {
    if (!open || setupView || setupLoadError || setupUnsupported) return;
    let active = true;
    void window.wisp
      .getWispSetup()
      .then((result) => {
        if (!active) return;
        if (result.ok) setSetupView(result.value);
        else if (result.error.code === "unsupported") setSetupUnsupported(true);
        else setSetupLoadError(result.error.message);
      })
      .catch(() => {
        if (active) setSetupLoadError("Could not check the server.");
      });
    return () => {
      active = false;
    };
  }, [open, setupView, setupLoadError, setupUnsupported]);

  function resetForm() {
    setStep("identity");
    setSettings(DEFAULT_WISP);
    setModelDraft(createDefaultWispModelDraft());
    setModelView(null);
    setModelLoadError("");
    setModelNotice("");
    closeImport();
    setImported(false);
    setSetupDraft(DEFAULT_WISP_SETUP);
    setSetupView(null);
    setSetupLoadError("");
    setSetupUnsupported(false);
    setSetupFailure("");
    setError("");
  }

  function closeImport() {
    setImportOpen(false);
    setTemplateText("");
    setImportError("");
  }

  /** Fills the form from a template; the appearance stays the person's choice. */
  function applyTemplate() {
    const result = parseWispTemplate(templateText);
    if (!result.ok) {
      setImportError(result.error);
      return;
    }
    const { template } = result;
    setSettings((current) => ({ ...current, name: template.name, role: template.role, soul: template.soul }));
    const model = wispModelDraftFromTemplate(template.model, modelView);
    setModelDraft(model.draft);
    setModelNotice(model.notice);
    closeImport();
    setImported(true);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || saving) return;

    setSaving(true);
    setError("");
    try {
      const conversationId = await onCreate(
        {
          name: trimmedName,
          role: settings.role.trim(),
          soul: soul.trim(),
          appearance: settings.appearance,
          ...(color === undefined ? {} : { color }),
        },
        { notifyOnUpdatesEnabled: settings.notifyOnUpdatesEnabled, model: resolveWispModelSelection(modelDraft) },
      );
      if (!conversationId) {
        setError("Could not create this Wisp. Your draft is still here; try again.");
        return;
      }
      const failed = await applyWispSetup(conversationId, setupDraft);
      if (failed) {
        setSetupFailure(
          `${trimmedName} was created, but ${failed} could not be set. Change it in the Wisp's settings.`,
        );
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
      {trigger ? <DialogTrigger render={trigger} /> : null}

      <DialogContent
        mobileFullscreen
        className="create-wisp-dialog flex max-h-[calc(100dvh-32px)] max-w-[530px] flex-col"
      >
        <DialogHeader className="flex-none">
          <DialogTitle>Create new Wisp</DialogTitle>
          <DialogDescription>
            {setupFailure
              ? "Created with its default setup"
              : `Step ${stepIndex + 1} of ${STEPS.length} · ${STEP_TITLES[step]}`}
          </DialogDescription>
        </DialogHeader>

        {setupFailure ? (
          <>
            <p className="m-0 text-base text-destructive" role="alert">
              {setupFailure}
            </p>
            <DialogFooter className="flex-none">
              <DialogClose render={<Button type="button" />}>Done</DialogClose>
            </DialogFooter>
          </>
        ) : (
          <form className="flex min-h-0 flex-col gap-5" onSubmit={(event) => void handleSubmit(event)}>
            {step === "identity" && importOpen ? (
              <Field className="flex-none px-1">
                <FieldLabel htmlFor="create-wisp-template">Template</FieldLabel>
                <Textarea
                  id="create-wisp-template"
                  rows={5}
                  className="max-h-40 font-mono text-xs"
                  placeholder="Paste a template copied with Share as template"
                  value={templateText}
                  onChange={(event) => {
                    setTemplateText(event.currentTarget.value);
                    setImportError("");
                  }}
                />
                {importError ? <FieldError>{importError}</FieldError> : null}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" type="button" onClick={closeImport}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    disabled={!templateText.trim() || (!modelView && !modelLoadError)}
                    onClick={applyTemplate}
                  >
                    Apply template
                  </Button>
                </div>
              </Field>
            ) : step === "identity" && imported ? (
              <p className="m-0 flex-none px-1 text-xs text-dim" role="status">
                Template applied. Choose an appearance, then review the soul and model.
              </p>
            ) : null}
            <CreateWispForm
              ref={stepRef}
              step={step}
              settings={settings}
              onChange={(changes) => setSettings((current) => ({ ...current, ...changes }))}
              setup={
                <CreateWispSetupSection
                  view={setupView}
                  loadError={setupLoadError}
                  unsupported={setupUnsupported}
                  draft={setupDraft}
                  onChange={setSetupDraft}
                />
              }
            >
              <CreateWispModelSection
                view={modelView}
                loadError={modelLoadError}
                draft={modelDraft}
                notice={modelNotice}
                onChange={(draft) => {
                  setModelDraft(draft);
                  setModelNotice("");
                }}
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
                  {importOpen ? null : (
                    <Button
                      className="create-wisp-import sm:mr-auto"
                      variant="ghost"
                      type="button"
                      aria-label="Import template"
                      title="Import template"
                      disabled={saving}
                      onClick={() => setImportOpen(true)}
                    >
                      <ClipboardPasteIcon />
                      <span className="max-[760px]:hidden">Import template</span>
                    </Button>
                  )}
                  <DialogClose render={<Button variant="outline" type="button" disabled={saving} />}>
                    Cancel
                  </DialogClose>
                </>
              ) : (
                <Button
                  variant="outline"
                  type="button"
                  disabled={saving}
                  onClick={() => goToStep(STEPS[stepIndex - 1]!)}
                >
                  Back
                </Button>
              )}
              {step === "setup" ? null : (
                <Button
                  variant="outline"
                  type="button"
                  disabled={!name.trim() || saving}
                  onClick={() => goToStep(STEPS[stepIndex + 1]!)}
                >
                  Next
                </Button>
              )}
              <Button type="submit" disabled={!name.trim() || saving || modelInvalid}>
                {saving ? "Creating…" : "Create Wisp"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export { CreateAgentDialog };
