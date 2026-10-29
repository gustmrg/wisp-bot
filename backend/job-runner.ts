import path from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };
import { z } from "zod";

import type { ModelSelection } from "../shared/contracts.js";
import { type Job, type JobRun, MAX_JOB_STATE_BYTES } from "../shared/jobs.js";
import { isTimeZone } from "../shared/time-zone.js";
import { WispBackendError } from "./backend-error.js";
import type { ConversationAgentContext } from "./conversation-agent.js";
import type { JobRunContext, JobRunOutcome } from "./job-scheduler.js";
import type { RuntimeJobSession } from "./runtime-session.js";
import type { JobSessionSpec } from "./wisp-session-plan.js";
import { sanitizeErrorMessage } from "./pi-event-translator.js";
import { describeProviderError } from "./provider-error.js";
import type { ToolAuthorizationBroker } from "./tool-authorization-broker.js";
import { defineWispTool } from "./tool-schema.js";

/** Where a Wisp's job runs keep their session files, inside its conversation's session folder. */
export const JOB_RUNS_DIRECTORY = "jobs";
const MAX_SKIP_REASON_LENGTH = 500;

export interface JobSessionFactory {
  createJobSession(
    context: ConversationAgentContext,
    selection: ModelSelection,
    job: JobSessionSpec,
  ): Promise<RuntimeJobSession>;
}

export interface JobRunnerOptions {
  sessionFactory: JobSessionFactory;
  /** The agent context of the job's conversation; throws when the Wisp no longer exists. */
  getContext: (conversationId: string) => ConversationAgentContext;
  /** The model the Wisp answers with: its own, or the app's. */
  getSelection: (context: ConversationAgentContext) => Promise<ModelSelection | null>;
  runUnattended: ToolAuthorizationBroker["runUnattended"];
  now?: () => Date;
}

/**
 * Runs one occurrence of a job in its own Pi session (ADR 019). Nothing
 * waits for approval: the run is unattended for the authorization broker, and
 * the tools approved with the job are its grant. The run's final response is
 * its message; `skip_delivery` ends it silently.
 */
export class JobRunner {
  private readonly options: JobRunnerOptions;
  private readonly now: () => Date;

  constructor(options: JobRunnerOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  readonly run = async (job: Job, context: JobRunContext): Promise<JobRunOutcome> => {
    const agentContext = this.options.getContext(job.conversationId);
    const selection = await this.options.getSelection(agentContext);
    if (!selection) {
      throw new WispBackendError("configuration_required", "Choose a provider and model before jobs can run.");
    }
    let skipped: string | undefined;
    const runTools = createRunTools({
      skip: (reason) => {
        skipped = reason;
      },
      saveState: context.saveState,
    });
    const session = await this.options.sessionFactory.createJobSession(agentContext, selection, {
      runId: context.run.id,
      runDirectory: path.join(agentContext.sessionDirectory, JOB_RUNS_DIRECTORY, job.id),
      tools: job.tools,
      skills: job.skills,
      memory: job.useMemory === true,
      runTools,
    });
    context.recordSession(session.sessionFile ? { sessionFile: session.sessionFile } : {});
    try {
      const prompt = jobRunPrompt(job, context.run, context.lastRunAt, this.now());
      await this.options.runUnattended({ conversationId: job.conversationId, approvedTools: new Set(job.tools) }, () =>
        session.prompt(prompt, context.signal),
      );
      context.signal.throwIfAborted();
      if (skipped !== undefined) return { kind: "silent", reason: skipped };
      const last = session.lastAssistantMessage();
      if (last?.stopReason === "aborted") throw new WispBackendError("aborted", "The job run was stopped.");
      if (last?.stopReason === "error") throw providerError(last.errorMessage);
      return { kind: "message", text: last?.text ?? "" };
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      if (error instanceof WispBackendError) throw error;
      throw providerError(error instanceof Error ? error.message : String(error));
    } finally {
      context.recordSession({
        ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
        usage: session.usage(),
      });
      session.dispose();
    }
  };
}

/** A model or network failure, retryable when it may pass. */
function providerError(message: string | undefined): WispBackendError {
  const described = describeProviderError(sanitizeErrorMessage(message ?? ""));
  return new WispBackendError("internal_error", described.message, described.retryable);
}

export const SKIP_DELIVERY_PARAMETERS = z.strictObject({ reason: z.string().min(1).max(MAX_SKIP_REASON_LENGTH) });
export const SAVE_JOB_STATE_PARAMETERS = z.strictObject({ state: z.string() });

/** `skip_delivery` and `save_job_state`, the tools only job runs have. */
export function createRunTools(handlers: {
  skip: (reason: string) => void;
  saveState: (state: string) => Promise<void>;
}): ToolDefinition[] {
  return [
    defineWispTool({
      name: "skip_delivery",
      label: "Skip delivery",
      description:
        "End this job run without sending the user a message, because there is nothing worth reporting, such as no new posts. Give a short reason for the run's record. Write no message after calling it.",
      parameters: SKIP_DELIVERY_PARAMETERS,
      execute: async (_id, params) => {
        handlers.skip(params.reason);
        return {
          content: [{ type: "text", text: "Delivery skipped. End the run now without writing a message." }],
          details: {},
        };
      },
    }),
    defineWispTool({
      name: "save_job_state",
      label: "Save job state",
      description: `Replace the state saved for this job's next run, such as the items already reported. Pass the complete new state as text (JSON works well), at most ${MAX_JOB_STATE_BYTES / 1024} KB; the next run receives it.`,
      parameters: SAVE_JOB_STATE_PARAMETERS,
      execute: async (_id, params) => {
        const { state } = params;
        if (Buffer.byteLength(state, "utf8") > MAX_JOB_STATE_BYTES) {
          throw new WispBackendError(
            "invalid_request",
            `The state is too large; keep it under ${MAX_JOB_STATE_BYTES / 1024} KB, for example by keeping only recent items.`,
          );
        }
        await handlers.saveState(state);
        return { content: [{ type: "text", text: "State saved for the next run." }], details: {} };
      },
    }),
  ];
}

/**
 * The message a run starts with: when it runs and whether it is late, when
 * the job last ran, its saved state, and its instructions. The schedule itself
 * is left out, so instructions never repeat a schedule that may change.
 */
export function jobRunPrompt(
  job: Pick<Job, "title" | "instructions" | "state" | "timeZone">,
  run: Pick<JobRun, "trigger" | "scheduledAt">,
  lastRunAt: string | undefined,
  now: Date,
): string {
  const timeZone = isTimeZone(job.timeZone) ? job.timeZone : "UTC";
  const format = (time: Date) => formatTime(time, timeZone);
  const scheduled = new Date(run.scheduledAt);
  const when =
    run.trigger === "manual"
      ? `The user asked to run it now, on ${format(now)} (${timeZone}).`
      : now.getTime() - scheduled.getTime() > 60_000
        ? `It was due on ${format(scheduled)} and is running late, on ${format(now)} (${timeZone})${run.trigger === "catch_up" ? ", because the app was not running at that time" : ""}.`
        : `It is running on ${format(now)} (${timeZone}), as scheduled.`;
  return [
    `[Scheduled job "${job.title}". No one is present.]`,
    when,
    lastRunAt ? `The job last ran on ${format(new Date(lastRunAt))}.` : "This is the job's first run.",
    "",
    "## Saved state",
    job.state ? job.state : "(none yet)",
    "",
    "## Instructions",
    job.instructions,
  ].join("\n");
}

function formatTime(time: Date, timeZone: string): string {
  return time.toLocaleString("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
