import { InfoIcon } from "lucide-react";

import type { ModelSummary, ThinkingLevel } from "../../shared/contracts";
import {
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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

/** An (i) beside the Reasoning title that says, on hover or tap, that reasoning costs more and answers slower. */
function ThinkingCostInfo() {
  return (
    <Popover>
      <PopoverTrigger
        type="button"
        openOnHover
        delay={150}
        aria-label="About reasoning cost"
        className="inline-flex size-5 flex-none items-center justify-center rounded-full text-dim outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-3.5"
      >
        <InfoIcon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2.5 text-xs leading-relaxed">
        Reasoning uses more tokens and makes replies slower; higher levels cost more.
      </PopoverContent>
    </Popover>
  );
}

interface ThinkingLevelRowProps {
  id: string;
  model: ModelSummary;
  value: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
  /** Puts the select beside the title and the copy below both, for a narrow panel. */
  stacked?: boolean;
  className?: string;
}

/** A settings row that chooses how much a reasoning model thinks, listing only the levels it supports. */
export function ThinkingLevelRow({ id, model, value, onChange, disabled, stacked, className }: ThinkingLevelRowProps) {
  const levels = model.thinkingLevels;
  const title = (
    <span className="flex items-center gap-1">
      <SettingsRowTitle htmlFor={id}>Reasoning</SettingsRowTitle>
      <ThinkingCostInfo />
    </span>
  );
  const copy = <SettingsRowDescription>How much the model thinks before it answers.</SettingsRowDescription>;
  const select = (
    <Select
      items={levels.map((level) => ({ value: level, label: THINKING_LEVEL_LABELS[level] }))}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next as ThinkingLevel);
      }}
    >
      <SelectTrigger id={id} className={stacked ? "w-[140px]" : "w-[160px] max-w-[45%]"}>
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
  );
  if (stacked) {
    return (
      <div className={cn("flex flex-col gap-1.5", className)}>
        <div className="flex items-center justify-between gap-3">
          {title}
          {select}
        </div>
        {copy}
      </div>
    );
  }
  return (
    <SettingsRow className={className}>
      <SettingsRowCopy>
        {title}
        {copy}
      </SettingsRowCopy>
      {select}
    </SettingsRow>
  );
}
