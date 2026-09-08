import { type ReactNode, useEffect, useState } from "react";
import type { WispChat, WispChatChanges } from "@/chat-data";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WispContextSettings } from "@/components/wisp-context-settings";
import { WispModelSettings } from "@/components/wisp-model-settings";
import { WispSessionReportSection } from "@/components/wisp-session-report";
import { WispSettingsFields } from "@/components/wisp-settings-fields";

interface WispDetailsProps {
  chat: WispChat;
  generalActions?: ReactNode;
  onChange: (changes: WispChatChanges, expectedRevision?: number) => Promise<boolean> | void;
}

export function WispDetails({ chat, onChange, generalActions }: WispDetailsProps) {
  const [tab, setTab] = useState("general");
  const [visited, setVisited] = useState(() => new Set(["general"]));
  const [draft, setDraft] = useState(chat);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [refreshAfterSave, setRefreshAfterSave] = useState(false);
  useEffect(() => {
    if (!refreshAfterSave) return;
    // The mutation response replaces the parent snapshot before onChange resolves.
    // Refresh fields and revision together, including any subsequent server update.
    setDraft(chat);
    setRefreshAfterSave(false);
  }, [chat, refreshAfterSave]);
  const dirty =
    draft.name !== chat.name ||
    draft.label !== chat.label ||
    draft.description !== chat.description ||
    draft.color !== chat.color ||
    draft.avatarImage !== chat.avatarImage ||
    draft.shape !== chat.shape ||
    draft.notifyOnUpdatesEnabled !== chat.notifyOnUpdatesEnabled;

  function reloadFromServer() {
    // Chat is the most recent authoritative snapshot; the draft retains its previous revision until this action.
    setDraft(chat);
    setError("");
  }

  async function save() {
    const name = draft.name.trim() || "Untitled";
    setSaving(true);
    setError("");
    try {
      const changes: WispChatChanges = {
        kind: "wisp",
        name,
        label: draft.label,
        description: draft.description,
        color: draft.color,
        avatarImage: draft.avatarImage,
        shape: draft.shape,
        notifyOnUpdatesEnabled: draft.notifyOnUpdatesEnabled,
      };
      const saved = await (draft.revision === undefined ? onChange(changes) : onChange(changes, draft.revision));
      if (saved === false) {
        setError("Could not save Wisp settings.");
        return;
      }
      setRefreshAfterSave(true);
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
          <fieldset disabled={saving} className="min-w-0 border-0 p-0">
            <WispSettingsFields
              settings={draft}
              onChange={(changes) => setDraft((current) => ({ ...current, ...changes }))}
            />
          </fieldset>
          <WispContextSettings conversationId={chat.id} />
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
          {chat.revision !== undefined && chat.revision !== draft.revision ? (
            <p className="mb-3 text-sm text-dim" role="status">
              This Wisp changed on the server. Reload before saving your changes.
            </p>
          ) : null}
          {error || (chat.revision !== undefined && chat.revision !== draft.revision) ? (
            <Button className="mb-2 w-full" variant="outline" disabled={saving} onClick={reloadFromServer}>
              Reload server settings
            </Button>
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
