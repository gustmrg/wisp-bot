import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { CheckIcon, Share2Icon, XIcon } from "lucide-react";

import type { AgentSettings, Chat, ChatCollection } from "@/chat-data";
import { WispSettingsFields } from "@/components/wisp-settings-fields";
import { ChatAvatar } from "@/components/chat-avatar";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { getCircleMembers } from "@/lib/circle-members";
import { detailsField, detailsFieldControl, iconButton, notificationCard, notificationCardCopy, panelResizer } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";

interface DetailsPanelProps {
  chat: Chat;
  chats: ChatCollection;
  width: number;
  onChange: (changes: Partial<AgentSettings>) => void;
  onClose: () => void;
  onDelete: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

function DetailsPanel({ chat, chats, width, onChange, onClose, onDelete, onResizeStart }: DetailsPanelProps) {
  const [copied, setCopied] = useState(false);
  const members = getCircleMembers(chat, chats);

  function shareTemplate() {
    void navigator.clipboard?.writeText(`wisp://template/${chat.id}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <aside
      className="relative flex min-h-0 min-w-[280px] animate-panel-in flex-none flex-col border-l border-black/[0.055] bg-panel max-[900px]:absolute max-[900px]:inset-y-0 max-[900px]:right-0 max-[900px]:z-[8] max-[900px]:shadow-[-20px_0_50px_rgba(0,0,0,0.114)] dark:border-white/[0.055] dark:max-[900px]:shadow-[-20px_0_50px_rgba(0,0,0,0.38)]"
      style={{ width }}
    >
      <div className={cn(panelResizer, "-left-1")} role="separator" aria-orientation="vertical" onPointerDown={onResizeStart} />
      <header className="grid h-11 flex-none grid-cols-[28px_1fr_28px] items-center border-b border-black/[0.04] px-[9px] dark:border-white/[0.04]">
        <strong className="col-start-2 text-center text-[12.5px]">Settings</strong>
        <button className={iconButton} type="button" aria-label="Close details" onClick={onClose}><XIcon /></button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
          {!chat.isCircle ? <WispSettingsFields settings={chat} onChange={(changes) => onChange({ ...changes, ...(changes.name === "" ? { name: "Untitled" } : {}) })} /> : <>
            <div className="flex justify-center pt-5 pb-[30px]"><ChatAvatar chat={chat} chats={chats} size="xl" /></div>

            <label className={detailsField}><span>Name</span><input className={detailsFieldControl} value={chat.name} maxLength={64} onChange={(event) => onChange({ name: event.currentTarget.value || "Untitled" })} /></label>
            <label className={detailsField}><span>Label (optional)</span><input className={detailsFieldControl} value={chat.label} maxLength={40} placeholder="Research, marketing, admin" onChange={(event) => onChange({ label: event.currentTarget.value })} /></label>
            <label className={detailsField}><span>Description</span><textarea className={detailsFieldControl} rows={3} value={chat.description} maxLength={240} onChange={(event) => onChange({ description: event.currentTarget.value })} /></label>

            <section className="my-4" aria-labelledby="circle-participants-title">
              <h3 id="circle-participants-title" className="mb-2 mt-0 text-dim text-xs font-medium">Participants ({members.length})</h3>
              {members.length ? (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {members.map((member) => <li key={member.id} className="flex items-center gap-2"><ChatAvatar chat={member} size="sm" /><span className="min-w-0 [overflow-wrap:anywhere]">{member.name}</span></li>)}
                </ul>
              ) : <p className="text-dim text-xs">No Wisps in this circle.</p>}
            </section>

            <div className={notificationCard}>
              <span className={notificationCardCopy}><strong className="text-[12.5px]">Notifications</strong><small className="text-dim text-[11px] leading-[1.3]">Get notified about activity in this circle</small></span>
              <ToggleSwitch checked={chat.notifyOnUpdatesEnabled} label="Notifications" onChange={() => onChange({ notifyOnUpdatesEnabled: !chat.notifyOnUpdatesEnabled })} />
            </div>
          </>}

          {chat.id === "chief" ? null : <button className="mt-[18px] w-full rounded-lg border border-[rgba(229,72,77,0.2)] bg-[rgba(229,72,77,0.08)] p-2 text-[#bd2c35] hover:bg-[rgba(229,72,77,0.16)] dark:text-[#ef7478]" type="button" onClick={onDelete}>Delete {chat.isCircle ? "circle" : "Wisp"}</button>}
        </div>

        <footer className="flex-none px-3.5 pt-2.5 pb-3">
          <button className="flex h-8 w-full items-center justify-center gap-[7px] rounded-lg border-0 bg-[#eeeeee] text-[#555555] hover:bg-[#e9e9e9] hover:text-[#222222] dark:bg-[#222222] dark:text-[#bcbcbc] dark:hover:bg-[#292929] dark:hover:text-[#eeeeee] [&_svg]:size-[13px]" type="button" onClick={shareTemplate}>{copied ? <CheckIcon /> : <Share2Icon />}{copied ? "Template link copied" : "Share as template"}</button>
        </footer>
      </div>
    </aside>
  );
}

export { DetailsPanel };
export type { DetailsPanelProps };
