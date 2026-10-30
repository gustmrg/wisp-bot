import { useState } from "react";

import { SearchableCombobox } from "@/components/searchable-combobox";
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { SettingsScopeNote } from "@/components/settings/settings-scope";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AppPreferences } from "@/lib/app-preferences";
import { clockTimeOptions, type TimeFormat } from "@/lib/clock-time";
import { settingsSelect } from "@/lib/ui-classes";
import { systemTimeZone } from "../../shared/time-zone";

const TIME_FORMAT_OPTIONS: ReadonlyArray<{ value: TimeFormat; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "24h", label: "24-hour" },
  { value: "12h", label: "12-hour" },
];
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

interface GeneralSettingsSectionsProps {
  preferences: AppPreferences;
  onPreferencesChange: (preferences: AppPreferences) => void;
}

/** An afternoon time in `format`, so the choice shows how both halves of the day read. */
function sampleTime(format: TimeFormat): string {
  return new Date(2000, 0, 1, 21, 5).toLocaleTimeString([], clockTimeOptions(format));
}

function GeneralSettingsSections({ preferences, onPreferencesChange }: GeneralSettingsSectionsProps) {
  const [detectedTimezone] = useState(systemTimeZone);

  const timezoneOptions = [
    { value: "auto", label: `Auto-detect (${detectedTimezone})` },
    ...Array.from(new Set([...TIMEZONES, ...(preferences.timezone === "auto" ? [] : [preferences.timezone])])).map(
      (zone) => ({ value: zone, label: zone }),
    ),
  ];

  return (
    <>
      <SettingsGroup label="Date and time" note={<SettingsScopeNote scope="device" />}>
        <SettingsCard variant="stacked">
          <SettingsRow>
            <SettingsRowCopy>
              <SettingsRowTitle htmlFor="app-timezone">Timezone</SettingsRowTitle>
              <SettingsRowDescription>
                Dates and times in Wisp, and the local time Wisps work with.
              </SettingsRowDescription>
            </SettingsRowCopy>
            <SearchableCombobox
              id="app-timezone"
              value={preferences.timezone}
              options={timezoneOptions}
              searchLabel="Search timezones"
              searchPlaceholder="Search city or timezone…"
              emptyText="No timezones found."
              onChange={(timezone) => onPreferencesChange({ ...preferences, timezone })}
            />
          </SettingsRow>
          <SettingsRow>
            <SettingsRowCopy>
              <SettingsRowTitle>Time format</SettingsRowTitle>
              <SettingsRowDescription>
                {preferences.timeFormat === "auto"
                  ? `Follows your system's language, like ${sampleTime("auto")}.`
                  : `Times read like ${sampleTime(preferences.timeFormat)}.`}
              </SettingsRowDescription>
            </SettingsRowCopy>
            <SegmentedControl
              label="Time format"
              value={preferences.timeFormat}
              options={TIME_FORMAT_OPTIONS}
              onChange={(timeFormat) => onPreferencesChange({ ...preferences, timeFormat })}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>
    </>
  );
}

export { GeneralSettingsSections, PreferenceSwitch, SettingsSelect };
export type { SettingsOption };
