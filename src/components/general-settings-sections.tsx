import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isRuleBehavior, type AppPreferences, type RuleBehavior } from "@/lib/app-preferences";

const RULE_BEHAVIORS = [
  { value: "allow", label: "Allow automatically" },
  { value: "ask", label: "Ask first" },
  { value: "block", label: "Block" },
];
const TIMEZONES = Array.from(new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]));

interface SettingsOption {
  value: string;
  label: string;
}

function SettingsSelect({ id, value, options, onChange }: {
  id: string;
  value: string;
  options: SettingsOption[];
  onChange: (value: string) => void;
}) {
  return (
    <Select items={options} value={value} onValueChange={(next) => { if (next !== null) onChange(next); }}>
      <SelectTrigger id={id} size="sm" className="settings-select"><SelectValue /></SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false}>
        <SelectGroup>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup>
      </SelectContent>
    </Select>
  );
}

function PreferenceSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return <button className="switch" data-on={checked} type="button" role="switch" aria-checked={checked} aria-label={label} onClick={onChange}><span /></button>;
}

interface GeneralSettingsSectionsProps {
  preferences: AppPreferences;
  onPreferencesChange: (preferences: AppPreferences) => void;
}

function GeneralSettingsSections({ preferences, onPreferencesChange }: GeneralSettingsSectionsProps) {
  const [microphones, setMicrophones] = useState<SettingsOption[]>([]);
  const [detectedTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [ruleAction, setRuleAction] = useState("");
  const [ruleBehavior, setRuleBehavior] = useState<RuleBehavior>("allow");
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
    setRuleAction("");
    setRuleNotice("Rule added.");
  }

  return (
    <>
      <h3 className="settings-group-label" id="system-settings-heading">System</h3>
      <section className="settings-card" aria-labelledby="system-settings-heading">
        <div className="settings-row">
          <span><label htmlFor="app-microphone"><strong>Microphone</strong></label></span>
          <SettingsSelect id="app-microphone" value={preferences.microphone} options={microphoneOptions} onChange={(microphone) => onPreferencesChange({ ...preferences, microphone })} />
        </div>
        <div className="settings-row">
          <span><strong>Use hardware acceleration</strong></span>
          <PreferenceSwitch label="Use hardware acceleration" checked={preferences.hardwareAcceleration} onChange={() => onPreferencesChange({ ...preferences, hardwareAcceleration: !preferences.hardwareAcceleration })} />
        </div>
      </section>
      <p className="settings-integration-note">Microphone and hardware preferences are saved locally; desktop integration is not connected yet.</p>

      <h3 className="settings-group-label" id="wisp-settings-heading">Wisp</h3>
      <section className="settings-card" aria-labelledby="wisp-settings-heading">
        <div className="settings-row">
          <span><label htmlFor="app-timezone"><strong>Timezone</strong></label></span>
          <SettingsSelect id="app-timezone" value={preferences.timezone} options={timezoneOptions} onChange={(timezone) => onPreferencesChange({ ...preferences, timezone })} />
        </div>
        <div className="settings-row">
          <span><strong>Auto-review</strong><small>Choose when Wisp should ask before acting. Add rules to customize what it can do automatically.</small></span>
          <PreferenceSwitch label="Auto-review" checked={preferences.autoReview} onChange={() => onPreferencesChange({ ...preferences, autoReview: !preferences.autoReview })} />
        </div>
        <div className="settings-row review-rules">
          <strong>Auto-review Rules</strong>
          <p>Write one short, natural-language rule for each action. &quot;Ask first&quot; takes priority if rules conflict.</p>
          {preferences.autoReviewRules.length ? (
            <ul className="review-rules-list" aria-label="Auto-review rules">
              {preferences.autoReviewRules.map((rule) => (
                <li key={rule.id}>
                  <span>{rule.action}<small>{RULE_BEHAVIORS.find((behavior) => behavior.value === rule.behavior)?.label}</small></span>
                  <Button variant="ghost" size="icon-xs" aria-label={`Remove rule: ${rule.action}`} onClick={() => {
                    onPreferencesChange({ ...preferences, autoReviewRules: preferences.autoReviewRules.filter((item) => item.id !== rule.id) });
                    setRuleNotice("Rule removed.");
                  }}><XIcon aria-hidden="true" /></Button>
                </li>
              ))}
            </ul>
          ) : null}
          <form className="review-rule-form" onSubmit={addRule}>
            <label htmlFor="rule-action">When Wisp wants to:</label>
            <Input id="rule-action" maxLength={240} placeholder="e.g. reply to emails for me" value={ruleAction} onChange={(event) => { setRuleAction(event.currentTarget.value); setRuleNotice(""); }} />
            <label htmlFor="rule-behavior">It should:</label>
            <div className="review-rule-actions">
              <SettingsSelect id="rule-behavior" value={ruleBehavior} options={RULE_BEHAVIORS} onChange={(behavior) => { if (isRuleBehavior(behavior)) setRuleBehavior(behavior); }} />
              <Button type="submit" variant="secondary" size="sm" disabled={!ruleAction.trim() || duplicateRule}>Add Rule</Button>
            </div>
            {duplicateRule ? <p>This rule already exists.</p> : null}
          </form>
          <span className="sr-only" role="status">{ruleNotice}</span>
          <p>These rules apply only to you. Timezone and auto-review preferences are saved locally; Wisp execution is not connected yet.</p>
        </div>
      </section>
    </>
  );
}

export { GeneralSettingsSections, PreferenceSwitch };
