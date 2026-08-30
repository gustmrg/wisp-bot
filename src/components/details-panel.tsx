import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { CheckIcon, Share2Icon, XIcon } from "lucide-react";

import type { AgentSettings, Chat } from "@/chat-data";
import { AvatarEditor } from "@/components/avatar-editor";

interface DetailsPanelProps {
  chat: Chat;
  width: number;
  onChange: (changes: Partial<AgentSettings>) => void;
  onClose: () => void;
  onDelete: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

function DetailsPanel({ chat, width, onChange, onClose, onDelete, onResizeStart }: DetailsPanelProps) {
  const [copied, setCopied] = useState(false);

  function shareTemplate() {
    void navigator.clipboard?.writeText(`wisp://template/${chat.id}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <aside className="details-panel" style={{ width }}>
      <div className="details-resizer" role="separator" aria-orientation="vertical" onPointerDown={onResizeStart} />
      <header className="details-header">
        <strong>Settings</strong>
        <button className="icon-button" type="button" aria-label="Close details" onClick={onClose}><XIcon /></button>
      </header>

      <div className="details-settings">
        <div className="details-scroll">
          <AvatarEditor key={chat.id} chat={chat} onChange={onChange} />

          <label className="details-field"><span>Name</span><input value={chat.name} maxLength={64} onChange={(event) => onChange({ name: event.currentTarget.value || "Untitled" })} /></label>
          <label className="details-field"><span>Label (optional)</span><input value={chat.label} maxLength={40} placeholder="Research, marketing, admin" onChange={(event) => onChange({ label: event.currentTarget.value })} /></label>
          <label className="details-field"><span>Description</span><textarea rows={3} value={chat.description} maxLength={240} onChange={(event) => onChange({ description: event.currentTarget.value })} /></label>

          <div className="notification-card">
            <span><strong>Notifications</strong><small>Get notified when this Wisp finishes or needs input</small></span>
            <button className="switch" data-on={chat.notifyOnUpdatesEnabled} type="button" role="switch" aria-checked={chat.notifyOnUpdatesEnabled} aria-label="Notifications" onClick={() => onChange({ notifyOnUpdatesEnabled: !chat.notifyOnUpdatesEnabled })}><span /></button>
          </div>

          {chat.id === "chief" ? null : <button className="delete-button" type="button" onClick={onDelete}>Delete {chat.isGroup ? "channel" : "Wisp"}</button>}
        </div>

        <footer className="details-footer">
          <button type="button" onClick={shareTemplate}>{copied ? <CheckIcon /> : <Share2Icon />}{copied ? "Template link copied" : "Share as template"}</button>
        </footer>
      </div>
    </aside>
  );
}

export { DetailsPanel };
export type { DetailsPanelProps };
