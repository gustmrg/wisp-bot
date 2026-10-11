import { HourglassIcon } from "lucide-react";

import type { ModelSummary, ThinkingLevel } from "../../shared/contracts";
import {
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** Only reasoning models with a level besides "off" offer a choice. */
export function canChooseThinkingLevel(model: ModelSummary | undefined): model is ModelSummary {
  return Boolean(model?.reasoning && model.thinkingLevels.length > 1);
}

/**
 * The level a model runs at: the chosen one when the model supports it,
 * otherwise "off", or the lowest level for a model that always reasons.
 */
export function keepThinkingLevel(level: ThinkingLevel, model: ModelSummary | undefined): ThinkingLevel {
  const levels = model?.thinkingLevels ?? [];
  if (levels.includes(level)) return level;
  return levels.includes("off") ? "off" : (levels[0] ?? "off");
}

/** Says that reasoning costs more and answers slower, wherever a level other than "off" is chosen. */
export function ThinkingCostNote() {
  return (
    <span className="flex items-center gap-1 text-xs text-warning [&_svg]:size-3 [&_svg]:flex-none">
      <HourglassIcon aria-hidden="true" />
      Reasoning uses more tokens and makes replies slower; higher levels cost more.
    </span>
  );
}

interface ThinkingLevelRowProps {
  id: string;
  model: ModelSummary;
  value: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
  className?: string;
}

/** A settings row that chooses how much a reasoning model thinks, listing only the levels it supports. */
export function ThinkingLevelRow({ id, model, value, onChange, disabled, className }: ThinkingLevelRowProps) {
  const levels = model.thinkingLevels;
  return (
    <SettingsRow className={className}>
      <SettingsRowCopy>
        <SettingsRowTitle htmlFor={id}>Reasoning</SettingsRowTitle>
        <SettingsRowDescription>How much the model thinks before it answers.</SettingsRowDescription>
        {value !== "off" ? <ThinkingCostNote /> : null}
      </SettingsRowCopy>
      <Select
        items={levels.map((level) => ({ value: level, label: THINKING_LEVEL_LABELS[level] }))}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null) onChange(next as ThinkingLevel);
        }}
      >
        <SelectTrigger id={id} className="w-[160px] max-w-[45%]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end" alignItemWithTrigger={false}>
          <SelectGroup>
            {levels.map((level) => (
              <SelectItem key={level} value={level}>
                {THINKING_LEVEL_LABELS[level]}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}
