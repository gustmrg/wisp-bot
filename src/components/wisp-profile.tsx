import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  BarChart3Icon,
  BellIcon,
  BellOffIcon,
  CalendarClockIcon,
  ChevronLeftIcon,
  CpuIcon,
  KeyRoundIcon,
  MessageCircleIcon,
  PauseIcon,
  PencilIcon,
} from "lucide-react";

import type { WispChatView } from "@/chat-data";
import { WispAvatar } from "@/components/chat-avatar";
import type { WispState } from "@/components/wisp";
import { Button } from "@/components/ui/button";
import { useJobs } from "@/hooks/use-jobs";
import { inkOn, wispColor } from "@/lib/wisp-appearance";
import { describeSchedule } from "../../shared/schedule";

/** The settings tabs the profile's shortcuts open. */
export type WispSettingsTab = "general" | "model" | "access" | "usage";

interface WispProfileProps {
  chat: WispChatView;
  state: WispState;
  onBack: () => void;
  onOpenSettings: (tab: WispSettingsTab) => void;
  /** Inside the desktop's side panel, which has its own header and keeps the chat beside it. */
  embedded?: boolean;
}

/** The soul as plain text: its paragraphs without headings or Markdown marks. */
export function soulText(soul: string): string {
  return soul
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("#") && !part.startsWith("---"))
    .map((part) =>
      part
        .replace(/[*_`>#]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .join("\n\n");
}

/** Who a Wisp is, on a phone: its picture, soul, model, and jobs, with the way into its settings. */
export function WispProfile({ chat, state, onBack, onOpenSettings, embedded = false }: WispProfileProps) {
  const { wisp } = chat;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const jobs = useJobs().jobs.filter((job) => job.conversationId === chat.id);
  const [model, setModel] = useState<string | null>(null);
  const color = wispColor(wisp.name, wisp.color);
  const soul = soulText(wisp.soul);

  useEffect(() => {
    if (!embedded) titleRef.current?.focus();
  }, [embedded]);

  useEffect(() => {
    let cancelled = false;
    void window.wisp
      .getConversationModel({ conversationId: chat.id })
      .then((result) => {
        if (!cancelled && result.ok) setModel(result.value.effective?.modelId ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [chat.id]);

  return (
    <section
      className="wisp-profile"
      aria-labelledby="wisp-profile-name"
      data-embedded={embedded || undefined}
      style={{ "--wisp": color, "--wisp-ink": inkOn(color) } as CSSProperties}
    >
      <div className="wisp-profile-hero">
        {embedded ? null : (
          <div className="wisp-profile-bar">
            <Button variant="ghost" size="icon" type="button" aria-label="Back to conversation" onClick={onBack}>
              <ChevronLeftIcon aria-hidden="true" />
            </Button>
            <Button variant="ghost" type="button" onClick={() => onOpenSettings("general")}>
              Edit
            </Button>
          </div>
        )}
        <div className="wisp-profile-picture">
          <WispAvatar wisp={wisp} size="xl" state={state} />
        </div>
        <h1 id="wisp-profile-name" ref={titleRef} tabIndex={-1}>
          {wisp.name}
        </h1>
        {wisp.role ? <p className="wisp-profile-role">{wisp.role}</p> : null}
        <div className="wisp-profile-actions">
          {embedded ? (
            <button type="button" onClick={() => onOpenSettings("general")}>
              <PencilIcon aria-hidden="true" />
              Edit
            </button>
          ) : (
            <button type="button" onClick={onBack}>
              <MessageCircleIcon aria-hidden="true" />
              Chat
            </button>
          )}
          <button type="button" onClick={() => onOpenSettings("model")}>
            <CpuIcon aria-hidden="true" />
            Model
          </button>
          <button type="button" onClick={() => onOpenSettings("access")}>
            <KeyRoundIcon aria-hidden="true" />
            Access
          </button>
          <button type="button" onClick={() => onOpenSettings("usage")}>
            <BarChart3Icon aria-hidden="true" />
            Usage
          </button>
        </div>
      </div>

      <div className="wisp-profile-body">
        <section className="wisp-profile-card" aria-label="Soul">
          <h2>Soul</h2>
          {soul ? (
            <p className="wisp-profile-soul">{soul}</p>
          ) : (
            <p className="wisp-profile-empty">No soul yet. Tap Edit to describe who {wisp.name} is and how it works.</p>
          )}
        </section>

        <ul className="wisp-profile-card wisp-profile-list" aria-label="About">
          <li>
            <CpuIcon aria-hidden="true" />
            <span>
              {model ?? "Default model"}
              <small>Model</small>
            </span>
          </li>
          <li>
            {chat.notifyOnUpdatesEnabled ? <BellIcon aria-hidden="true" /> : <BellOffIcon aria-hidden="true" />}
            <span>
              {chat.notifyOnUpdatesEnabled ? "Notifications on" : "Notifications off"}
              <small>Replies and questions</small>
            </span>
          </li>
        </ul>

        <section className="wisp-profile-card" aria-label="Jobs">
          <h2>Jobs</h2>
          {jobs.length ? (
            <ul className="wisp-profile-list">
              {jobs.map((job) => (
                <li key={job.id}>
                  {job.paused ? <PauseIcon aria-hidden="true" /> : <CalendarClockIcon aria-hidden="true" />}
                  <span>
                    {job.title}
                    <small>{job.paused ? "Paused" : describeSchedule(job.schedule, job.timeZone)}</small>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="wisp-profile-empty">
              No jobs. Ask {wisp.name} to do something on a schedule, like “every morning, summarize the news”.
            </p>
          )}
        </section>
      </div>
    </section>
  );
}
