import { type ReactNode, useState } from "react";

import type { WispChanges, WispChatView } from "@/chat-data";
import { SettingsActions, SettingsGroup } from "@/components/settings/settings-primitives";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WispContextSettings } from "@/components/wisp-context-settings";
import { WispExecutionSettings } from "@/components/wisp-execution-settings";
import { WispJobSettings } from "@/components/wisp-job-settings";
import { WispModelSettings } from "@/components/wisp-model-settings";
import { WispPluginSettings } from "@/components/wisp-plugin-settings";
import { WispSessionReportSection } from "@/components/wisp-session-report";
import { WispBehaviorFields, WispIdentityFields, type WispSettingsDraft } from "@/components/wisp-settings-fields";
import { WispSkillSettings } from "@/components/wisp-skill-settings";
import { WispWorkspaceSettings } from "@/components/wisp-workspace-settings";
import type { IntegrationSettingsTarget } from "@/lib/plugin-access";
import { cn } from "@/lib/utils";
import { sameWispAppearance } from "../../shared/wisp-appearance";

const TAB_ORDER = ["general", "model", "access", "usage"] as const;

/** The tabs of a Wisp's settings on the desktop. */
export type WispSettingsTab = (typeof TAB_ORDER)[number];

interface WispDetailsProps {
  chat: WispChatView;
  /** The tab shown first. */
  initialTab?: WispSettingsTab;
  generalActions?: ReactNode;
  /** Saves the Wisp's own settings. */
  onChangeWisp: (changes: WispChanges) => Promise<boolean> | void;
  /** Saves its conversation's notification setting. */
  onChangeNotifications: (notifyOnUpdatesEnabled: boolean) => Promise<boolean> | void;
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
}

function draftOf(chat: WispChatView): WispSettingsDraft {
  const { id: _id, ...wisp } = chat.wisp;
  return { ...wisp, notifyOnUpdatesEnabled: chat.notifyOnUpdatesEnabled };
}

/** One of the General tab's sections: its panel loads the first time it is opened, and stays mounted. */
/** A section that loads its contents the first time it is opened. */
export function SettingsAccordionSection({
  value,
  label,
  children,
}: {
  value: string;
  label: string;
  children: ReactNode;
}) {
  const [visited, setVisited] = useState(false);
  return (
    <AccordionItem
      value={value}
      onOpenChange={(open) => {
        if (open) setVisited(true);
      }}
    >
      <AccordionTrigger>{label}</AccordionTrigger>
      <AccordionContent keepMounted>{visited ? children : null}</AccordionContent>
    </AccordionItem>
  );
}

