import type {
  ConnectionFailure,
  ConnectionProgress,
  ConnectionStep,
  ConnectionStepId,
} from "../../shared/connections.js";

/** The steps of connecting to a profile, given its kind and whether this device still has to pair. */
export function connectSteps(kind: "local" | "ssh" | "url", paired: boolean): ConnectionStepId[] {
  if (kind === "local") return ["start_local", "load"];
  return [
    ...(kind === "ssh" ? (["reach", "sign_in"] as const) : []),
    ...(paired ? [] : ["pair" as const]),
    "server",
    "load",
  ];
}

/** The steps of setting a server up over SSH, ending with connecting to it. */
export const INSTALL_STEPS: ConnectionStepId[] = ["download", "install", "service", "connect"];

export function createProgress(
  kind: ConnectionProgress["kind"],
  ids: ReadonlyArray<ConnectionStepId>,
  fromVersion?: string,
): ConnectionProgress {
  return {
    kind,
    steps: ids.map((id) => ({ id, state: "pending" })),
    ...(fromVersion ? { fromVersion } : {}),
  };
}

/**
 * Makes `id` the running step: every step before it is done, and the ones
 * after it wait. A step missing from the list is added before `before`, such
 * as pairing again with a server this device was paired with.
 */
export function advance(
  progress: ConnectionProgress,
  id: ConnectionStepId,
  detail?: string,
  before?: ConnectionStepId,
  now = Date.now(),
): ConnectionProgress {
  let steps = progress.steps;
  if (!steps.some((step) => step.id === id)) {
    const at = before ? steps.findIndex((step) => step.id === before) : -1;
    const added: ConnectionStep = { id, state: "pending" };
    steps = at < 0 ? [...steps, added] : [...steps.slice(0, at), added, ...steps.slice(at)];
  }
  const index = steps.findIndex((step) => step.id === id);
  return {
    ...progress,
    steps: steps.map((step, position): ConnectionStep => {
      if (position < index) return step.state === "done" ? step : finished(step, "done", now);
      if (position > index) return { id: step.id, state: "pending" };
      const running = step.state === "active";
      return {
        id: step.id,
        state: "active",
        startedAt: running && step.startedAt ? step.startedAt : now,
        ...(detail ? { detail } : running && step.detail ? { detail: step.detail } : {}),
      };
    }),
  };
}

/**
 * Marks the step that failed. OpenSSH fails reaching the host and signing in
 * in one go, so the kind of failure says which of the two it was; otherwise
 * it is the running step. Steps after it wait for the next attempt, or are
 * skipped when nothing will retry them, as after a failed setup.
 */
export function fail(
  progress: ConnectionProgress,
  failure: ConnectionFailure | undefined,
  { skipRest = false, now = Date.now() }: { skipRest?: boolean; now?: number } = {},
): ConnectionProgress {
  const { steps } = progress;
  const preferred = failure && SSH_FAILURE_STEPS[failure];
  let index = preferred ? steps.findIndex((step) => step.id === preferred && step.state !== "done") : -1;
  if (index < 0) index = steps.findIndex((step) => step.state === "active");
  if (index < 0)
    index = Math.max(
      0,
      steps.findIndex((step) => step.state === "pending"),
    );
  // Cancelling is the person's choice, not a failure.
  const cancelled = failure === "cancelled";
  return {
    ...progress,
    steps: steps.map((step, position): ConnectionStep => {
      if (position < index) return step.state === "done" ? step : finished(step, "done", now);
      if (position > index) return { id: step.id, state: skipRest ? "skipped" : "pending" };
      return finished(step, cancelled ? "skipped" : "failed", now);
    }),
  };
}

const SSH_FAILURE_STEPS: Partial<Record<ConnectionFailure, ConnectionStepId>> = {
  unreachable: "reach",
  auth: "sign_in",
  host_key: "sign_in",
};

function finished(step: ConnectionStep, state: "done" | "failed" | "skipped", now: number): ConnectionStep {
  return {
    id: step.id,
    state,
    ...(step.startedAt ? { startedAt: step.startedAt, endedAt: now } : {}),
    ...(state !== "done" && step.detail ? { detail: step.detail } : {}),
  };
}
