import { CONNECTION_NOTICES_OFF_STORAGE_KEY } from "@/features/persistence/storage-policy";

/** Whether the person turned the "Connected to" notice off on this device; storage that cannot be read leaves it on. */
export function connectionNoticesOff(): boolean {
  try {
    return window.localStorage.getItem(CONNECTION_NOTICES_OFF_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Turns the notice off from the notice itself, or back on from General settings. */
export function setConnectionNoticesOff(off: boolean): void {
  try {
    if (off) window.localStorage.setItem(CONNECTION_NOTICES_OFF_STORAGE_KEY, "1");
    else window.localStorage.removeItem(CONNECTION_NOTICES_OFF_STORAGE_KEY);
  } catch {
    // Storage is unavailable, so the notice keeps showing; nothing else depends on it.
  }
}
