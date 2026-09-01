import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { XIcon } from "lucide-react";

import { TimezoneCombobox } from "@/components/timezone-combobox";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isRuleBehavior, type AppPreferences, type RuleBehavior } from "@/lib/app-preferences";
import { settingsCardStack, settingsGroupLabel, settingsRow, settingsRowCopy, settingsSelect } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";

const RULE_BEHAVIORS = [
  { value: "allow", label: "Allow automatically" },
  { value: "ask", label: "Ask first" },
  { value: "block", label: "Block" },
];
const RULE_ACTIONS = [
  { value: "create_file", label: "Create files" },
  { value: "modify_file", label: "Modify files" },
  { value: "all_file_changes", label: "All file changes" },
];
const TIMEZONES = Array.from(new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]));

interface SettingsOption {
  value: string;
  label: string;
}

function SettingsSelect({ id, value, options, onChange, contentClassName }: {
  id: string;
  value: string;
  options: SettingsOption[];
  onChange: (value: string) => void;
  contentClassName?: string;
}) {
  return (
    <Select items={options} value={value} onValueChange={(next) => { if (next !== null) onChange(next); }}>
      <SelectTrigger id={id} size="sm" className={settingsSelect}><SelectValue /></SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false} className={contentClassName}>
        <SelectGroup>{options.map((option) => <SelectItem className="pr-10" key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup>
      </SelectContent>
    </Select>
  );
}

function PreferenceSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return <ToggleSwitch checked={checked} label={label} onChange={onChange} />;
}

interface GeneralSettingsSectionsProps {
  preferences: AppPreferences;
  onPreferencesChange: (preferences: AppPreferences) => void;
}

