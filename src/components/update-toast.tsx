import { CircleCheckIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { UpdateState } from "../../shared/contracts";
import { Button } from "@/components/ui/button";

// Long enough to notice after the window reopens, short enough not to linger.
const UPDATED_TOAST_MS = 12_000;

interface UpdateToastProps {
  displayName: string;
  /** The last version announced on this device, so each update is announced once. */
  announcedVersion: string;
  /** Records that this version was announced, whether or not the toast was read. */
  onAnnounced: (version: string) => void;
}

/**
 * Announces update progress the user can't otherwise see from the workspace:
 * the restart while an update installs, and the new version once it reopens,
 * once per version (SWE-230). The main process remembers the update until it
 * quits, so the version announced is remembered here, where a reopened window
 * or a reload still knows it.
 */
export function UpdateToast({ displayName, announcedVersion, onAnnounced }: UpdateToastProps) {
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

  // Kept for the toast's lifetime, so recording the version does not hide it while it shows.
  const [announcing, setAnnouncing] = useState<string>();
  const updatedVersion = state?.updatedFrom ? state.currentVersion : undefined;
  useEffect(() => {
    if (!updatedVersion || updatedVersion === announcedVersion || announcing) return;
    setAnnouncing(updatedVersion);
    onAnnounced(updatedVersion);
  }, [updatedVersion, announcedVersion, announcing, onAnnounced]);
  const showUpdated = Boolean(announcing) && !updatedDismissed && state?.phase !== "installing";
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
          <strong className="text-sm">Installing version {state.availableVersion ?? "new"}…</strong>
          <span className="text-xs text-dim">{displayName} will close and reopen on its own.</span>
        </div>
      </ToastFrame>
    );
  }
  if (!showUpdated || !state) return null;
  return (
    <ToastFrame>
      <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-blue" />
      <div className="grid gap-0.5">
        <strong className="text-sm">
          {displayName} updated to {state.currentVersion}
        </strong>
        <span className="text-xs text-dim">Previously {state.updatedFrom}.</span>
        <button
          type="button"
          className="mt-1 justify-self-start text-xs text-blue hover:underline"
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

/**
 * A toast at the bottom right of the window, the place every toast of the app
 * uses. Toasts shown at the same time stack one above the other.
 */
export function ToastFrame({ children }: { children: ReactNode }) {
  return createPortal(
    <div
      role="status"
      className="pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border border-border bg-card p-3.5 text-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-2"
    >
      {children}
    </div>,
    toastStack(),
  );
}

let stack: HTMLElement | undefined;

/** The one column every toast renders into, created the first time a toast shows. */
function toastStack(): HTMLElement {
  if (stack?.isConnected) return stack;
  stack = document.createElement("div");
  stack.dataset.toastStack = "";
  stack.className =
    "pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col items-stretch gap-2";
  document.body.append(stack);
  return stack;
}
