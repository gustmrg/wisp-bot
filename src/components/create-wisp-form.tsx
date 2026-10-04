import type { ReactNode } from "react";
import type { WispChatChanges, WispSummary } from "@/chat-data";
import { WispSettingsFields } from "@/components/wisp-settings-fields";

interface CreateWispFormProps {
  settings: WispSummary;
  onChange: (changes: Omit<WispChatChanges, "kind">) => void;
  children?: ReactNode;
}

export function CreateWispForm({ settings, onChange, children }: CreateWispFormProps) {
  return (
    <div className="min-h-0 overflow-y-auto px-1 pb-1 [&_[data-slot=color-grid]]:max-w-none [&_[data-slot=color-grid]]:gap-3 [&_[data-slot=color-grid]_button]:w-[26px] [&_[data-slot=shape-grid]]:mb-[18px] [&_[data-slot=shape-grid]]:grid-cols-8 [&_[data-slot=shape-grid]]:gap-1.5 [&_[data-slot=shape-grid]_button]:h-11 max-[540px]:[&_[data-slot=shape-grid]]:grid-cols-4">
      <WispSettingsFields settings={settings} onChange={onChange} />
      {children}
    </div>
  );
}
