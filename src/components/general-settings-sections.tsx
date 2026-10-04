import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { XIcon } from "lucide-react";

import { SearchableCombobox } from "@/components/searchable-combobox";
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SoonBadge,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AppPreferences, AutoReviewRule, RuleBehavior } from "@/lib/app-preferences";
import { settingsSelect } from "@/lib/ui-classes";
import { ruleMatchesCategory, workspaceFileBehavior, type WorkspaceFileCategory } from "../../shared/tool-policy";

const RULE_BEHAVIORS: ReadonlyArray<{ value: RuleBehavior; label: string }> = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask" },
  { value: "block", label: "Block" },
];
const FILE_CATEGORIES: ReadonlyArray<{ value: WorkspaceFileCategory; label: string; description: string }> = [
  { value: "create_file", label: "Create files", description: "New files in the workspace." },
  { value: "modify_file", label: "Modify files", description: "Edits to existing workspace files." },
];
const INTEGRATION_ACTION_LABELS: Record<string, string> = {
  external_write: "Changes to integrations",
  integration_call: "MCP tool calls",
};
const TIMEZONES = Array.from(new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]));

interface SettingsOption {
  value: string;
  label: string;
}

function SettingsSelect({
  id,
  value,
  options,
  onChange,
  contentClassName,
  disabled = false,
}: {
  id: string;
  value: string;
  options: SettingsOption[];
  onChange: (value: string) => void;
  contentClassName?: string;
  disabled?: boolean;
}) {
  return (
    <Select
      items={options}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger id={id} size="sm" className={settingsSelect}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false} className={contentClassName}>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem className="pr-10" key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function PreferenceSwitch({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return <ToggleSwitch checked={checked} label={label} onChange={onChange} disabled={disabled} />;
}

/** Title of a setting whose preference is saved but not wired to the desktop yet. */
function SoonTitle({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {htmlFor ? (
        <label htmlFor={htmlFor}>
          <strong>{children}</strong>
        </label>
      ) : (
        <strong>{children}</strong>
      )}
      <SoonBadge />
    </span>
  );
}

/**
 * Rewrites the workspace rules for one file category as a single explicit rule.
 * "Ask" is the default when no rule matches, so it needs no rule of its own.
 * Rules for the other category keep their effective behavior, including ones
 * that came from a shared rule such as "all file changes".
 */
function withFileBehavior(
  rules: ReadonlyArray<AutoReviewRule>,
  category: WorkspaceFileCategory,
  behavior: RuleBehavior,
): AutoReviewRule[] {
  const behaviors = Object.fromEntries(
    FILE_CATEGORIES.map(({ value }) => [value, value === category ? behavior : workspaceFileBehavior(rules, value)]),
  ) as Record<WorkspaceFileCategory, RuleBehavior>;
  const untouched = rules.filter(
    (rule) =>
      (rule.scope ?? "workspace") !== "workspace" ||
      !FILE_CATEGORIES.some(({ value }) => ruleMatchesCategory(rule.action, value)),
  );
  return [
    ...untouched,
    ...FILE_CATEGORIES.filter(({ value }) => behaviors[value] !== "ask").map(({ value }) => ({
      id: crypto.randomUUID(),
      action: value,
      behavior: behaviors[value],
      scope: "workspace" as const,
    })),
  ];
}

interface GeneralSettingsSectionsProps {
  preferences: AppPreferences;
  onPreferencesChange: (preferences: AppPreferences) => void;
}

function GeneralSettingsSections({ preferences, onPreferencesChange }: GeneralSettingsSectionsProps) {
  const [microphones, setMicrophones] = useState<SettingsOption[]>([]);
  const [detectedTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [ruleNotice, setRuleNotice] = useState("");

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return;
    let active = true;
    let request = 0;
    async function refreshMicrophones() {
      const version = ++request;
      try {
        // List only devices already exposed by the browser. Never request recording permission here.
        const devices = await mediaDevices.enumerateDevices();
        if (!active || version !== request) return;
        setMicrophones(
          devices
            .filter((device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default")
            .map((device, index) => ({ value: device.deviceId, label: device.label || `Microphone ${index + 1}` })),
        );
      } catch {
        if (active && version === request) setMicrophones([]);
      }
    }
    void refreshMicrophones();
    mediaDevices.addEventListener("devicechange", refreshMicrophones);
    return () => {
      active = false;
      mediaDevices.removeEventListener("devicechange", refreshMicrophones);
    };
  }, []);

  const microphoneOptions = [{ value: "default", label: "System Default" }, ...microphones];
  if (!microphoneOptions.some((option) => option.value === preferences.microphone)) {
    microphoneOptions.push({ value: preferences.microphone, label: "Saved microphone (unavailable)" });
  }
  const timezoneOptions = [
    { value: "auto", label: `Auto-detect (${detectedTimezone})` },
    ...Array.from(new Set([...TIMEZONES, ...(preferences.timezone === "auto" ? [] : [preferences.timezone])])).map(
      (zone) => ({ value: zone, label: zone }),
    ),
  ];
  const integrationRules = preferences.autoReviewRules.filter((rule) => rule.scope === "integration");

  function setFileBehavior(category: WorkspaceFileCategory, behavior: RuleBehavior) {
    onPreferencesChange({
      ...preferences,
      autoReviewRules: withFileBehavior(preferences.autoReviewRules, category, behavior),
    });
    const label = FILE_CATEGORIES.find(({ value }) => value === category)?.label ?? category;
    const behaviorLabel = RULE_BEHAVIORS.find(({ value }) => value === behavior)?.label ?? behavior;
    setRuleNotice(`${label}: ${behaviorLabel}.`);
  }

  return (
    <>
      <SettingsGroup label="System">
        <SettingsCard variant="stacked">
          <SettingsRow>
            <SettingsRowCopy>
              <SoonTitle htmlFor="app-microphone">Microphone</SoonTitle>
              <small>Voice input is not available yet.</small>
            </SettingsRowCopy>
            <SettingsSelect
              id="app-microphone"
              value={preferences.microphone}
              options={microphoneOptions}
              disabled
              onChange={(microphone) => onPreferencesChange({ ...preferences, microphone })}
            />
          </SettingsRow>
          <SettingsRow>
            <SettingsRowCopy>
              <SoonTitle>Use hardware acceleration</SoonTitle>
              <small>Wisp always uses the system default for now.</small>
            </SettingsRowCopy>
            <PreferenceSwitch
              label="Use hardware acceleration"
              checked={preferences.hardwareAcceleration}
              disabled
              onChange={() =>
                onPreferencesChange({ ...preferences, hardwareAcceleration: !preferences.hardwareAcceleration })
              }
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup label="Wisp">
        <SettingsCard variant="stacked">
          <SettingsRow>
            <SettingsRowCopy>
              <SoonTitle htmlFor="app-timezone">Timezone</SoonTitle>
              <small>Wisps don't use this timezone yet.</small>
            </SettingsRowCopy>
            <SearchableCombobox
              id="app-timezone"
              value={preferences.timezone}
              options={timezoneOptions}
              disabled
              searchLabel="Search timezones"
              searchPlaceholder="Search city or timezone…"
              emptyText="No timezones found."
              onChange={(timezone) => onPreferencesChange({ ...preferences, timezone })}
            />
          </SettingsRow>
          <SettingsRow>
            <SettingsRowCopy>
              <strong>Auto-review file changes</strong>
              <small>
                {preferences.autoReview
                  ? "Wisp follows the rules below before changing workspace files."
                  : "Wisp asks before every file change. Turn on to use the rules below."}
              </small>
            </SettingsRowCopy>
            <PreferenceSwitch
              label="Auto-review file changes"
              checked={preferences.autoReview}
              onChange={() => onPreferencesChange({ ...preferences, autoReview: !preferences.autoReview })}
            />
          </SettingsRow>
          {FILE_CATEGORIES.map((category) => (
            <SettingsRow key={category.value} aria-disabled={!preferences.autoReview || undefined}>
              <SettingsRowCopy className={preferences.autoReview ? undefined : "opacity-50"}>
                <strong>{category.label}</strong>
                <small>{category.description}</small>
              </SettingsRowCopy>
              <SegmentedControl
                label={`When Wisp wants to ${category.label.toLocaleLowerCase()}`}
                value={workspaceFileBehavior(preferences.autoReviewRules, category.value)}
                options={RULE_BEHAVIORS}
                disabled={!preferences.autoReview}
                onChange={(behavior) => setFileBehavior(category.value, behavior)}
              />
            </SettingsRow>
          ))}
          {integrationRules.length ? (
            <SettingsRow className="flex-col items-stretch gap-[5px]">
              <strong>Integration blocks</strong>
              <small>
                Changes to integrations always ask first. Actions you block from an approval prompt are listed here.
              </small>
              <ul className="m-0 mt-[3px] flex list-none flex-col p-0" aria-label="Integration blocks">
                {integrationRules.map((rule) => (
                  <li key={rule.id} className="flex items-center gap-3 border-t border-border py-2">
                    <span className="min-w-0 flex-1 text-xs [overflow-wrap:anywhere]">
                      {INTEGRATION_ACTION_LABELS[rule.action] ?? rule.action}
                      <small className="mt-0.5 block">
                        {RULE_BEHAVIORS.find((behavior) => behavior.value === rule.behavior)?.label}
                      </small>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove rule: ${INTEGRATION_ACTION_LABELS[rule.action] ?? rule.action}`}
                      onClick={() => {
                        onPreferencesChange({
                          ...preferences,
                          autoReviewRules: preferences.autoReviewRules.filter((item) => item.id !== rule.id),
                        });
                        setRuleNotice("Rule removed.");
                      }}
                    >
                      <XIcon aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            </SettingsRow>
          ) : null}
        </SettingsCard>
        <p className="mx-0.5 mt-[7px] text-dim text-[11px] leading-[1.45]">
          Rules are enforced in the desktop backend before Pi can create or modify a file. Shell execution remains
          blocked.
        </p>
        <span className="sr-only" role="status">
          {ruleNotice}
        </span>
      </SettingsGroup>
    </>
  );
}

export { GeneralSettingsSections, PreferenceSwitch, SoonTitle };
