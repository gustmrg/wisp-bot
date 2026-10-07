import { useState } from "react";

import {
  WISP_NAME_MAX_LENGTH,
  WISP_ROLE_MAX_LENGTH,
  WISP_SOUL_MAX_LENGTH,
  type NewWisp,
  type WispChanges,
} from "../../shared/conversations";
import { AvatarEditor } from "@/components/avatar-editor";
import { MarkdownView } from "@/components/markdown-view";
import { SettingsCard, SettingsField, SettingsRow, SettingsRowCopy } from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { SOUL_TEMPLATES, soulFromTemplate } from "@/lib/soul-templates";

/** A Wisp as its settings form edits it, with its conversation's notification setting. */
export type WispSettingsDraft = NewWisp & { notifyOnUpdatesEnabled: boolean };
export type WispSettingsChanges = WispChanges & { notifyOnUpdatesEnabled?: boolean };

interface WispSettingsFieldsProps {
  settings: WispSettingsDraft;
  onChange: (changes: WispSettingsChanges) => void;
}

/** Appearance, name, and role: how the Wisp shows up in the app. */
function WispIdentityFields({ settings, onChange }: WispSettingsFieldsProps) {
  return (
    <>
      <AvatarEditor wisp={settings} onChange={onChange} />
      <SettingsField label="Name">
        <Input
          value={settings.name}
          required
          maxLength={WISP_NAME_MAX_LENGTH}
          placeholder="New Wisp"
          onChange={(event) => onChange({ name: event.currentTarget.value })}
        />
      </SettingsField>
      <SettingsField label="Role (optional)">
        <Input
          value={settings.role}
          maxLength={WISP_ROLE_MAX_LENGTH}
          placeholder="Research, marketing, admin"
          onChange={(event) => onChange({ role: event.currentTarget.value })}
        />
      </SettingsField>
    </>
  );
}

type SoulMode = "edit" | "preview";

const SOUL_MODES = [
  { value: "edit", label: "Edit" },
  { value: "preview", label: "Preview" },
] as const;

/** The Wisp's soul: a markdown document that defines who it is and how it behaves. */
function WispSoulField({ soul, onChange }: { soul: string; onChange: (soul: string) => void }) {
  const [mode, setMode] = useState<SoulMode>("edit");
  return (
    <section className="mb-3 flex flex-col gap-[5px]" aria-labelledby="wisp-soul-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id="wisp-soul-title" className="text-xs text-dim">
          Soul
        </span>
        <SegmentedControl<SoulMode> label="Soul view" value={mode} options={SOUL_MODES} onChange={setMode} />
      </div>
      <p className="m-0 text-xs text-dim">
        Who this Wisp is: its identity, personality, and how it behaves. It follows this in every conversation. Markdown
        is supported.
      </p>
      {mode === "edit" ? (
        <Textarea
          rows={10}
          value={soul}
          maxLength={WISP_SOUL_MAX_LENGTH}
          aria-labelledby="wisp-soul-title"
          className="font-mono text-sm"
          placeholder={"# Identity\nA research assistant who…"}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      ) : (
        <div className="min-h-[120px] rounded-md border border-border p-3 text-base">
          {soul.trim() ? <MarkdownView text={soul} /> : <p className="m-0 text-dim">Nothing written yet.</p>}
        </div>
      )}
      {mode === "edit" && !soul.trim() ? (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Soul templates">
          <span className="text-xs text-dim">Start from a template:</span>
          {SOUL_TEMPLATES.map((template) => (
            <Button
              key={template.id}
              type="button"
              variant="outline"
              size="xs"
              onClick={() => onChange(soulFromTemplate(template))}
            >
              {template.label}
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Soul and notifications: how the Wisp works. */
function WispBehaviorFields({ settings, onChange }: WispSettingsFieldsProps) {
  return (
    <>
      <WispSoulField soul={settings.soul} onChange={(soul) => onChange({ soul })} />
      <SettingsCard className="mt-[15px]">
        <SettingsRow className="min-h-0 p-[11px]">
          <SettingsRowCopy>
            <strong className="text-sm">Notifications</strong>
            <small className="text-dim text-xs leading-[1.3]">
              Get notified when this Wisp finishes or needs input
            </small>
          </SettingsRowCopy>
          <ToggleSwitch
            checked={settings.notifyOnUpdatesEnabled}
            label="Notifications"
            onChange={() => onChange({ notifyOnUpdatesEnabled: !settings.notifyOnUpdatesEnabled })}
          />
        </SettingsRow>
      </SettingsCard>
    </>
  );
}

function WispSettingsFields(props: WispSettingsFieldsProps) {
  return (
    <>
      <WispIdentityFields {...props} />
      <WispBehaviorFields {...props} />
    </>
  );
}

export { WispBehaviorFields, WispIdentityFields, WispSettingsFields };
