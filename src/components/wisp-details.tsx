import { useState } from "react";

import type { WispChat, WispChatChanges } from "@/chat-data";
import { WispSettingsFields } from "@/components/wisp-settings-fields";
import { WispSessionReportSection } from "@/components/wisp-session-report";
import { Button } from "@/components/ui/button";

interface WispDetailsProps {
  chat: WispChat;
  onChange: (changes: WispChatChanges) => Promise<boolean> | void;
}

export function WispDetails({ chat, onChange }: WispDetailsProps) {
  const [draft, setDraft] = useState(chat);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty =
    draft.name !== chat.name ||
    draft.label !== chat.label ||
    draft.description !== chat.description ||
    draft.color !== chat.color ||
    draft.avatarImage !== chat.avatarImage ||
    draft.shape !== chat.shape ||
    draft.notifyOnUpdatesEnabled !== chat.notifyOnUpdatesEnabled;

  async function save() {
    const name = draft.name.trim() || "Untitled";
    setSaving(true);
    setError("");
    try {
      const saved = await onChange({
        kind: "wisp",
        name,
        label: draft.label,
        description: draft.description,
        color: draft.color,
        avatarImage: draft.avatarImage,
        shape: draft.shape,
        notifyOnUpdatesEnabled: draft.notifyOnUpdatesEnabled,
      });
      if (saved === false) {
        setError("Could not save Wisp settings.");
        return;
      }
      setDraft((current) => ({ ...current, name }));
    } catch {
      setError("Could not save Wisp settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <WispSettingsFields
        settings={draft}
        onChange={(changes) => setDraft((current) => ({ ...current, ...changes }))}
      />
      {error ? (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button className="mt-[15px] w-full" type="button" disabled={!dirty || saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save changes"}
      </Button>
      <WispSessionReportSection chatId={chat.id} />
    </>
  );
}
