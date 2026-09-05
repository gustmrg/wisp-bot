import { useState, type ReactNode } from "react";

import type { WispChat, WispChatChanges } from "@/chat-data";
import { WispModelSettings } from "@/components/wisp-model-settings";
import { WispSettingsFields } from "@/components/wisp-settings-fields";
import { WispSessionReportSection } from "@/components/wisp-session-report";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";

interface WispDetailsProps {
  chat: WispChat;
  generalActions?: ReactNode;
  onChange: (changes: WispChatChanges) => Promise<boolean> | void;
}

export function WispDetails({ chat, onChange, generalActions }: WispDetailsProps) {
  const [tab, setTab] = useState("general");
  const [visited, setVisited] = useState(() => new Set(["general"]));
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
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (typeof value !== "string") return;
        setTab(value);
        setVisited((current) => (current.has(value) ? current : new Set([...current, value])));
      }}
      className="min-h-0 flex-1 gap-0 overflow-hidden"
    >
      <div className="flex-none border-b border-border px-3.5 py-3">
        <TabsList className="w-full" aria-label="Wisp settings sections">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="model">Model</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="general" keepMounted className="flex min-h-0 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
          <WispSettingsFields
            settings={draft}
            onChange={(changes) => setDraft((current) => ({ ...current, ...changes }))}
          />
          {generalActions ? (
            <div className="mt-5 flex flex-col gap-2 border-t border-border pt-4">{generalActions}</div>
          ) : null}
        </div>
        <footer className="flex-none border-t border-border p-3.5">
          {error ? (
            <p className="mb-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Button className="w-full" type="button" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </footer>
      </TabsContent>
      <TabsContent value="model" keepMounted className="flex min-h-0 flex-col overflow-hidden">
        {visited.has("model") ? <WispModelSettings conversationId={chat.id} /> : null}
      </TabsContent>
      <TabsContent value="usage" keepMounted className="min-h-0 overflow-y-auto p-3.5">
        {visited.has("usage") ? <WispSessionReportSection chatId={chat.id} active={tab === "usage"} /> : null}
      </TabsContent>
    </Tabs>
  );
}
