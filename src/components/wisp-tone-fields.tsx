import {
  DEFAULT_WISP_TONE,
  WISP_RESPONSE_LENGTH_LABELS,
  WISP_RESPONSE_LENGTHS,
  WISP_TONE_CUSTOM_MAX_LENGTH,
  WISP_TONE_STYLE_LABELS,
  WISP_TONE_STYLES,
  type WispResponseLength,
  type WispTone,
  type WispToneStyle,
} from "../../shared/wisp-tone";
import { SettingsCard, SettingsRow, SettingsRowCopy } from "@/components/settings/settings-primitives";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface WispToneFieldsProps {
  tone: WispTone | undefined;
  onChange: (tone: WispTone) => void;
}

const STYLE_ITEMS = WISP_TONE_STYLES.map((value) => ({ value, label: WISP_TONE_STYLE_LABELS[value] }));
const LENGTH_OPTIONS = WISP_RESPONSE_LENGTHS.map((value) => ({ value, label: WISP_RESPONSE_LENGTH_LABELS[value] }));

/** Tone and response length. Explicit requests in a message still take precedence. */
export function WispToneFields({ tone = DEFAULT_WISP_TONE, onChange }: WispToneFieldsProps) {
  return (
    <SettingsCard variant="stacked" className="mt-[15px]">
      <SettingsRow className="min-h-0 flex-col items-stretch gap-2 p-[11px]">
        <SettingsRowCopy>
          <label htmlFor="wisp-tone-style">
            <strong>Tone</strong>
          </label>
          <small>Default follows your response preferences in your profile.</small>
        </SettingsRowCopy>
        <Select
          items={STYLE_ITEMS}
          value={tone.style}
          onValueChange={(value) => {
            if (value !== null) onChange({ ...tone, style: value as WispToneStyle });
          }}
        >
          <SelectTrigger id="wisp-tone-style" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {STYLE_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {tone.style === "custom" ? (
          <Textarea
            rows={2}
            value={tone.custom}
            maxLength={WISP_TONE_CUSTOM_MAX_LENGTH}
            aria-label="Custom tone"
            placeholder="Describe how this Wisp should sound, for example: upbeat and witty, but never sarcastic"
            onChange={(event) => onChange({ ...tone, custom: event.currentTarget.value })}
          />
        ) : null}
      </SettingsRow>
      {/* Wraps the control below the label when the panel is too narrow for both. */}
      <SettingsRow className="min-h-0 flex-wrap gap-y-2 p-[11px]">
        <SettingsRowCopy className="min-w-fit">
          <strong>Response length</strong>
        </SettingsRowCopy>
        <SegmentedControl<WispResponseLength>
          label="Response length"
          value={tone.length}
          options={LENGTH_OPTIONS}
          onChange={(length) => onChange({ ...tone, length })}
        />
      </SettingsRow>
    </SettingsCard>
  );
}
