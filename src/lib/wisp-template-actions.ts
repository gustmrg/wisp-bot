import type { NewWisp } from "@/chat-data";
import {
  createDefaultWispModelDraft,
  isWispModelDraftInvalid,
  resolveWispModelSelection,
  wispModelDraftFromTemplate,
} from "@/components/create-wisp-model-section";
import { DEFAULT_WISP } from "@/components/create-wisp-panel";
import { applyWispSetup, DEFAULT_WISP_SETUP } from "@/components/create-wisp-setup-section";
import type { ModelSelection } from "../../shared/contracts";
import { WISP_NAME_MAX_LENGTH, type Wisp } from "../../shared/conversations";
import type { WispSetupView } from "../../shared/execution";
import { formatSkillFile } from "../../shared/skills";
import type { WispTemplate, WispTemplateAccess } from "../../shared/wisp-template";
import { WORKSPACE_QUOTA_PRESETS } from "../../shared/workspace";

/**
 * What a Wisp would be saved as: everything a template carries, read through
 * the same operations its settings use. Parts the server does not offer, such
 * as commands on an older server, are left out rather than failing the save.
 */
export async function captureWispTemplate(conversationId: string, wisp: Wisp): Promise<WispTemplate> {
  const request = { conversationId };
  const read = <T>(call: () => Promise<{ ok: true; value: T } | { ok: false }>) =>
    call()
      .then((result) => (result.ok ? result.value : null))
      .catch(() => null);
  const [model, skills, workspace, execution, policy, plugins, mcp, mcpSettings] = await Promise.all([
    read(() => window.wisp.getConversationModel(request)),
    read(() => window.wisp.listSkills(request)),
    read(() => window.wisp.getWorkspace(request)),
    read(() => window.wisp.getWispExecution(request)),
    read(() => window.wisp.getWispToolPolicy(request)),
    read(() => window.wisp.getWispPluginAccess(request)),
    read(() => window.wisp.getWispMcpAccess(request)),
    read(() => window.wisp.getMcpSettings()),
  ]);

  const access: WispTemplateAccess = {};
  if (policy && Object.keys(policy.files).length) access.files = { ...policy.files };
  if (policy?.allowEverything) access.allowEverything = true;
  const pluginGrants = (plugins?.grants ?? []).flatMap(({ pluginId, access: level }) =>
    level === "none" ? [] : [{ pluginId, access: level }],
  );
  if (pluginGrants.length) access.plugins = pluginGrants;
  const serverNames = new Map((mcpSettings?.servers ?? []).map(({ serverId, name }) => [serverId, name]));
  const mcpGrants = (mcp?.grants ?? []).flatMap(({ serverId, access: level }) =>
    level === "none" ? [] : [{ serverId, name: serverNames.get(serverId) ?? serverId, access: level }],
  );
  if (mcpGrants.length) access.mcpServers = mcpGrants;

  const setup: NonNullable<WispTemplate["setup"]> = {};
  // Only an offered size: a template refuses any other, and a size saved outside them is a leftover.
  if (workspace && WORKSPACE_QUOTA_PRESETS.includes(workspace.quotaBytes)) setup.quotaBytes = workspace.quotaBytes;
  if (execution) setup.executionMode = execution.mode;

  return {
    name: wisp.name,
    role: wisp.role,
    soul: wisp.soul,
    appearance: wisp.appearance,
    ...(wisp.color ? { color: wisp.color } : {}),
    // Only a model the Wisp chose; one following the global model keeps following it.
    ...(model?.override ? { model: model.override } : {}),
    ...(skills?.length ? { skills: skills.map((skill) => ({ contents: formatSkillFile(skill) })) } : {}),
    ...(Object.keys(setup).length ? { setup } : {}),
    ...(Object.keys(access).length ? { access } : {}),
  };
}

/**
 * Gives a new Wisp its template's skills, through the operation its settings
 * use, so the server checks each one. Resolves with what could not be applied,
 * as sentence fragments.
 */
export async function applyTemplateSkills(conversationId: string, template: WispTemplate): Promise<string[]> {
  const failures: string[] = [];
  for (const [index, skill] of (template.skills ?? []).entries()) {
    const name = /^name:\s*(.+)$/m.exec(skill.contents)?.[1]?.trim() ?? `skill ${index + 1}`;
    const result = await window.wisp.importSkill({ conversationId, contents: skill.contents }).catch(() => null);
    if (!result?.ok) failures.push(`the ${name} skill (${result ? result.error.message : "no answer"})`);
  }
  return failures;
}

/** Whether a template asks for anything beyond what a new Wisp has; it is never given by using the template. */
export function templateAsksForAccess({ access }: WispTemplate): boolean {
  return Boolean(
    access?.allowEverything ||
      Object.keys(access?.files ?? {}).length ||
      access?.plugins?.length ||
      access?.mcpServers?.length,
  );
}

/** A name no Wisp here has yet, so using a template twice gives "Atlas" and "Atlas 2". */
export function uniqueWispName(name: string, taken: ReadonlyArray<string>): string {
  const names = new Set(taken.map((other) => other.trim().toLocaleLowerCase()));
  if (!names.has(name.trim().toLocaleLowerCase())) return name;
  for (let copy = 2; ; copy += 1) {
    const suffix = ` ${copy}`;
    const candidate = `${name.slice(0, WISP_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!names.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

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
 * used here falls back to the default and is reported. Access is never given:
 * a template from someone else could otherwise grant tools or skip approvals.
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
      ...(await applyTemplateSkills(conversationId, template)),
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
