import { WISP_NAME_MAX_LENGTH, type Wisp } from "../../shared/conversations";
import type { PluginGrant } from "../../shared/plugins";
import type { McpGrant } from "../../shared/mcp";
import { formatSkillFile } from "../../shared/skills";
import type { WorkspaceFileCategory, ToolPolicyBehavior } from "../../shared/tool-policy";
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

/** The parts of a template the person chose to apply to the Wisp being created; access starts unchosen. */
export interface TemplateChoices {
  /** Indexes into `template.skills`. */
  skills: ReadonlySet<number>;
  files: boolean;
  allowEverything: boolean;
  plugins: ReadonlySet<string>;
  mcpServers: ReadonlySet<string>;
}

export function initialTemplateChoices(template: WispTemplate): TemplateChoices {
  return {
    // A skill is shown in full before it is kept, so it starts chosen; access never does.
    skills: new Set(template.skills?.map((_skill, index) => index)),
    files: false,
    allowEverything: false,
    plugins: new Set(),
    mcpServers: new Set(),
  };
}

/**
 * Gives a new Wisp the skills and access chosen from its template, through
 * the same operations its settings use, so the server checks each part as it
 * would a change made by hand. Resolves with what could not be applied, as
 * sentence fragments.
 */
export async function applyTemplateChoices(
  conversationId: string,
  template: WispTemplate,
  choices: TemplateChoices,
): Promise<string[]> {
  const failures: string[] = [];
  const request = { conversationId };
  const failed = (what: string, result: { ok: true } | { ok: false; error: { message: string } } | null) => {
    if (!result?.ok) failures.push(`${what} (${result ? result.error.message : "no answer"})`);
  };

  for (const [index, skill] of (template.skills ?? []).entries()) {
    if (!choices.skills.has(index)) continue;
    const name = /^name:\s*(.+)$/m.exec(skill.contents)?.[1]?.trim() ?? `skill ${index + 1}`;
    failed(
      `the ${name} skill`,
      await window.wisp.importSkill({ conversationId, contents: skill.contents }).catch(() => null),
    );
  }

  const access = template.access;
  const files: Partial<Record<WorkspaceFileCategory, ToolPolicyBehavior>> = choices.files ? (access?.files ?? {}) : {};
  if (Object.keys(files).length || (choices.allowEverything && access?.allowEverything)) {
    const current = await window.wisp.getWispToolPolicy(request).catch(() => null);
    if (!current?.ok) failed("its file permissions", current);
    else
      failed(
        "its file permissions",
        await window.wisp
          .saveWispToolPolicy({
            conversationId,
            files: { ...current.value.files, ...files },
            allowEverything:
              current.value.allowEverything || (choices.allowEverything && Boolean(access?.allowEverything)),
          })
          .catch(() => null),
      );
  }

  const plugins = (access?.plugins ?? []).filter(({ pluginId }) => choices.plugins.has(pluginId));
  if (plugins.length) {
    const current = await window.wisp.getWispPluginAccess(request).catch(() => null);
    if (!current?.ok) failed("its plugin access", current);
    else {
      const grants: PluginGrant[] = current.value.grants.map(({ pluginId, access: level }) => {
        const chosen = plugins.find((plugin) => plugin.pluginId === pluginId);
        return { pluginId, access: chosen ? chosen.access : level };
      });
      for (const plugin of plugins) {
        if (!grants.some(({ pluginId }) => pluginId === plugin.pluginId)) grants.push(plugin);
      }
      failed(
        "its plugin access",
        await window.wisp
          .saveWispPluginAccess({ conversationId, revision: current.value.revision, grants })
          .catch(() => null),
      );
    }
  }

  const servers = (access?.mcpServers ?? []).filter(({ serverId }) => choices.mcpServers.has(serverId));
  if (servers.length) {
    const current = await window.wisp.getWispMcpAccess(request).catch(() => null);
    if (!current?.ok) failed("its MCP server access", current);
    else {
      const grants: McpGrant[] = current.value.grants.map(({ serverId, access: level }) => {
        const chosen = servers.find((server) => server.serverId === serverId);
        return { serverId, access: chosen ? chosen.access : level };
      });
      for (const server of servers) {
        if (!grants.some(({ serverId }) => serverId === server.serverId)) {
          grants.push({ serverId: server.serverId, access: server.access });
        }
      }
      failed(
        "its MCP server access",
        await window.wisp
          .saveWispMcpAccess({ conversationId, revision: current.value.revision, grants })
          .catch(() => null),
      );
    }
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
