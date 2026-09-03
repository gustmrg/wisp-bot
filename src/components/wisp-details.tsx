import type { WispChat, WispChatChanges } from "@/chat-data";
import { WispSettingsFields } from "@/components/wisp-settings-fields";

interface WispDetailsProps {
  chat: WispChat;
  onChange: (changes: WispChatChanges) => void;
}

export function WispDetails({ chat, onChange }: WispDetailsProps) {
  return (
    <WispSettingsFields
      settings={chat}
      onChange={(changes) =>
        onChange({ kind: "wisp", ...changes, ...(changes.name === "" ? { name: "Untitled" } : {}) })
      }
    />
  );
}
