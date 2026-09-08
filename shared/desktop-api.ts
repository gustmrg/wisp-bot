import type { WispApi } from "./contracts.js";

export const DESKTOP_API_METHODS = [
  "getUpdateState",
  "checkForUpdates",
  "downloadUpdate",
  "installUpdate",
  "subscribeToUpdateState",
] as const;

export type DesktopApi = Pick<WispApi, (typeof DESKTOP_API_METHODS)[number]>;
