/** The npm package that installs a headless Wisp server; its version always matches the desktop app's. */
export const WISP_SERVER_PACKAGE = "@gustmrg/wisp-server";

/** Versions the desktop app may pass to a remote shell; anything else is never interpolated into a command. */
export const SERVER_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
