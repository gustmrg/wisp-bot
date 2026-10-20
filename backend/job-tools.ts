import type { ToolDefinition } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };

import {
  isJobFinished,
  type Job,
  MAX_JOB_INSTRUCTIONS_LENGTH,
  MAX_JOB_SKILLS,
  MAX_JOB_TITLE_LENGTH,
  MAX_JOB_TOOLS,
  MAX_JOBS_PER_WISP,
} from "../shared/jobs.js";
import { describeSchedule, nextOccurrence, normalizeSchedule, type Schedule } from "../shared/schedule.js";
import { MAX_SKILL_NAME_LENGTH } from "../shared/skills.js";
import { systemTimeZone } from "../shared/time-zone.js";
import type { JobApprovalDetails } from "../shared/tool-policy.js";
import { WispBackendError } from "./backend-error.js";
import type { ConversationAgentContext } from "./conversation-agent.js";
import type { JobChanges, NewJob } from "./job-scheduler.js";
import type { ToolAuthorizationBroker } from "./tool-authorization-broker.js";

/** The tools a Wisp manages its jobs with; never offered to a job's own runs. */
export const JOB_TOOL_NAMES: ReadonlySet<string> = new Set(["schedule_job", "list_jobs", "update_job", "cancel_job"]);

/** A time this recent counts as now, as in the scheduler. */
const PAST_TIME_GRACE_MS = 60_000;

/** What the job tools act through; see `JobScheduler`. */
export interface JobToolHost {
  list(conversationId: string): Promise<ReadonlyArray<Job>>;
  create(job: NewJob): Promise<Job>;
  update(jobId: string, changes: JobChanges): Promise<Job>;
  delete(jobId: string): Promise<void>;
  /** Shows a created or changed job in its conversation, as a card with its next run. */
  recordChange(job: Job, change: "created" | "updated"): Promise<void>;
}

export interface JobToolOptions {
  host: JobToolHost;
  context: ConversationAgentContext;
  authorizationBroker: Pick<ToolAuthorizationBroker, "authorize">;
  /** Whether the Wisp has a skill with this name. */
  hasSkill: (name: string) => Promise<boolean>;
  /** The tools the Wisp has now that a job may use. */
  availableTools: () => Promise<ReadonlyArray<string>>;
  now?: () => Date;
}

/** What the Wisp is told about jobs, when it has the job tools. */
export const JOB_INSTRUCTIONS = [
  "## Jobs",
  "You can run jobs: tasks you do on your own on a schedule, in the background, sending only their result to this conversation. When the user asks for something to be done regularly, or later without them (every morning, every Saturday, on the first of the month), call schedule_job.",
  "Write a job's instructions so they stand alone: a run does not see this conversation. Include the sources and how to reach them (sites, search queries, APIs), what counts as worth reporting, and the language and format of the message, with a heading that has the date. Do not repeat the schedule in the instructions; each run is told when it runs.",
  "In tools, list exactly the tools a run needs; in skills, the skills it relies on. Runs happen with no one present, and only the tools approved with the job are available to them. Jobs run at most once a day.",
  "The user approves each job in a card that shows all of this, so do not repeat it in the chat or ask for confirmation; call schedule_job directly and confirm in one short sentence. Use list_jobs, update_job and cancel_job to manage this conversation's jobs.",
  "Messages that start with [Your job ...] are results your jobs already sent to the user; you can follow up on them.",
].join("\n");

