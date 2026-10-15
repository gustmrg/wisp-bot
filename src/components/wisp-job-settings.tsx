import { CalendarClockIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useJobs } from "@/hooks/use-jobs";
import { useTimeZone } from "@/hooks/use-time-zone";
import type { IntegrationSettingsTarget } from "@/lib/plugin-access";
import { describeSchedule } from "../../shared/schedule";

/** A Wisp's jobs at a glance, with the way to the jobs list where they are managed. */
export function WispJobSettings({
  conversationId,
  onOpenSettings,
}: {
  conversationId: string;
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
}) {
  return <WispJobs conversationId={conversationId} onOpenSettings={onOpenSettings} />;
}

function WispJobs({
  conversationId,
  onOpenSettings,
}: {
  conversationId: string;
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
}) {
  const { available, jobs } = useJobs();
  const timeZone = useTimeZone();
  const own = jobs.filter((job) => job.conversationId === conversationId);
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-xs leading-relaxed text-dim">
        Tasks this Wisp runs on a schedule in the background. Ask it in the conversation to create or change one.
      </p>
      {own.length ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
          {own.map((job) => (
            <li key={job.id} className="flex flex-col gap-0.5">
              <span className="font-medium">{job.title}</span>
              <span className="text-xs text-dim">{describeSchedule(job.schedule, job.timeZone)}</span>
              <span className="text-xs text-dim">
                {job.paused
                  ? "Paused"
                  : job.nextRunAt
                    ? `Next run ${new Date(job.nextRunAt).toLocaleString([], {
                        timeZone,
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}`
                    : "Finished"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p role="status" className="m-0 text-xs text-dim">
          {available ? "No jobs yet." : "Loading jobs…"}
        </p>
      )}
      {onOpenSettings ? (
        <Button className="self-start" variant="outline" size="sm" onClick={() => onOpenSettings({ section: "jobs" })}>
          <CalendarClockIcon aria-hidden="true" />
          Manage jobs
        </Button>
      ) : null}
    </div>
  );
}
