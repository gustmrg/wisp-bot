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
import {
  SettingsCard,
  SettingsField,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { SOUL_TEMPLATES, soulFromTemplate, type SoulTemplate } from "@/lib/soul-templates";

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
  // A template picked over edited text, waiting for the person to confirm losing the edits.
  const [pendingTemplate, setPendingTemplate] = useState<SoulTemplate | null>(null);
  const applied = SOUL_TEMPLATES.find((template) => soulFromTemplate(template) === soul);

  function chooseTemplate(template: SoulTemplate) {
    // An empty soul or an untouched template has nothing to lose.
    if (!soul.trim() || applied) {
      setPendingTemplate(null);
      onChange(soulFromTemplate(template));
    } else setPendingTemplate(template);
  }

  return (
    <Field className="mb-3" role="group" aria-labelledby="wisp-soul-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldTitle id="wisp-soul-title">Soul</FieldTitle>
        <div className="flex items-center gap-2">
          {soul.trim() ? (
            <Select
              items={SOUL_TEMPLATES.map(({ id, label }) => ({ value: id, label }))}
              value={applied?.id ?? null}
              onValueChange={(id) => {
                const template = SOUL_TEMPLATES.find((item) => item.id === id);
                if (template && template !== applied) chooseTemplate(template);
              }}
            >
              <SelectTrigger size="sm" aria-label="Soul template" className="min-w-[110px]">
                <SelectValue placeholder="Template" />
              </SelectTrigger>
              <SelectContent align="end" alignItemWithTrigger={false}>
                <SelectGroup>
                  {SOUL_TEMPLATES.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : null}
          <SegmentedControl<SoulMode> label="Soul view" value={mode} options={SOUL_MODES} onChange={setMode} />
        </div>
      </div>
      <FieldDescription>
        Who this Wisp is: its identity, personality, and how it behaves. It follows this in every conversation. Markdown
        is supported.
      </FieldDescription>
      {pendingTemplate ? (
        <div
          role="alert"
          className="space-y-2.5 rounded-[10px] border border-warning-solid/40 bg-warning-solid/10 p-3 text-xs leading-relaxed"
        >
          <p className="m-0">
            <strong className="font-medium">Replace the soul with the {pendingTemplate.label} template?</strong> What
            you wrote is lost.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setPendingTemplate(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onChange(soulFromTemplate(pendingTemplate));
                setPendingTemplate(null);
              }}
            >
              Replace
            </Button>
          </div>
        </div>
      ) : null}
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
          <FieldTitle>Start from a template:</FieldTitle>
          {SOUL_TEMPLATES.map((template) => (
            <Button
              key={template.id}
              type="button"
              variant="outline"
              size="xs"
              onClick={() => chooseTemplate(template)}
            >
              {template.label}
            </Button>
          ))}
        </div>
      ) : null}
    </Field>
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
            <SettingsRowTitle>Notifications</SettingsRowTitle>
            <SettingsRowDescription>Get notified when this Wisp finishes or needs input</SettingsRowDescription>
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
