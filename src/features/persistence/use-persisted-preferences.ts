import { useBackendInstanceId } from "@/features/backend/backend-provider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AppPreferences } from "@/lib/app-preferences";
import { loadPreferences, savePreferences } from "@/features/persistence/preference-storage";
import { PREFERENCES_SAVE_DELAY_MS, type PersistenceStatus } from "@/features/persistence/storage-policy";

export interface PersistedPreferencesController {
  preferences: AppPreferences;
  setPreferences: React.Dispatch<React.SetStateAction<AppPreferences>>;
  status: PersistenceStatus;
  error: string | null;
  flush: () => boolean;
}

export function usePersistedPreferences(): PersistedPreferencesController {
  const instanceId = useBackendInstanceId();
  const storage = useMemo(
    () => ({
      getItem: (key: string) =>
        window.localStorage.getItem(instanceId === "local" ? key : `${key}:${encodeURIComponent(instanceId)}`),
      setItem: (key: string, value: string) =>
        window.localStorage.setItem(instanceId === "local" ? key : `${key}:${encodeURIComponent(instanceId)}`, value),
    }),
    [instanceId],
  );
  const initial = useRef<ReturnType<typeof loadPreferences> | null>(null);
  if (initial.current === null) initial.current = loadPreferences(storage);
  const [preferences, setPreferences] = useState<AppPreferences>(initial.current.value);
  const [status, setStatus] = useState<PersistenceStatus>(initial.current.ok ? "idle" : "error");
  const [error, setError] = useState<string | null>(initial.current.ok ? null : initial.current.error);
  const latest = useRef(preferences);
  const timer = useRef<number | null>(null);
  const dirty = useRef(false);
  const mounted = useRef(true);
  const initialized = useRef(false);
  const statusRef = useRef<PersistenceStatus>(initial.current.ok ? "idle" : "error");

  const updateResult = useCallback((nextStatus: PersistenceStatus, nextError: string | null): void => {
    statusRef.current = nextStatus;
    if (mounted.current) {
      setStatus(nextStatus);
      setError(nextError);
    }
  }, []);

  const flush = useCallback((): boolean => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return statusRef.current !== "error";
    const result = savePreferences(storage, latest.current);
    dirty.current = !result.ok;
    updateResult(result.ok ? "saved" : "error", result.ok ? null : result.error);
    return result.ok;
  }, [storage, updateResult]);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      return;
    }
    latest.current = preferences;
    dirty.current = true;
    updateResult("saving", null);
    timer.current = window.setTimeout(flush, PREFERENCES_SAVE_DELAY_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [flush, preferences, updateResult]);

  useEffect(() => {
    mounted.current = true;
    const handleBeforeUnload = (): void => {
      flush();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      flush();
      mounted.current = false;
    };
  }, [flush]);

  return { preferences, setPreferences, status, error, flush };
}