const SCHEDULE_PARAMETER = {
  type: "object",
  description:
    "When the job runs. once: at one time. daily: every day at a local time. weekly: on some weekdays at a local time. monthly: on a day of the month at a local time. Local times are in the user's time zone.",
  properties: {
    kind: { type: "string", enum: ["once", "daily", "weekly", "monthly"] },
    at: {
      type: "string",
      description: "For once: an ISO 8601 date and time with its offset, such as 2026-10-17T10:00:00-03:00.",
    },
    time: {
      type: "string",
      pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
      description: "For daily, weekly and monthly: HH:MM.",
    },
    weekdays: {
      type: "array",
      items: { type: "integer", minimum: 0, maximum: 6 },
      minItems: 1,
      description: "For weekly: 0 is Sunday, 6 is Saturday.",
    },
    day: {
      type: "integer",
      minimum: 1,
      maximum: 31,
      description: "For monthly: the day of the month; months without it use their last day.",
    },
    end: {
      type: "object",
      description:
        'Optional, for recurring jobs: {"kind":"until","date":"YYYY-MM-DD"} runs through that local date; {"kind":"count","count":N} stops after N runs.',
      properties: {
        kind: { type: "string", enum: ["until", "count"] },
        date: { type: "string" },
        count: { type: "integer", minimum: 1 },
      },
      required: ["kind"],
    },
  },
  required: ["kind"],
  additionalProperties: false,
};

const NAMES_PARAMETER = (description: string, maxItems: number, maxLength: number) => ({
  type: "array",
  items: { type: "string", minLength: 1, maxLength },
  maxItems,
  description,
});

const JOB_FIELDS = {
  title: { type: "string", minLength: 1, maxLength: MAX_JOB_TITLE_LENGTH, description: "A short title." },
  instructions: {
    type: "string",
    minLength: 1,
    maxLength: MAX_JOB_INSTRUCTIONS_LENGTH,
    description: "Self-contained instructions for every run; see Jobs in your instructions.",
  },
  schedule: SCHEDULE_PARAMETER,
  skills: NAMES_PARAMETER("Names of your skills every run loads.", MAX_JOB_SKILLS, MAX_SKILL_NAME_LENGTH),
  tools: NAMES_PARAMETER("Names of your tools the runs need, exactly as you see them.", MAX_JOB_TOOLS, 128),
};

interface JobFields {
  title?: string;
  instructions?: string;
  schedule?: unknown;
  skills?: string[];
  tools?: string[];
}

