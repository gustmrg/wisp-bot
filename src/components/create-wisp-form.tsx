import type { ReactNode, Ref } from "react";
import {
  WispBehaviorFields,
  WispIdentityFields,
  type WispSettingsChanges,
  type WispSettingsDraft,
} from "@/components/wisp-settings-fields";

/** Creation is split so neither step needs scrolling: how the Wisp looks, then how it works. */
export type CreateWispStep = "identity" | "behavior";

interface CreateWispFormProps {
  settings: WispSettingsDraft;
  step?: CreateWispStep;
  onChange: (changes: WispSettingsChanges) => void;
  ref?: Ref<HTMLDivElement>;
  /** Extra fields shown with the behavior step. */
  children?: ReactNode;
}

export function CreateWispForm({ settings, step = "identity", onChange, ref, children }: CreateWispFormProps) {
  return (
    <div
      ref={ref}
      className="min-h-0 overflow-y-auto px-1 pb-1 [&_[data-slot=color-grid]]:max-w-none [&_[data-slot=color-grid]]:gap-3 [&_[data-slot=color-grid]_button]:w-[26px] [&_[data-slot=appearance-grid]_button]:h-11"
    >
      {step === "identity" ? (
        <WispIdentityFields settings={settings} onChange={onChange} />
      ) : (
        <>
          <WispBehaviorFields settings={settings} onChange={onChange} />
          {children}
        </>
      )}
    </div>
  );
}
