import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { JobScheduler } from "../job-scheduler.js";
import { parseJobRequest, parseSetJobMemoryRequest } from "../validators.js";
import { registerGuardedHandlers, type HandlerRouter, type SenderAuthorizer } from "./guarded-handlers.js";

/**
 * The jobs list: people see, pause, resume, run and delete jobs, and choose
 * whether their runs read memory; only Wisps create or change what they do.
 */
export function registerJobHandlers(
  router: HandlerRouter,
  jobs: JobScheduler,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  const jobIdOf = (payload: unknown) => parseJobRequest(payload).jobId;
  return registerGuardedHandlers(router, authorizeSender, [
    [WISP_IPC_CHANNELS.getJobs, () => jobs.getView()],
    [WISP_IPC_CHANNELS.getJobRuns, (payload) => jobs.listRuns(jobIdOf(payload))],
    [
      WISP_IPC_CHANNELS.pauseJob,
      async (payload) => {
        await jobs.pause(jobIdOf(payload));
        return jobs.getView();
      },
    ],
    [
      WISP_IPC_CHANNELS.resumeJob,
      async (payload) => {
        await jobs.resume(jobIdOf(payload));
        return jobs.getView();
      },
    ],
    [
      WISP_IPC_CHANNELS.runJobNow,
      async (payload) => {
        await jobs.runNow(jobIdOf(payload));
        return jobs.getView();
      },
    ],
    [
      WISP_IPC_CHANNELS.setJobMemory,
      async (payload) => {
        const { jobId, useMemory } = parseSetJobMemoryRequest(payload);
        await jobs.setMemory(jobId, useMemory);
        return jobs.getView();
      },
    ],
    [
      WISP_IPC_CHANNELS.deleteJob,
      async (payload) => {
        await jobs.delete(jobIdOf(payload));
        return jobs.getView();
      },
    ],
  ]);
}
