import { useEffect, useState } from "react";
import { CheckIcon, CircleXIcon, LoaderCircleIcon, MinusIcon } from "lucide-react";

import { APP_METADATA } from "@/config/app-metadata";
import { cn } from "@/lib/utils";
import type {
  ConnectionFailure,
  ConnectionProfileView,
  ConnectionProgress,
  ConnectionStep,
  ConnectionStepState,
} from "../../../shared/connections";

/** The current time, updated every `intervalMs` while `enabled`, for elapsed times and countdowns. */
export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}

/** "0.3s", "41s", "2m 5s". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

/** What a failed step says about why, kept short: the card explains it in full. */
export const FAILURE_LABELS: Record<ConnectionFailure, string> = {
  unreachable: "No answer",
  auth: "Sign-in refused",
  host_key: "Host key not trusted",
  cancelled: "Cancelled",
  not_installed: "Wisp server not found",
  not_running: "The Wisp server is not running",
  node: "Node.js is missing or too old",
  version: "Runs another version",
  wrong_server: "Another server than the one paired",
  install: "The setup failed",
};

function stepLabel(step: ConnectionStep, progress: ConnectionProgress, profile?: ConnectionProfileView): string {
  const update = progress.kind === "update";
  switch (step.id) {
    case "start_local":
      return "Start Wisp on this computer";
    case "reach":
      return profile?.kind === "ssh" ? `Reach ${profile.host}` : "Reach the host";
    case "sign_in":
      return "Sign in over SSH";
    case "pair":
      return "Pair this device";
    case "server":
      return profile?.kind === "url" ? `Reach ${hostOf(profile.url)}` : "Check the Wisp server";
    case "load":
      return "Load your Wisps";
    case "download":
      return `Download wisp-server ${APP_METADATA.version}`;
    case "install":
      return `Install wisp-server ${APP_METADATA.version}`;
    case "service":
      return update ? "Restart the service" : "Start the service";
    case "connect":
      return update ? "Reconnect" : "Connect";
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The steps of connecting or of a setup, each with its state: done with how
 * long it took, running with how long so far, failed with why, or skipped.
 */
export function ConnectionSteps({
  progress,
  profile,
  failure,
  waitingForAnswer = false,
  now,
  className,
}: {
  progress: ConnectionProgress;
  profile?: ConnectionProfileView;
  failure?: ConnectionFailure;
  /** OpenSSH asked a question: the running step waits on the person. */
  waitingForAnswer?: boolean;
  now: number;
  className?: string;
}) {
  // The step the person cancelled is the first skipped one that had started.
  const cancelledAt = progress.steps.findIndex((step) => step.state === "skipped" && step.startedAt);
  return (
    <ol className={cn("m-0 flex list-none flex-col p-0", className)} aria-label="Steps">
      {progress.steps.map((step, index) => {
        const last = index === progress.steps.length - 1;
        const sub =
          step.state === "failed"
            ? failure
              ? FAILURE_LABELS[failure]
              : step.detail
            : step.state === "skipped"
              ? index === cancelledAt
                ? "Cancelled by you"
                : undefined
              : step.state === "active"
                ? waitingForAnswer && step.id === "sign_in"
                  ? "Waiting for your answer"
                  : step.detail
                : step.state === "pending" && step.id === "service" && progress.kind === "update"
                  ? "Running Wisps stop here"
                  : undefined;
        const meta =
          step.state === "done" && step.startedAt && step.endedAt
            ? formatDuration(step.endedAt - step.startedAt)
            : step.state === "active" && step.startedAt && !waitingForAnswer
              ? formatDuration(now - step.startedAt)
              : undefined;
        return (
          <li
            key={step.id}
            aria-current={step.state === "active" ? "step" : undefined}
            data-state={step.state}
            className="relative grid grid-cols-[20px_1fr_auto] items-start gap-2.5 py-1.5"
          >
            {last ? null : (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-[26px] -bottom-1.5 left-[9.5px] w-px",
                  step.state === "done" ? "bg-green/45" : "bg-border",
                )}
              />
            )}
            <StepDot state={step.state} />
            <span className="min-w-0 leading-5">
              <span className="sr-only">{stateNames[step.state]}: </span>
              <span className={stateText[step.state]}>{stepLabel(step, progress, profile)}</span>
              {sub ? (
                <span
                  className={cn(
                    "mt-px block text-xs leading-snug break-words",
                    step.state === "failed" ? "text-destructive" : "text-dim",
                  )}
                >
                  {sub}
                </span>
              ) : null}
            </span>
            <span className="text-xs leading-5 text-faint tabular-nums">{meta}</span>
          </li>
        );
      })}
    </ol>
  );
}

const stateText: Record<ConnectionStepState, string> = {
  pending: "text-dim",
  active: "font-medium",
  done: "",
  failed: "font-medium",
  skipped: "text-dim line-through",
};

const stateNames: Record<ConnectionStepState, string> = {
  pending: "Waiting",
  active: "In progress",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

function StepDot({ state }: { state: ConnectionStepState }) {
  const base = "relative z-[1] flex size-5 items-center justify-center rounded-full bg-card";
  if (state === "done") return <CheckIcon aria-hidden="true" className={cn(base, "p-0.5 text-green")} />;
  if (state === "active") {
    return <LoaderCircleIcon aria-hidden="true" className={cn(base, "animate-spin p-0.5 text-[var(--tone)]")} />;
  }
  if (state === "failed") return <CircleXIcon aria-hidden="true" className={cn(base, "p-px text-destructive")} />;
  if (state === "skipped") return <MinusIcon aria-hidden="true" className={cn(base, "p-0.5 text-faint")} />;
  return (
    <span aria-hidden="true" className={base}>
      <span className="size-2 rounded-full border-[1.5px] border-faint" />
    </span>
  );
}