/** `schedule_job`, `list_jobs`, `update_job` and `cancel_job`, acting only on the jobs of the conversation they are called from. */
export function createJobTools(options: JobToolOptions): ToolDefinition[] {
  const { host, context, authorizationBroker } = options;
  const now = options.now ?? (() => new Date());
  const timeZone = () => context.userTimeZone?.() ?? systemTimeZone();

  const ownJob = async (jobId: unknown): Promise<Job> => {
    const job = (await host.list(context.conversationId)).find(({ id }) => id === jobId);
    if (!job)
      throw new WispBackendError("not_found", `No job with ID ${JSON.stringify(jobId)} exists here; call list_jobs.`);
    return job;
  };

  const checkNames = async (fields: JobFields) => {
    for (const name of fields.skills ?? []) {
      if (!(await options.hasSkill(name))) {
        throw new WispBackendError("invalid_request", `You have no skill named ${JSON.stringify(name)}.`);
      }
    }
    if (fields.tools?.length) {
      const available = new Set(await options.availableTools());
      const missing = fields.tools.filter((name) => !available.has(name));
      if (missing.length) {
        throw new WispBackendError(
          "invalid_request",
          `A job cannot use ${missing.map((name) => JSON.stringify(name)).join(", ")}. Tools it can use: ${[...available].join(", ") || "none"}.`,
        );
      }
    }
  };

  const approve = (toolCallId: string, summary: string, details: JobApprovalDetails, signal?: AbortSignal) =>
    authorizationBroker.authorize(
      {
        conversationId: context.conversationId,
        wispId: context.wispId,
        toolCallId,
        toolName: "schedule_job",
        category: "schedule_job",
        scope: { kind: "job", value: details.title },
        summary,
        job: details,
      },
      signal,
    );

  const tools = [
    {
      name: "schedule_job",
      label: "Schedule job",
      description:
        "Create a job: a task you run on your own on a schedule, in the background, sending only its result to this conversation. The user approves it in a card.",
      parameters: {
        type: "object",
        properties: JOB_FIELDS,
        required: ["title", "instructions", "schedule"],
        additionalProperties: false,
      },
      execute: async (toolCallId: string, params: JobFields, signal?: AbortSignal) => {
        const fields = parseFields(params);
        const { title, instructions, schedule } = fields;
        if (!title || !instructions || !schedule) {
          throw new WispBackendError("invalid_request", "A job needs a title, instructions and a schedule.");
        }
        await checkNames(fields);
        const held = (await host.list(context.conversationId)).filter((job) => !isJobFinished(job));
        if (held.length >= MAX_JOBS_PER_WISP) {
          throw new WispBackendError(
            "invalid_request",
            `You already have ${MAX_JOBS_PER_WISP} jobs; cancel one first.`,
          );
        }
        const zone = timeZone();
        const nextRunAt = firstRun(schedule, zone, now());
        const request: NewJob = {
          conversationId: context.conversationId,
          title,
          instructions,
          skills: unique(fields.skills ?? []),
          tools: unique(fields.tools ?? []),
          schedule,
          timeZone: zone,
        };
        await approve(
          toolCallId,
          `Schedule "${title}": ${describeSchedule(schedule, zone)}`,
          approvalDetails(request, nextRunAt),
          signal,
        );
        const job = await host.create(request);
        await host.recordChange(job, "created");
        return text(`Scheduled the job "${job.title}" (ID ${job.id}). ${nextRunText(job)}`);
      },
    },
    {
      name: "list_jobs",
      label: "List jobs",
      description:
        "List the jobs of this conversation, with their schedule, next run and last outcome. Finished jobs are not listed.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        const all = await host.list(context.conversationId);
        const jobs = all.filter((job) => !isJobFinished(job));
        const finished = all.length - jobs.length;
        const note = finished
          ? `${finished === 1 ? "1 finished job is" : `${finished} finished jobs are`} kept but not listed.`
          : undefined;
        if (!jobs.length)
          return text(
            note
              ? `There are no scheduled jobs in this conversation. ${note}`
              : "There are no jobs in this conversation.",
          );
        return text([...jobs.map(describeJob), ...(note ? [note] : [])].join("\n\n"));
      },
    },
    {
      name: "update_job",
      label: "Update job",
      description:
        "Change a job of this conversation. Pass only what changes. Changing its instructions or skills, or adding tools, asks the user to approve the job again.",
      parameters: {
        type: "object",
        properties: { job_id: { type: "string", minLength: 1 }, ...JOB_FIELDS },
        required: ["job_id"],
        additionalProperties: false,
      },
      execute: async (toolCallId: string, params: JobFields & { job_id: string }, signal?: AbortSignal) => {
        const current = await ownJob(params.job_id);
        const fields = parseFields(params);
        await checkNames(fields);
        const changes: JobChanges = {
          ...(fields.title ? { title: fields.title } : {}),
          ...(fields.instructions ? { instructions: fields.instructions } : {}),
          ...(fields.schedule ? { schedule: fields.schedule, timeZone: timeZone() } : {}),
          ...(fields.skills ? { skills: unique(fields.skills) } : {}),
          ...(fields.tools ? { tools: unique(fields.tools) } : {}),
        };
        const next = { ...current, ...changes };
        const widened =
          (changes.instructions !== undefined && changes.instructions !== current.instructions) ||
          (changes.skills ?? []).some((name) => !current.skills.includes(name)) ||
          (changes.tools ?? []).some((name) => !current.tools.includes(name));
        const nextRunAt = changes.schedule ? firstRun(next.schedule, next.timeZone, now()) : current.nextRunAt;
        if (widened) {
          await approve(toolCallId, `Change "${next.title}"`, approvalDetails(next, nextRunAt), signal);
        }
        const job = await host.update(current.id, changes);
        await host.recordChange(job, "updated");
        return text(`Updated the job "${job.title}". ${nextRunText(job)}`);
      },
    },
    {
      name: "cancel_job",
      label: "Cancel job",
      description: "Delete a job of this conversation, with its run history.",
      parameters: {
        type: "object",
        properties: { job_id: { type: "string", minLength: 1 } },
        required: ["job_id"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: { job_id: string }) => {
        const job = await ownJob(params.job_id);
        await host.delete(job.id);
        return text(`Deleted the job "${job.title}".`);
      },
    },
  ];
  return tools as unknown as ToolDefinition[];
}

