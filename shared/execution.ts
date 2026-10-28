/** Where a Wisp's commands run: nowhere, or in its own container. */
export type ExecutionMode = "off" | "container";

export const EXECUTION_MODES: ReadonlyArray<ExecutionMode> = ["off", "container"];

/** A Wisp's browser closes after this long without being used; its pages and sign-ins go with it. */
export const BROWSER_IDLE_MS = 10 * 60 * 1000;

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
  /** Whether commands and the browser may reach local and private network addresses; the internet is always reachable. */
  localNetwork: boolean;
  /** Whether the Wisp has a browser, in a container of its own; it does not need commands. */
  browser: boolean;
  defaultImage: string;
  /** Whether git can use the GitHub plugin's token: the Wisp has access to an enabled GitHub plugin. */
  gitHubPlugin: boolean;
  /** The instance git reaches with the GitLab plugin's token, when the Wisp has access to an enabled GitLab plugin. */
  gitLabInstance: string | null;
  runtime: ContainerRuntimeStatus;
  container: ContainerState;
}

/** What a Wisp being created can be given, before it exists. */
export interface WispSetupView {
  /** The largest workspace size the disk has room for. */
  maxQuotaBytes: number;
  /** A new Wisp's workspace can be given no size; absent from servers older than unlimited workspaces. */
  unlimitedWorkspaces?: boolean;
  runtime: ContainerRuntimeStatus;
}

export interface SaveWispExecutionRequest {
  conversationId: string;
  mode: ExecutionMode;
  image: string | null;
  localNetwork: boolean;
  /** Left out keeps the current setting. */
  browser?: boolean;
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

/** A GitLab instance's address the git gateway can be given: HTTPS, without credentials, query, fragment or trailing slash. */
export function isGitUpstream(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    value.length <= 2048 &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    !value.endsWith("/")
  );
}

export function isGitToken(value: string): boolean {
  return value.length > 0 && value.length <= MAX_GIT_TOKEN_LENGTH && /^[\x21-\x7e]+$/.test(value);
}

/** Longest description a Wisp can give a command, shown in its usage report. */
export const MAX_COMMAND_DESCRIPTION_LENGTH = 120;

/** How a command ended, kept in its tool result's details under `commandResult`. */
export interface CommandResultDetails {
  exitCode?: number;
  durationMs?: number;
}