export function WispDetails({
  chat,
  onChangeWisp,
  onChangeNotifications,
  onOpenSettings,
  generalActions,
  initialTab = "general",
}: WispDetailsProps) {
  const [tab, setTab] = useState<string>(initialTab);
  const [slideDirection, setSlideDirection] = useState<"forward" | "back">("forward");
  const [visited, setVisited] = useState(() => new Set(["general", initialTab]));
  const [draft, setDraft] = useState(() => draftOf(chat));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { wisp } = chat;
  const wispChanged =
    draft.name !== wisp.name ||
    draft.role !== wisp.role ||
    draft.soul !== wisp.soul ||
    draft.color !== wisp.color ||
    !sameWispAppearance(draft.appearance, wisp.appearance);
  const notificationsChanged = draft.notifyOnUpdatesEnabled !== chat.notifyOnUpdatesEnabled;
  const profileChanged = wispChanged || notificationsChanged;
  const slideClass = slideDirection === "forward" ? "animate-tab-forward" : "animate-tab-back";

  async function save() {
    const name = draft.name.trim() || "Untitled";
    setSaving(true);
    setError("");
    try {
      if (wispChanged) {
        const saved = await onChangeWisp({
          name,
          role: draft.role,
          soul: draft.soul,
          color: draft.color,
          appearance: draft.appearance,
        });
        if (saved === false) {
          setError("Could not save Wisp settings.");
          return;
        }
      }
      if (notificationsChanged && (await onChangeNotifications(draft.notifyOnUpdatesEnabled)) === false) {
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
        const nextIndex = TAB_ORDER.indexOf(value as WispSettingsTab);
        const currentIndex = TAB_ORDER.indexOf(tab as WispSettingsTab);
        if (nextIndex >= 0 && currentIndex >= 0 && nextIndex !== currentIndex) {
          setSlideDirection(nextIndex > currentIndex ? "forward" : "back");
        }
        setTab(value);
        setVisited((current) => (current.has(value) ? current : new Set([...current, value])));
      }}
      className="min-h-0 flex-1 gap-0 overflow-hidden"
    >
      <div className="flex-none border-b border-border px-3.5 py-3">
        <TabsList className="w-full" aria-label="Wisp settings sections">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="model">Model</TabsTrigger>
          <TabsTrigger value="access">Access</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent
        value="general"
        keepMounted
        className={cn("flex min-h-0 flex-col overflow-hidden", tab === "general" && slideClass)}
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
          <SettingsGroup label="Profile" className="[&>h3]:mt-0">
            <WispIdentityFields
              settings={draft}
              onChange={(changes) => setDraft((current) => ({ ...current, ...changes }))}
            />
            <WispBehaviorFields
              settings={draft}
              onChange={(changes) => setDraft((current) => ({ ...current, ...changes }))}
            />
          </SettingsGroup>
          {/* Each of these sections saves its own changes. */}
          <Accordion multiple className="mt-4 border-t border-border">
            <SettingsAccordionSection value="context" label="Context & memory">
              <WispContextSettings conversationId={chat.id} />
            </SettingsAccordionSection>
            <SettingsAccordionSection value="skills" label="Skills">
              <WispSkillSettings conversationId={chat.id} />
            </SettingsAccordionSection>
            <SettingsAccordionSection value="workspace" label="Workspace">
              <WispWorkspaceSettings conversationId={chat.id} onOpenSettings={onOpenSettings} />
            </SettingsAccordionSection>
            <SettingsAccordionSection value="commands" label="Commands & browser">
              <WispExecutionSettings conversationId={chat.id} />
            </SettingsAccordionSection>
            <SettingsAccordionSection value="jobs" label="Jobs">
              <WispJobSettings conversationId={chat.id} onOpenSettings={onOpenSettings} />
            </SettingsAccordionSection>
          </Accordion>
          {generalActions ? (
            <SettingsActions className="mt-5 border-t border-border pt-4">{generalActions}</SettingsActions>
          ) : null}
        </div>
        {profileChanged ? (
          <footer className="flex flex-none flex-col gap-3 border-t border-border p-3.5">
            <FormStatus error={error} />
            <div className="flex gap-2 min-[761px]:justify-end">
              <Button
                className="max-[760px]:flex-1"
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setDraft(draftOf(chat));
                  setError("");
                }}
              >
                Discard
              </Button>
              <Button className="max-[760px]:flex-1" type="button" disabled={saving} onClick={() => void save()}>
                {saving ? "Saving…" : "Save profile"}
              </Button>
            </div>
          </footer>
        ) : null}
      </TabsContent>
      <TabsContent
        value="model"
        keepMounted
        className={cn("flex min-h-0 flex-col overflow-hidden", tab === "model" && slideClass)}
      >
        {visited.has("model") ? <WispModelSettings conversationId={chat.id} /> : null}
      </TabsContent>
      <TabsContent
        value="usage"
        keepMounted
        className={cn("min-h-0 overflow-y-auto p-3.5", tab === "usage" && slideClass)}
      >
        {visited.has("usage") ? (
          <WispSessionReportSection chatId={chat.id} active={tab === "usage"} onOpenSettings={onOpenSettings} />
        ) : null}
      </TabsContent>
      <TabsContent
        value="access"
        className={cn("flex min-h-0 flex-col overflow-hidden", tab === "access" && slideClass)}
      >
        {tab === "access" ? <WispPluginSettings conversationId={chat.id} onOpenSettings={onOpenSettings} /> : null}
      </TabsContent>
    </Tabs>
  );
}
