import type { BackendResult } from "../../shared/contracts";

/** Shown when the server predates the Storage operations. */
const UNSUPPORTED = "This server is older than this app and cannot report storage. Update the server to use Storage.";

export function describeStorageFailure(result: Extract<BackendResult<unknown>, { ok: false }>): string {
  return result.error.code === "unsupported" ? UNSUPPORTED : result.error.message;
}

export function formatMeasuredAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}