function parseFields(params: JobFields): Omit<JobFields, "schedule"> & { schedule?: Schedule } {
  const title = params.title?.trim();
  const instructions = params.instructions?.trim();
  if (title !== undefined && (!title || title.length > MAX_JOB_TITLE_LENGTH)) {
    throw new WispBackendError("invalid_request", `A job's title needs 1 to ${MAX_JOB_TITLE_LENGTH} characters.`);
  }
  if (instructions !== undefined && (!instructions || instructions.length > MAX_JOB_INSTRUCTIONS_LENGTH)) {
    throw new WispBackendError(
      "invalid_request",
      `A job's instructions need 1 to ${MAX_JOB_INSTRUCTIONS_LENGTH} characters.`,
    );
  }
  let schedule: Schedule | undefined;
  if (params.schedule !== undefined) {
    schedule = normalizeSchedule(params.schedule);
    if (!schedule) {
      throw new WispBackendError(
        "invalid_request",
        "The schedule is not valid. Use once with an ISO time and offset, or daily, weekly or monthly with time as HH:MM.",
      );
    }
  }
  const names = (value: unknown, max: number, what: string) => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > max || !value.every((name) => typeof name === "string" && name)) {
      throw new WispBackendError("invalid_request", `List at most ${max} ${what} by name.`);
    }
    return value as string[];
  };
  return {
    ...(title ? { title } : {}),
    ...(instructions ? { instructions } : {}),
    ...(schedule ? { schedule } : {}),
    ...(params.skills !== undefined ? { skills: names(params.skills, MAX_JOB_SKILLS, "skills") } : {}),
    ...(params.tools !== undefined ? { tools: names(params.tools, MAX_JOB_TOOLS, "tools") } : {}),
  };
}

function firstRun(schedule: Schedule, timeZone: string, now: Date): string {
  const first = nextOccurrence(schedule, timeZone, new Date(now.getTime() - PAST_TIME_GRACE_MS));
  if (!first) throw new WispBackendError("invalid_request", "That schedule never runs after now.");
  return first.toISOString();
}

function approvalDetails(
  job: Pick<Job, "title" | "instructions" | "skills" | "tools" | "schedule" | "timeZone">,
  nextRunAt: string | undefined,
): JobApprovalDetails {
  return {
    title: job.title,
    schedule: describeSchedule(job.schedule, job.timeZone),
    ...(nextRunAt ? { nextRunAt } : {}),
    instructions: job.instructions,
    skills: [...job.skills],
    tools: [...job.tools],
  };
}

function describeJob(job: Job): string {
  return [
    `${job.title} (ID ${job.id})`,
    `Schedule: ${describeSchedule(job.schedule, job.timeZone)}`,
    job.paused
      ? `Paused ${job.paused.reason === "failures" ? "after failing several times in a row" : "by the user"}`
      : nextRunText(job),
    job.lastRun
      ? `Last run: ${job.lastRun.status} on ${job.lastRun.endedAt}${job.lastRun.errorCode ? ` (${job.lastRun.errorCode})` : ""}`
      : "It has not run yet.",
    `Tools: ${job.tools.join(", ") || "none"}; skills: ${job.skills.join(", ") || "none"}`,
    `Instructions:\n${job.instructions}`,
  ].join("\n");
}

function nextRunText(job: Pick<Job, "nextRunAt" | "timeZone">): string {
  if (!job.nextRunAt) return "Its schedule has ended; it stays here until it is cancelled.";
  const at = new Date(job.nextRunAt).toLocaleString("en-US", {
    timeZone: job.timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Next run: ${at} (${job.timeZone}).`;
}

function unique(names: ReadonlyArray<string>): string[] {
  return [...new Set(names)];
}

function text(value: string) {
  return { content: [{ type: "text", text: value }], details: {} };
}
