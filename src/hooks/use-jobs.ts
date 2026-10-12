import { useCallback, useEffect, useState } from "react";

import type { BackendResult } from "../../shared/contracts";
import type { Job, JobRun, JobsView } from "../../shared/jobs";

export interface JobsController {
  /** False until the backend answers, and when it has no jobs (an older server). */
  available: boolean;
  /** Every job of every Wisp, soonest next run first. */
  jobs: ReadonlyArray<Job>;
  /** Each resolves with an error message, or null when it worked. */
  pause: (jobId: string) => Promise<string | null>;
  resume: (jobId: string) => Promise<string | null>;
  runNow: (jobId: string) => Promise<string | null>;
  remove: (jobId: string) => Promise<string | null>;
  /** A job's recent runs, newest first, or an error message. */
  loadRuns: (jobId: string) => Promise<ReadonlyArray<JobRun> | string>;
}

/** The backend's jobs, kept current by its change events (ADR 019). */
export function useJobs(): JobsController {
  const [available, setAvailable] = useState(false);
  const [jobs, setJobs] = useState<ReadonlyArray<Job>>([]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.wisp.subscribeToJobs((view) => {
      setAvailable(true);
      setJobs(view.jobs);
    });
    void window.wisp.getJobs().then(
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
  }, []);

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

  const pause = useCallback((jobId: string) => run(() => window.wisp.pauseJob({ jobId })), [run]);
  const resume = useCallback((jobId: string) => run(() => window.wisp.resumeJob({ jobId })), [run]);
  const runNow = useCallback((jobId: string) => run(() => window.wisp.runJobNow({ jobId })), [run]);
  const remove = useCallback((jobId: string) => run(() => window.wisp.deleteJob({ jobId })), [run]);
  const loadRuns = useCallback(async (jobId: string) => {
    try {
      const result = await window.wisp.getJobRuns({ jobId });
      return result.ok ? result.value.runs : result.error.message;
    } catch {
      return "The job's runs could not be loaded.";
    }
  }, []);

  return { available, jobs, pause, resume, runNow, remove, loadRuns };
}
