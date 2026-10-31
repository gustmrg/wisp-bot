import { useEffect, useState } from "react";

import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import type { TemplateChoices } from "@/lib/wisp-template-actions";
import { pluginCatalogEntry } from "../../shared/plugins";
import { parseSkillFile } from "../../shared/skills";
import type { WispTemplate } from "../../shared/wisp-template";

const FILE_LABELS = { create_file: "create files", modify_file: "edit files" } as const;
const BEHAVIOR_LABELS = { allow: "allow", ask: "ask", block: "block" } as const;

/** Whether the template's step has anything to choose. */
export function templateHasChoices(template: WispTemplate): boolean {
  const access = template.access;
  return Boolean(
    template.skills?.length ||
      (access?.files && Object.keys(access.files).length) ||
      access?.allowEverything ||
      access?.plugins?.length ||
      access?.mcpServers?.length,
  );
}

/**
 * The skills and access a template brings, for the person to choose before
 * the Wisp exists. Skills start chosen, since each is shown in full; access
 * never does, and plugins or MCP servers not set up here cannot be chosen.
 */
export function CreateWispTemplateSection({
  template,
  choices,
  onChange,
}: {
  template: WispTemplate;
  choices: TemplateChoices;
  onChange: (choices: TemplateChoices) => void;
}) {
  const access = template.access;
  const wantsPlugins = Boolean(access?.plugins?.length);
  const wantsServers = Boolean(access?.mcpServers?.length);
  const [configuredPlugins, setConfiguredPlugins] = useState<ReadonlySet<string> | null>(null);
  const [knownServers, setKnownServers] = useState<ReadonlySet<string> | null>(null);

  useEffect(() => {
    let active = true;
    if (wantsPlugins) {
      void window.wisp
        .getPluginSettings()
        .then((result) => {
          if (active)
            setConfiguredPlugins(
              new Set(result.ok ? result.value.plugins.filter((p) => p.configured).map((p) => p.id) : []),
            );
        })
        .catch(() => {
          if (active) setConfiguredPlugins(new Set());
        });
    }
    if (wantsServers) {
      void window.wisp
        .getMcpSettings()
        .then((result) => {
          if (active) setKnownServers(new Set(result.ok ? result.value.servers.map(({ serverId }) => serverId) : []));
        })
        .catch(() => {
          if (active) setKnownServers(new Set());
        });
    }
    return () => {
      active = false;
    };
  }, [wantsPlugins, wantsServers]);

  const toggle = (set: ReadonlySet<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const files = Object.entries(access?.files ?? {});

  return (
    <div className="space-y-4">
      {template.skills?.length ? (
        <SettingsGroup label="Skills">
          <SettingsCard variant="stacked">
            {template.skills.map(({ contents }, index) => {
              const skill = parseSkillFile(contents);
              const name = skill?.name ?? `Skill ${index + 1}`;
              return (
                <SettingsRow key={name} className="min-h-0 p-[11px]">
                  <SettingsRowCopy>
                    <SettingsRowTitle>{name}</SettingsRowTitle>
                    <SettingsRowDescription>{skill?.description}</SettingsRowDescription>
                  </SettingsRowCopy>
                  <ToggleSwitch
                    label={`Skill: ${name}`}
                    checked={choices.skills.has(index)}
                    onChange={() => {
                      const skills = new Set(choices.skills);
                      if (skills.has(index)) skills.delete(index);
                      else skills.add(index);
                      onChange({ ...choices, skills });
                    }}
                  />
                </SettingsRow>
              );
            })}
          </SettingsCard>
        </SettingsGroup>
      ) : null}

      {files.length || access?.allowEverything || wantsPlugins || wantsServers ? (
        <SettingsGroup label="Access">
          <SettingsCard variant="stacked">
            {files.length ? (
              <SettingsRow className="min-h-0 p-[11px]">
                <SettingsRowCopy>
                  <SettingsRowTitle>Workspace files</SettingsRowTitle>
                  <SettingsRowDescription>
                    {files
                      .map(
                        ([category, behavior]) =>
                          `${BEHAVIOR_LABELS[behavior as keyof typeof BEHAVIOR_LABELS]} to ${FILE_LABELS[category as keyof typeof FILE_LABELS]}`,
                      )
                      .join(", ")
                      .replace(/^./, (first) => first.toUpperCase())}
                    .
                  </SettingsRowDescription>
                </SettingsRowCopy>
                <ToggleSwitch
                  label="Workspace files"
                  checked={choices.files}
                  onChange={() => onChange({ ...choices, files: !choices.files })}
                />
              </SettingsRow>
            ) : null}
            {access?.allowEverything ? (
              <SettingsRow className="min-h-0 p-[11px]">
                <SettingsRowCopy>
                  <SettingsRowTitle>Allow everything</SettingsRowTitle>
                  <SettingsRowDescription>
                    Risk mode: the Wisp creates and edits files, writes to plugins and calls MCP tools without asking.
                  </SettingsRowDescription>
                </SettingsRowCopy>
                <ToggleSwitch
                  label="Allow everything"
                  checked={choices.allowEverything}
                  onChange={() => onChange({ ...choices, allowEverything: !choices.allowEverything })}
                />
              </SettingsRow>
            ) : null}
            {(access?.plugins ?? []).map(({ pluginId, access: level }) => {
              const name = pluginCatalogEntry(pluginId).name;
              const available = configuredPlugins?.has(pluginId) ?? false;
              return (
                <SettingsRow key={pluginId} className="min-h-0 p-[11px]">
                  <SettingsRowCopy>
                    <SettingsRowTitle>{name}</SettingsRowTitle>
                    <SettingsRowDescription>
                      {available
                        ? level === "write"
                          ? "Read and write, asking before each write."
                          : "Read only."
                        : configuredPlugins
                          ? "Not connected here. Connect it in Settings → Plugins to give access later."
                          : "Checking…"}
                    </SettingsRowDescription>
                  </SettingsRowCopy>
                  <ToggleSwitch
                    label={`Plugin: ${name}`}
                    checked={available && choices.plugins.has(pluginId)}
                    disabled={!available}
                    onChange={() => onChange({ ...choices, plugins: toggle(choices.plugins, pluginId) })}
                  />
                </SettingsRow>
              );
            })}
            {(access?.mcpServers ?? []).map(({ serverId, name, access: level }) => {
              const available = knownServers?.has(serverId) ?? false;
              return (
                <SettingsRow key={serverId} className="min-h-0 p-[11px]">
                  <SettingsRowCopy>
                    <SettingsRowTitle>{name}</SettingsRowTitle>
                    <SettingsRowDescription>
                      {available
                        ? level === "allow_all"
                          ? "MCP server, used without asking."
                          : "MCP server, used with approval."
                        : knownServers
                          ? "Not set up here. Add it in Settings → MCP servers to give access later."
                          : "Checking…"}
                    </SettingsRowDescription>
                  </SettingsRowCopy>
                  <ToggleSwitch
                    label={`MCP server: ${name}`}
                    checked={available && choices.mcpServers.has(serverId)}
                    disabled={!available}
                    onChange={() => onChange({ ...choices, mcpServers: toggle(choices.mcpServers, serverId) })}
                  />
                </SettingsRow>
              );
            })}
          </SettingsCard>
          <p className="mx-0.5 mt-[7px] text-xs text-dim">
            The template asks for this access; nothing is given unless you turn it on here.
          </p>
        </SettingsGroup>
      ) : null}
    </div>
  );
}
