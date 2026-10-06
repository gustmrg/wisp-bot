import { CircleCheckIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { UpdateState } from "../../shared/contracts";
import { Button } from "@/components/ui/button";

// Long enough to notice after the window reopens, short enough not to linger.
const UPDATED_TOAST_MS = 12_000;

/**
 * Announces update progress the user can't otherwise see from the workspace:
 * the restart while an update installs, and the new version once it reopens.
 */
export function UpdateToast({ displayName }: { displayName: string }) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [updatedDismissed, setUpdatedDismissed] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.wisp.subscribeToUpdateState((next) => {
      if (active) setState(next);
    });
    void window.wisp.getUpdateState().then((result) => {
      if (active && result.ok) setState(result.value);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const showUpdated = Boolean(state?.updatedFrom) && !updatedDismissed && state?.phase !== "installing";
  useEffect(() => {
    if (!showUpdated) return;
    const timer = setTimeout(() => setUpdatedDismissed(true), UPDATED_TOAST_MS);
    return () => clearTimeout(timer);
  }, [showUpdated]);

  if (state?.phase === "installing") {
    return (
      <ToastFrame>
        <LoaderCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin text-blue" />
        <div className="grid gap-0.5">
          <strong className="text-[12.5px]">Installing version {state.availableVersion ?? "new"}…</strong>
          <span className="text-[11.5px] text-dim">{displayName} will close and reopen on its own.</span>
        </div>
      </ToastFrame>
    );
  }
  if (!showUpdated || !state) return null;
  return (
    <ToastFrame>
      <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-blue" />
      <div className="grid gap-0.5">
        <strong className="text-[12.5px]">
          {displayName} updated to {state.currentVersion}
        </strong>
        <span className="text-[11.5px] text-dim">Previously {state.updatedFrom}.</span>
        <button
          type="button"
          className="mt-1 justify-self-start text-[11.5px] text-blue hover:underline"
          onClick={() => void window.wisp.openReleasesPage()}
        >
          See what's new
        </button>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        aria-label="Dismiss"
        className="-mt-1 -mr-1 ml-auto"
        onClick={() => setUpdatedDismissed(true)}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </ToastFrame>
  );
}

function ToastFrame({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="fixed right-4 bottom-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] items-start gap-2.5 rounded-xl border border-border bg-card p-3.5 text-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-2"
    >
      {children}
    </div>
  );
}
