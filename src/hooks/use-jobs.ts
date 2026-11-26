import { useCallback, useEffect, useState } from "react";

import { useWispApi } from "@/lib/environment-api";
import type { BackendResult } from "../../shared/contracts";
import type { Job, JobRun, JobsView } from "../../shared/jobs";

export interface JobsController {
  /** False until the backend answers, and when it could not. */
  available: boolean;
  /** Every job of every Wisp, soonest next run first. */
  jobs: ReadonlyArray<Job>;
  /** Each resolves with an error message, or null when it worked. */
  pause: (jobId: string) => Promise<string | null>;
  resume: (jobId: string) => Promise<string | null>;
  runNow: (jobId: string) => Promise<string | null>;
  remove: (jobId: string) => Promise<string | null>;
  /** Whether the job's next runs read the Wisp's memory. */
  setMemory: (jobId: string, useMemory: boolean) => Promise<string | null>;
  /** A job's recent runs, newest first, or an error message. */
  loadRuns: (jobId: string) => Promise<ReadonlyArray<JobRun> | string>;
}

/** The backend's jobs, kept current by its change events (ADR 019). */
export function useJobs(): JobsController {
  const api = useWispApi();
  const [available, setAvailable] = useState(false);
  const [jobs, setJobs] = useState<ReadonlyArray<Job>>([]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = api.subscribeToJobs((view) => {
      setAvailable(true);
      setJobs(view.jobs);
    });
    void api.getJobs().then(
      (result) => {
        if (cancelled) return;
        setAvailable(result.ok);
        if (result.ok) setJobs(result.value.jobs);
      },
      () => {
        if (!cancelled) setAvailable(false);
      },
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api]);

  const run = useCallback(async (call: () => Promise<BackendResult<JobsView>>) => {
    try {
      const result = await call();
      if (!result.ok) return result.error.message;
      setJobs(result.value.jobs);
      return null;
    } catch {
      return "The job could not be changed.";
    }
  }, []);

  const pause = useCallback((jobId: string) => run(() => api.pauseJob({ jobId })), [api, run]);
  const resume = useCallback((jobId: string) => run(() => api.resumeJob({ jobId })), [api, run]);
  const runNow = useCallback((jobId: string) => run(() => api.runJobNow({ jobId })), [api, run]);
  const remove = useCallback((jobId: string) => run(() => api.deleteJob({ jobId })), [api, run]);
  const setMemory = useCallback(
    (jobId: string, useMemory: boolean) => run(() => api.setJobMemory({ jobId, useMemory })),
    [api, run],
  );
  const loadRuns = useCallback(
    async (jobId: string) => {
      try {
        const result = await api.getJobRuns({ jobId });
        return result.ok ? result.value.runs : result.error.message;
      } catch {
        return "The job's runs could not be loaded.";
      }
    },
    [api],
  );

  return { available, jobs, pause, resume, runNow, remove, setMemory, loadRuns };
}
