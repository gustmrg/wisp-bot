import type { ReactNode, Ref } from "react";
import {
  WispBehaviorFields,
  WispIdentityFields,
  type WispSettingsChanges,
  type WispSettingsDraft,
} from "@/components/wisp-settings-fields";

/**
 * Creation is split so no step needs scrolling: how the Wisp looks, how it
 * works, where it works, and, from a template, the skills and access it brings.
 */
export type CreateWispStep = "identity" | "behavior" | "setup" | "template";

interface CreateWispFormProps {
  settings: WispSettingsDraft;
  step?: CreateWispStep;
  onChange: (changes: WispSettingsChanges) => void;
  ref?: Ref<HTMLDivElement>;
  /** Extra fields shown with the behavior step. */
  children?: ReactNode;
  /** The setup step's fields. */
  setup?: ReactNode;
  /** The template step's fields. */
  template?: ReactNode;
}

export function CreateWispForm({
  settings,
  step = "identity",
  onChange,
  ref,
  children,
  setup,
  template,
}: CreateWispFormProps) {
  return (
    <div
      ref={ref}
      className="min-h-0 overflow-y-auto px-1 pb-1 [&_[data-slot=color-grid]]:max-w-none [&_[data-slot=color-grid]]:gap-3 [&_[data-slot=color-grid]_button]:w-[26px] [&_[data-slot=appearance-grid]_button]:h-11"
    >
      {step === "identity" ? (
        <WispIdentityFields settings={settings} onChange={onChange} />
      ) : step === "setup" ? (
        setup
      ) : step === "template" ? (
        template
      ) : (
        <>
          <WispBehaviorFields settings={settings} onChange={onChange} />
          {children}
        </>
      )}
    </div>
  );
}
