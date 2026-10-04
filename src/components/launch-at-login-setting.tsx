import { useEffect, useRef, useState } from "react";
import type { BackendResult, LaunchAtLoginState } from "../../shared/contracts";
import { SettingsRow, SettingsRowCopy } from "@/components/settings/settings-primitives";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

export function LaunchAtLoginSetting({ open }: { open: boolean }) {
  const [state, setState] = useState<LaunchAtLoginState>({ supported: false, enabled: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const mutation = useRef<Promise<BackendResult<LaunchAtLoginState>> | null>(null);

  useEffect(() => {
    if (!open) return;
    const api = window.wisp;
    if (!api?.getLaunchAtLoginState) {
      setState({
        supported: false,
        enabled: false,
        reason: "Launch at login is available only in an installed Linux release.",
      });
      return;
    }
    let active = true;
    async function refresh() {
      const version = ++request.current;
      setBusy(true);
      setError(null);
      try {
        await mutation.current?.catch(() => undefined);
        if (!active || version !== request.current) return;
        const result = await api.getLaunchAtLoginState();
        if (!active || version !== request.current) return;
        if (result.ok) setState(result.value);
        else setError(result.error.message);
      } catch {
        if (active && version === request.current) setError("Could not read launch at login settings.");
      } finally {
        if (active && version === request.current) setBusy(false);
      }
    }
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      ++request.current;
      window.removeEventListener("focus", refresh);
    };
  }, [open]);

  async function toggle() {
    if (busy || mutation.current || !state.supported) return;
    const version = ++request.current;
    setBusy(true);
    setError(null);
    try {
      mutation.current = window.wisp.setLaunchAtLogin(!state.enabled);
      const result = await mutation.current;
      if (version !== request.current) return;
      if (result.ok) setState(result.value);
      else setError(result.error.message);
    } catch {
      if (version === request.current) setError("Could not change launch at login settings.");
    } finally {
      mutation.current = null;
      if (version === request.current) setBusy(false);
    }
  }

  return (
    <SettingsRow>
      <SettingsRowCopy>
        <strong>Launch at login</strong>
        <small>{state.reason ?? "Open Wisp automatically when you sign in."}</small>
        {error ? <small role="alert">{error}</small> : null}
      </SettingsRowCopy>
      <ToggleSwitch
        label="Launch at login"
        checked={state.enabled}
        disabled={busy || !state.supported}
        onChange={() => void toggle()}
      />
    </SettingsRow>
  );
}
