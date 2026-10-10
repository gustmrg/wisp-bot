/** Where a Wisp's commands run: nowhere, or in its own container. */
export type ExecutionMode = "off" | "container";

export const EXECUTION_MODES: ReadonlyArray<ExecutionMode> = ["off", "container"];

/** A container stops after this long without a command and starts again on the next one. */
export const CONTAINER_IDLE_MS = 30 * 60 * 1000;
/** Container folder that holds the Wisp's workspace, the same files its file tools see. */
export const CONTAINER_WORKSPACE = "/workspace";
/** Home folder inside the workspace, so what the Wisp installs persists and counts toward its size. */
export const CONTAINER_HOME = `${CONTAINER_WORKSPACE}/.home`;
export const MAX_CONTAINER_IMAGE_LENGTH = 255;
export const MAX_GIT_TOKEN_LENGTH = 512;

/** The container program found on the server, or why none can be used. */
export type ContainerRuntimeStatus =
  | { available: true; name: "docker" | "podman"; version: string }
  | { available: false; message: string };

export type ContainerState = "absent" | "stopped" | "running";

export interface WispExecutionView {
  mode: ExecutionMode;
  /** An image the person chose; null uses the Wisp sandbox image built on the server. */
  image: string | null;
  defaultImage: string;
  /** Whether a GitHub token is saved for this Wisp; the token itself never leaves the backend. */
  hasGitToken: boolean;
  runtime: ContainerRuntimeStatus;
  container: ContainerState;
}

export interface SaveWispExecutionRequest {
  conversationId: string;
  mode: ExecutionMode;
  image: string | null;
  /** A new token replaces the saved one, null removes it, and leaving it out keeps it. */
  gitToken?: string | null;
}

/**
 * An image reference passed to the container program as one argument. It
 * cannot start with a dash, so it is never read as an option.
 */
export function isContainerImage(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_CONTAINER_IMAGE_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(value) &&
    !value.includes("//")
  );
}

export function isGitToken(value: string): boolean {
  return value.length > 0 && value.length <= MAX_GIT_TOKEN_LENGTH && /^[\x21-\x7e]+$/.test(value);
}
