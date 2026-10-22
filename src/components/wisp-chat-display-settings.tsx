import { useState } from "react";

import type { Wisp, WispChanges } from "@/chat-data";
import {
  SettingsCard,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

interface WispChatDisplaySettingsProps {
  wisp: Wisp;
  onChangeWisp: (changes: WispChanges) => Promise<boolean> | void;
}

/** What the chat shows of the Wisp's work, saved as soon as it changes. */
export function WispChatDisplaySettings({ wisp, onChangeWisp }: WispChatDisplaySettingsProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function change(changes: WispChanges): Promise<void> {
    setSaving(true);
    setError("");
    try {
      if ((await onChangeWisp(changes)) === false) setError("Could not save this setting.");
    } catch {
      setError("Could not save this setting.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="In the chat">
      <h3 className="m-0 mb-1.5 text-2xs font-medium uppercase tracking-wide text-dim">In the chat</h3>
      <SettingsCard>
        <SettingsRow className="min-h-0 p-[11px]">
          <SettingsRowCopy>
            <SettingsRowTitle>Show reasoning</SettingsRowTitle>
            <SettingsRowDescription>
              What the model thinks before each reply, folded above it. Needs a model that reasons.
            </SettingsRowDescription>
          </SettingsRowCopy>
          <ToggleSwitch
            checked={wisp.showReasoning === true}
            disabled={saving}
            label="Show reasoning"
            onChange={() => void change({ showReasoning: !wisp.showReasoning })}
          />
        </SettingsRow>
        <SettingsRow className="min-h-0 p-[11px]">
          <SettingsRowCopy>
            <SettingsRowTitle>Verbose steps</SettingsRowTitle>
            <SettingsRowDescription>
              Each command as written and the end of its output, and why a step failed. Commands can carry secrets the
              Wisp was given, and they show here on every device you use.
            </SettingsRowDescription>
          </SettingsRowCopy>
          <ToggleSwitch
            checked={wisp.verboseSteps === true}
            disabled={saving}
            label="Verbose steps"
            onChange={() => void change({ verboseSteps: !wisp.verboseSteps })}
          />
        </SettingsRow>
      </SettingsCard>
      {error ? (
        <p role="alert" className="m-0 mt-1.5 text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
