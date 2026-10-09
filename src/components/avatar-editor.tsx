import { useId, useState } from "react";
import { ChevronDownIcon, ShuffleIcon } from "lucide-react";

import type { NewWisp, WispChanges } from "@/chat-data";
import type { WispAppearance } from "../../shared/wisp-appearance";
import { WispAvatar } from "@/components/chat-avatar";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Wisp } from "@/components/wisp";
import { cn } from "@/lib/utils";
import { AVATAR_COLORS, appearanceOptions, randomAppearance } from "@/lib/wisp-appearance";

const avatarAction =
  "relative inline-flex justify-center rounded-[9px] border border-border bg-secondary px-3.5 py-2 text-foreground hover:bg-accent";

interface AvatarEditorProps {
  wisp: Pick<NewWisp, "name" | "appearance" | "color">;
  onChange: (changes: WispChanges) => void;
}

type PictureAxis = "trail" | "body" | "eyes";
type TextAxis = "tone" | "eyeInk" | "finish" | "mark";

const PICTURE_AXES: ReadonlyArray<{ key: PictureAxis; label: string }> = [
  { key: "trail", label: "Trail" },
  { key: "body", label: "Body" },
  { key: "eyes", label: "Eyes" },
];

const TEXT_AXES: ReadonlyArray<{ key: TextAxis; label: string }> = [
  { key: "tone", label: "Tone" },
  { key: "eyeInk", label: "Eye color" },
  { key: "finish", label: "Finish" },
  { key: "mark", label: "Mark" },
];

const axisLabel = "text-dim text-sm";
// A label beside its options keeps each axis to one row.
const axisRow = "mb-2.5 grid grid-cols-[56px_minmax(0,1fr)] items-center gap-x-2";

function AvatarEditor({ wisp, onChange }: AvatarEditorProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreId = useId();

  function selectAppearance(changes: Partial<WispAppearance>) {
    onChange({ appearance: { ...wisp.appearance, ...changes } });
  }

  return (
    <div>
      <div className="mb-2 flex justify-center pt-5 pb-3 [&>img]:size-20! [&>img]:overflow-visible [&>svg]:size-20! [&>svg]:overflow-visible">
        <WispAvatar wisp={wisp} size="xl" />
      </div>
      <section className="px-1 pb-3" aria-label="Wisp appearance">
        <header className="mb-2">
          <strong className="text-dim text-sm font-medium">Appearance</strong>
        </header>
        {PICTURE_AXES.map(({ key, label }) => (
          <div className={axisRow} key={key}>
            <span className={axisLabel}>{label}</span>
            <div
              className="grid grid-cols-5 gap-1"
              role="group"
              data-slot="appearance-grid"
              aria-label={`Wisp ${label.toLowerCase()}`}
            >
              {appearanceOptions(key).map((option) => {
                const selected = wisp.appearance[key] === option.value;
                return (
                  <button
                    type="button"
                    data-selected={selected}
                    className="flex h-11 items-center justify-center rounded-xl hover:bg-black/[0.045] data-[selected=true]:bg-accent data-[selected=true]:ring-2 data-[selected=true]:ring-ring dark:hover:bg-white/[0.045]"
                    aria-pressed={selected}
                    aria-label={option.label}
                    title={option.label}
                    key={option.value}
                    onClick={() => selectAppearance({ [key]: option.value })}
                  >
                    <Wisp
                      appearance={{ ...wisp.appearance, [key]: option.value }}
                      color={wisp.color}
                      name={wisp.name}
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className={axisRow}>
          <span className={axisLabel}>Color</span>
          <div
            className="flex w-full max-w-[300px] flex-wrap gap-x-3.5 gap-y-4"
            role="group"
            data-slot="color-grid"
            aria-label="Wisp color"
          >
            {AVATAR_COLORS.map((color) => {
              const selected = wisp.color?.toLowerCase() === color.value.toLowerCase();
              return (
                <button
                  type="button"
                  data-selected={selected}
                  className="aspect-square w-[calc((100%-70px)/6)] max-w-8 flex-none rounded-full border-0 p-0 transition-transform duration-100 hover:scale-[1.08] data-[selected=true]:ring-2 data-[selected=true]:ring-ring data-[selected=true]:ring-offset-2 data-[selected=true]:ring-offset-card"
                  aria-pressed={selected}
                  aria-label={color.label}
                  title={color.label}
                  key={color.id}
                  style={{ backgroundColor: color.value }}
                  onClick={() => onChange({ color: color.value })}
                />
              );
            })}
          </div>
        </div>
        {/* Fewer choices up front keeps the creation step from scrolling. */}
        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            className={cn(avatarAction, "items-center gap-2 [&_svg]:size-3.5")}
            type="button"
            onClick={() => onChange(randomAppearance())}
          >
            <ShuffleIcon aria-hidden="true" />
            Random Wisp
          </button>
          <button
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-dim text-sm hover:text-foreground [&_svg]:size-4 [&_svg]:transition-transform aria-expanded:[&_svg]:rotate-180"
            type="button"
            aria-expanded={moreOpen}
            aria-controls={moreId}
            onClick={() => setMoreOpen((open) => !open)}
          >
            More options
            <ChevronDownIcon aria-hidden="true" />
          </button>
        </div>
        {moreOpen ? (
          <div className="mt-3 grid gap-2.5" id={moreId}>
            {TEXT_AXES.map(({ key, label }) => (
              <div className="flex items-center justify-between gap-3" key={key}>
                <span className={axisLabel}>{label}</span>
                <SegmentedControl
                  label={`Wisp ${label.toLowerCase()}`}
                  value={wisp.appearance[key]}
                  options={appearanceOptions(key)}
                  onChange={(value) => selectAppearance({ [key]: value })}
                />
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

export { AvatarEditor };
