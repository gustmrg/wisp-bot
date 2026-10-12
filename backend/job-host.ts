import type { Job } from "../shared/jobs.js";
import { describeSchedule } from "../shared/schedule.js";
import { isTimeZone } from "../shared/time-zone.js";

/** The card a created or changed job leaves in its conversation, with its next run (ADR 019). */
export function jobCardItems(job: Job, change: "created" | "updated"): Array<{ label: string; text: string }> {
  return [
    { label: change === "created" ? "New job" : "Job changed", text: job.title },
    { label: "Schedule", text: describeSchedule(job.schedule, job.timeZone) },
    { label: "Next run", text: job.nextRunAt ? formatTime(new Date(job.nextRunAt), job.timeZone) : "None" },
  ];
}

/**
 * What the Wisp's own session receives when a job delivers, so it knows what
 * the person was told and can follow up. The model reads it; the transcript
 * shows only the message itself.
 */
export function jobResultContext(job: Pick<Job, "title" | "timeZone">, text: string, deliveredAt: Date): string {
  return `[Your job "${job.title}" ran on ${formatTime(deliveredAt, job.timeZone)} and sent the user this message:]\n\n${text}`;
}

/** A time in a job's time zone, as cards and notes show it. */
export function formatTime(time: Date, timeZone: string): string {
  const zone = isTimeZone(timeZone) ? timeZone : "UTC";
  return `${time.toLocaleString("en-US", {
    timeZone: zone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })} (${zone})`;
}
