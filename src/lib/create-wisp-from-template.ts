import type { NewWisp } from "@/chat-data";
import {
  createDefaultWispModelDraft,
  isWispModelDraftInvalid,
  resolveWispModelSelection,
  wispModelDraftFromTemplate,
} from "@/components/create-wisp-model-section";
import { DEFAULT_WISP } from "@/components/create-wisp-panel";
import { applyWispSetup, DEFAULT_WISP_SETUP } from "@/components/create-wisp-setup-section";
import {
  applyTemplateChoices,
  initialTemplateChoices,
  templateAsksForAccess,
  uniqueWispName,
} from "@/lib/wisp-template-actions";
import type { ModelSelection } from "../../shared/contracts";
import type { WispSetupView } from "../../shared/execution";
import type { WispTemplate } from "../../shared/wisp-template";

export type TemplateUseResult =
  | {
      status: "created";
      name: string;
      /** What differs from the template or still needs the person, as sentences. */
      notices: ReadonlyArray<string>;
    }
  /** No model can answer yet, so nothing was created. */
  | { status: "needs_model" }
  | { status: "failed"; message: string };

/**
 * The model, workspace, and commands a Wisp can have here without asking
 * anything: what the template names when it can be used, otherwise the same
 * default a new Wisp gets, with a sentence saying so.
 */
function usableSetup(template: WispTemplate, view: WispSetupView | null, name: string) {
  const notices: string[] = [];
  const requested = template.setup?.quotaBytes;
  let quotaBytes = DEFAULT_WISP_SETUP.quotaBytes;
  // Unlimited is only chosen by hand, after the note on what it means for the disk.
  if (requested === null) notices.push(`${name} uses the default workspace size instead of an unlimited one.`);
  else if (requested !== undefined && view && requested > view.maxQuotaBytes) {
    notices.push(`${name} uses the default workspace size, because the disk has no room for the larger one.`);
  } else if (requested !== undefined) quotaBytes = requested;

  let executionMode = template.setup?.executionMode ?? DEFAULT_WISP_SETUP.executionMode;
  if (executionMode === "container" && view?.runtime.available === false) {
    executionMode = "off";
    notices.push(`${name} can't run commands until Docker or Podman is installed. Turn them on in its settings then.`);
  }
  return { setup: { quotaBytes, executionMode }, notices };
}

/**
 * Creates a Wisp from a template in one step, asking nothing: what cannot be
 * used here falls back to the default and is reported. Access is never given
 * this way: a template from someone else could otherwise grant tools or skip
 * approvals. The person gives it in the creation dialog or the Wisp's settings.
 */
export async function createWispFromTemplate(
  template: WispTemplate,
  takenNames: ReadonlyArray<string>,
  create: (
    wisp: NewWisp,
    options: { notifyOnUpdatesEnabled: boolean; model: ModelSelection | null },
  ) => Promise<string | null>,
): Promise<TemplateUseResult> {
  const name = uniqueWispName(template.name, takenNames);
  const failedToCreate = { status: "failed", message: `Could not create ${name}. Try again.` } as const;
  try {
    const settings = await window.wisp.getAiSettings();
    if (!settings.ok) return { status: "failed", message: settings.error.message };

    const notices: string[] = [];
    const chosen = wispModelDraftFromTemplate(template.model, settings.value);
    let model = chosen.draft;
    if (template.model && (chosen.notice || isWispModelDraftInvalid(model, settings.value))) {
      model = createDefaultWispModelDraft();
      notices.push(`${name} uses your default model, because ${template.model.modelId} isn't available here.`);
    }
    if (isWispModelDraftInvalid(model, settings.value)) return { status: "needs_model" };

    // Without this answer, as on an older server, the setup is tried and any failure reported below.
    const setupView = await window.wisp.getWispSetup().catch(() => null);
    const usable = usableSetup(template, setupView?.ok ? setupView.value : null, name);
    notices.push(...usable.notices);

    const color = template.color ?? DEFAULT_WISP.color;
    const conversationId = await create(
      {
        name,
        role: template.role.trim(),
        soul: template.soul.trim(),
        appearance: template.appearance ?? DEFAULT_WISP.appearance,
        ...(color === undefined ? {} : { color }),
      },
      { notifyOnUpdatesEnabled: DEFAULT_WISP.notifyOnUpdatesEnabled, model: resolveWispModelSelection(model) },
    );
    if (!conversationId) return failedToCreate;

    const failed = [
      ...[await applyWispSetup(conversationId, usable.setup)].filter(Boolean),
      ...(await applyTemplateChoices(conversationId, template, initialTemplateChoices(template))),
    ].join(" and ");
    if (failed) notices.push(`${name} was created, but ${failed} could not be set. Change it in the Wisp's settings.`);
    if (templateAsksForAccess(template)) {
      notices.push(`${name} asks for more access. Turn on what you want in its Access tab.`);
    }
    return { status: "created", name, notices };
  } catch {
    return failedToCreate;
  }
}
