import { useState } from "react";
import type { KeyboardEvent } from "react";

import { SettingsCard, SettingsGroup, SettingsRow, SettingsRowCopy } from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import type { AppPreferences } from "@/lib/app-preferences";
import {
  DEFAULT_SHORTCUTS,
  formatShortcut,
  reservedShortcutLabel,
  SHORTCUT_LABELS,
  shortcutFromEvent,
  shortcutKeys,
  type ShortcutId,
} from "@/lib/shortcuts";

interface ShortcutSettingsSectionProps {
  active: boolean;
  preferences: AppPreferences;
  onPreferencesChange: (preferences: AppPreferences) => void;
}

/** Built-in keys that cannot be changed, listed so the whole keyboard map is in one place. */
const FIXED_SHORTCUTS: ReadonlyArray<{ label: string; keys: ReadonlyArray<string> }> = [
  { label: "Search conversations", keys: shortcutKeys("Ctrl+KeyK") },
  { label: "Send message", keys: ["Enter"] },
  { label: "New line", keys: ["Shift", "Enter"] },
  { label: "Cancel voice recording", keys: ["Esc"] },
];

function Keys({ keys }: { keys: ReadonlyArray<string> }) {
  return (
    <span className="flex flex-none items-center gap-1">
      {keys.map((key) => (
        <kbd
          key={key}
          className="min-w-[22px] rounded-[5px] border border-border bg-muted px-1.5 py-px text-center font-sans text-[11px] text-foreground"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

function ShortcutSettingsSection({ active, preferences, onPreferencesChange }: ShortcutSettingsSectionProps) {
  const [editing, setEditing] = useState<ShortcutId | null>(null);
  const [notice, setNotice] = useState("");

  function save(id: ShortcutId, shortcut: string): void {
    onPreferencesChange({ ...preferences, shortcuts: { ...preferences.shortcuts, [id]: shortcut } });
    setEditing(null);
    setNotice(`${SHORTCUT_LABELS[id]}: ${formatShortcut(shortcut)}.`);
  }

  function handleRecorderKeyDown(id: ShortcutId, event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "Tab") return;
    // Keep keys away from the dialog, which would close on Escape, and from the composer.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setEditing(null);
      setNotice("Shortcut unchanged.");
      return;
    }
    if (["Control", "Alt", "Shift", "Meta", "OS"].includes(event.key)) return;
    const shortcut = shortcutFromEvent(event.nativeEvent);
    if (!shortcut) {
      setNotice("Use Ctrl, Alt, or Super together with another key, or a function key.");
      return;
    }
    const reserved = reservedShortcutLabel(shortcut);
    if (reserved) {
      setNotice(`${formatShortcut(shortcut)} is already used for ${reserved}.`);
      return;
    }
    save(id, shortcut);
  }

  return (
    <section
      className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5 [&>*]:max-w-[760px]"
      id="shortcut-settings-panel"
      aria-labelledby="shortcut-settings-title"
      hidden={!active}
    >
      <h2 id="shortcut-settings-title" className="mb-[22px] mt-0 text-[17px]">
        Shortcuts
      </h2>
      <div className="animate-tab-forward">
        <SettingsGroup label="Customizable">
          <SettingsCard variant="stacked">
            {(Object.keys(SHORTCUT_LABELS) as ShortcutId[]).map((id) => {
              const shortcut = preferences.shortcuts[id];
              const recording = editing === id;
              return (
                <SettingsRow key={id}>
                  <SettingsRowCopy>
                    <strong>{SHORTCUT_LABELS[id]}</strong>
                    <small>Works while a conversation is open.</small>
                  </SettingsRowCopy>
                  <div className="flex flex-none items-center gap-2">
                    {recording ? null : <Keys keys={shortcutKeys(shortcut)} />}
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      aria-label={
                        recording
                          ? `Press the new shortcut for ${SHORTCUT_LABELS[id]}, or Escape to cancel`
                          : `Change shortcut for ${SHORTCUT_LABELS[id]}`
                      }
                      // Focus moves here when recording starts, so the next key press lands on this button.
                      ref={(button) => {
                        if (recording) button?.focus();
                      }}
                      onClick={() => {
                        setEditing(recording ? null : id);
                        setNotice(recording ? "Shortcut unchanged." : "");
                      }}
                      onBlur={() => {
                        if (recording) setEditing(null);
                      }}
                      onKeyDown={recording ? (event) => handleRecorderKeyDown(id, event) : undefined}
                    >
                      {recording ? "Press keys…" : "Change"}
                    </Button>
                    {shortcut !== DEFAULT_SHORTCUTS[id] && !recording ? (
                      <Button variant="ghost" size="sm" type="button" onClick={() => save(id, DEFAULT_SHORTCUTS[id])}>
                        Reset
                      </Button>
                    ) : null}
                  </div>
                </SettingsRow>
              );
            })}
          </SettingsCard>
        </SettingsGroup>
        <p className="mx-0.5 mt-[7px] text-dim text-[11px] leading-[1.45]" role="status" aria-live="polite">
          {notice}
        </p>
        <SettingsGroup label="Built-in">
          <SettingsCard variant="stacked">
            {FIXED_SHORTCUTS.map((item) => (
              <SettingsRow key={item.label}>
                <SettingsRowCopy>
                  <strong>{item.label}</strong>
                </SettingsRowCopy>
                <Keys keys={item.keys} />
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsGroup>
      </div>
    </section>
  );
}

export { ShortcutSettingsSection };
