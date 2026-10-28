import { useState } from "react";

import { PreferenceSwitch } from "@/components/general-settings-sections";
import {
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { connectionNoticesOff, setConnectionNoticesOff } from "@/features/connections/connection-notices";

/**
 * Brings back the "Connected to" notice turned off with its Don't show again
 * (SWE-230). It is kept apart from the preferences, so it is read when the
 * setting mounts.
 */
export function ConnectionNoticeSetting() {
  const [on, setOn] = useState(() => !connectionNoticesOff());
  return (
    <SettingsRow>
      <SettingsRowCopy>
        <SettingsRowTitle>Server connection notice</SettingsRowTitle>
        <SettingsRowDescription>Say which server Wisp connected to when you switch to one.</SettingsRowDescription>
      </SettingsRowCopy>
      <PreferenceSwitch
        label="Server connection notice"
        checked={on}
        onChange={() => {
          setConnectionNoticesOff(on);
          setOn(!on);
        }}
      />
    </SettingsRow>
  );
}