function GeneralSettingsSections({ preferences, onPreferencesChange }: GeneralSettingsSectionsProps) {
  const [microphones, setMicrophones] = useState<SettingsOption[]>([]);
  const [detectedTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [ruleAction, setRuleAction] = useState("create_file");
  const [ruleBehavior, setRuleBehavior] = useState<RuleBehavior>("ask");
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
        setMicrophones(devices.filter((device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default")
          .map((device, index) => ({ value: device.deviceId, label: device.label || `Microphone ${index + 1}` })));
      } catch {
        if (active && version === request) setMicrophones([]);
      }
    }
    void refreshMicrophones();
    mediaDevices.addEventListener("devicechange", refreshMicrophones);
    return () => { active = false; mediaDevices.removeEventListener("devicechange", refreshMicrophones); };
  }, []);

  const microphoneOptions = [{ value: "default", label: "System Default" }, ...microphones];
  if (!microphoneOptions.some((option) => option.value === preferences.microphone)) {
    microphoneOptions.push({ value: preferences.microphone, label: "Saved microphone (unavailable)" });
  }
  const timezoneOptions = [
    { value: "auto", label: `Auto-detect (${detectedTimezone})` },
    ...Array.from(new Set([...TIMEZONES, ...(preferences.timezone === "auto" ? [] : [preferences.timezone])]))
      .map((zone) => ({ value: zone, label: zone })),
  ];
  const duplicateRule = preferences.autoReviewRules.some((rule) => rule.action.toLocaleLowerCase() === ruleAction.trim().toLocaleLowerCase() && rule.behavior === ruleBehavior);

  function addRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const action = ruleAction.trim();
    if (!action || duplicateRule) return;
    onPreferencesChange({ ...preferences, autoReviewRules: [...preferences.autoReviewRules, { id: crypto.randomUUID(), action, behavior: ruleBehavior }] });
    setRuleNotice("Rule added.");
  }

  return (
    <>
      <h3 className={settingsGroupLabel} id="system-settings-heading">System</h3>
      <section className={settingsCardStack} aria-labelledby="system-settings-heading">
        <div className={settingsRow}>
          <span className={settingsRowCopy}><label htmlFor="app-microphone"><strong>Microphone</strong></label></span>
          <SettingsSelect id="app-microphone" value={preferences.microphone} options={microphoneOptions} onChange={(microphone) => onPreferencesChange({ ...preferences, microphone })} />
        </div>
        <div className={settingsRow}>
          <span className={settingsRowCopy}><strong>Use hardware acceleration</strong></span>
          <PreferenceSwitch label="Use hardware acceleration" checked={preferences.hardwareAcceleration} onChange={() => onPreferencesChange({ ...preferences, hardwareAcceleration: !preferences.hardwareAcceleration })} />
        </div>
      </section>
      <p className="mx-0.5 mt-[7px] text-dim text-[11px] leading-[1.45]">Microphone and hardware preferences are saved locally; desktop integration is not connected yet.</p>

      <h3 className={settingsGroupLabel} id="wisp-settings-heading">Wisp</h3>
      <section className={settingsCardStack} aria-labelledby="wisp-settings-heading">
        <div className={settingsRow}>
          <span className={settingsRowCopy}><label htmlFor="app-timezone"><strong>Timezone</strong></label></span>
          <TimezoneCombobox id="app-timezone" value={preferences.timezone} options={timezoneOptions} onChange={(timezone) => onPreferencesChange({ ...preferences, timezone })} />
        </div>
        <div className={settingsRow}>
          <span className={settingsRowCopy}><strong>Auto-review</strong><small className="text-dim text-[11.5px]">Choose when Wisp should ask before acting. Add rules to customize what it can do automatically.</small></span>
          <PreferenceSwitch label="Auto-review" checked={preferences.autoReview} onChange={() => onPreferencesChange({ ...preferences, autoReview: !preferences.autoReview })} />
        </div>
        <div className={cn(settingsRow, "flex-col items-stretch gap-[5px]")}>
          <strong>Auto-review Rules</strong>
          <p className="m-0 text-dim text-[11.5px] leading-[1.5]">Choose a stable file-action category. Block takes priority over ask, and ask takes priority over allow.</p>
          {preferences.autoReviewRules.length ? (
            <ul className="m-0 mt-[7px] flex list-none flex-col p-0" aria-label="Auto-review rules">
              {preferences.autoReviewRules.map((rule) => (
                <li key={rule.id} className="flex items-center gap-3 border-b border-border py-2">
                  <span className="min-w-0 flex-1 text-xs [overflow-wrap:anywhere]">{RULE_ACTIONS.find(({ value }) => value === rule.action)?.label ?? rule.action}<small className="mt-0.5 block">{RULE_BEHAVIORS.find((behavior) => behavior.value === rule.behavior)?.label}</small></span>
                  <Button variant="ghost" size="icon-xs" aria-label={`Remove rule: ${rule.action}`} onClick={() => {
                    onPreferencesChange({ ...preferences, autoReviewRules: preferences.autoReviewRules.filter((item) => item.id !== rule.id) });
                    setRuleNotice("Rule removed.");
                  }}><XIcon aria-hidden="true" /></Button>
                </li>
              ))}
            </ul>
          ) : null}
          <form className="my-[7px] flex flex-col gap-[5px]" onSubmit={addRule}>
            <label className="m-0 text-dim text-[11.5px] leading-[1.5]" htmlFor="rule-action">When Wisp wants to:</label>
            <SettingsSelect id="rule-action" value={ruleAction} options={RULE_ACTIONS} contentClassName="min-w-56" onChange={(action) => { setRuleAction(action); setRuleNotice(""); }} />
            <label className="m-0 mt-[5px] text-dim text-[11.5px] leading-[1.5]" htmlFor="rule-behavior">It should:</label>
            <div className="flex items-center justify-between gap-2.5">
              <SettingsSelect id="rule-behavior" value={ruleBehavior} options={RULE_BEHAVIORS} contentClassName="min-w-56" onChange={(behavior) => { if (isRuleBehavior(behavior)) setRuleBehavior(behavior); }} />
              <Button type="submit" variant="secondary" size="sm" disabled={!ruleAction.trim() || duplicateRule}>Add Rule</Button>
            </div>
            {duplicateRule ? <p className="m-0 text-dim text-[11.5px] leading-[1.5]">This rule already exists.</p> : null}
          </form>
          <span className="sr-only" role="status">{ruleNotice}</span>
          <p className="m-0 text-dim text-[11.5px] leading-[1.5]">These rules are enforced in the desktop backend before Pi can create or modify a file. Shell execution remains blocked.</p>
        </div>
      </section>
    </>
  );
}

export { GeneralSettingsSections, PreferenceSwitch };
