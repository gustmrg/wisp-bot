import { useScreenActions } from "@/features/connections/active-connection";
import { useEffect, useId, useState } from "react";
import { FolderOpenIcon, HardDriveIcon } from "lucide-react";

import type { IntegrationSettingsTarget } from "@/lib/plugin-access";
import { WORKSPACE_DISK_RESERVE_BYTES, formatBytes, workspaceUsage, type WorkspaceView } from "../../shared/workspace";
import { SettingsActions } from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import { WorkspaceSizeSelect } from "@/components/workspace-size-select";

const OLD_SERVER_CIRCLE =
  "This server is older than this app and cannot show a circle's workspace. Update the server to see and resize it.";

/** A Wisp's or a circle's workspace: its usage, size, and folder. */
export function WispWorkspaceSettings({
  conversationId,
  kind = "wisp",
  onOpenSettings,
}: {
  conversationId: string;
  kind?: "wisp" | "circle";
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
}) {
  return (
    <WorkspacePanel key={conversationId} conversationId={conversationId} kind={kind} onOpenSettings={onOpenSettings} />
  );
}

function WorkspacePanel({
  conversationId,
  kind,
  onOpenSettings,
}: {
  conversationId: string;
  kind: "wisp" | "circle";
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
}) {
  // Opening a folder needs this computer's file manager and the Wisp's files on this computer.
  const screenActions = useScreenActions();
  const id = useId();
  const [view, setView] = useState<WorkspaceView | null>(null);
  const [error, setError] = useState("");
  const [loadRequest, setLoadRequest] = useState({ conversationId });

  useEffect(() => {
    let active = true;
    setError("");
    void window.wisp
      .getWorkspace(loadRequest)
      .then((result) => {
        if (!active) return;
        if (result.ok) setView(result.value);
        // Servers from before circles had a workspace size refuse circles as invalid.
        else if (kind === "circle" && result.error.code === "invalid_request") setError(OLD_SERVER_CIRCLE);
        else setError(result.error.message);
      })
      .catch(() => {
        if (active) setError("Could not load workspace usage.");
      });
    return () => {
      active = false;
    };
  }, [loadRequest, kind]);

  async function openFolder() {
    setError("");
    try {
      const result = await window.wisp.openWorkspaceFolder({ conversationId });
      if (!result.ok) setError(result.error.message);
    } catch {
      setError("Could not open the folder.");
    }
  }

  const usage = view ? workspaceUsage(view) : null;
  return (
    <FieldGroup className="gap-3">
      <FieldDescription>
        {kind === "circle"
          ? "A folder every Wisp in this circle reads and writes. Attached files are copied to its inbox folder."
          : "A private folder only this Wisp can read and write. Attached files are copied to its inbox folder."}
      </FieldDescription>
      {view ? (
        <>
          <Field>
            {usage && usage.percent !== null ? (
              <>
                <FieldTitle>
                  {formatBytes(view.usedBytes)} of {formatBytes(view.quotaBytes)} used
                </FieldTitle>
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label="Workspace usage"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={usage.percent}
                >
                  <div
                    className={usage.nearlyFull ? "h-full bg-destructive" : "h-full bg-primary"}
                    style={{ width: `${usage.percent}%` }}
                  />
                </div>
              </>
            ) : (
              // Without a size there is nothing to fill: what it holds, and what is left on its disk.
              <FieldTitle>
                {formatBytes(view.usedBytes)} used
                {view.freeDiskBytes === undefined ? "" : ` · ${formatBytes(view.freeDiskBytes)} free on disk`}
              </FieldTitle>
            )}
          </Field>
          <Field>
            <div className="flex flex-col gap-1.5 min-[761px]:flex-row min-[761px]:items-center min-[761px]:justify-between">
              <FieldLabel htmlFor={`${id}-size`}>Size</FieldLabel>
              <WorkspaceSizeSelect
                id={`${id}-size`}
                conversationId={conversationId}
                usedBytes={view.usedBytes}
                quotaBytes={view.quotaBytes}
                maxQuotaBytes={view.maxQuotaBytes}
                unlimited={view.unlimited}
                freeDiskBytes={view.freeDiskBytes}
                className="w-full min-[761px]:w-36"
                onResized={setView}
              />
            </div>
            <FieldDescription>
              {view.unlimited
                ? usage?.full
                  ? "Its disk is almost full. No new files fit until you free space on the disk."
                  : `No size limit. New files stop when its disk has ${formatBytes(WORKSPACE_DISK_RESERVE_BYTES)} left.`
                : view.usedBytes > view.quotaBytes
                  ? "Holds more than this size. Nothing is deleted, but no new files fit until you free space."
                  : "Larger sizes need free space on the disk."}
            </FieldDescription>
          </Field>
        </>
      ) : error ? null : (
        <FormStatus pending="Loading workspace…" />
      )}
      {onOpenSettings || screenActions ? (
        <SettingsActions>
          {onOpenSettings ? (
            <Button
              variant={usage?.nearlyFull ? "default" : "outline"}
              onClick={() => onOpenSettings({ section: "storage", conversationId })}
            >
              <HardDriveIcon data-icon="inline-start" aria-hidden="true" />
              {usage?.nearlyFull ? "Free up space" : "Inspect and clean up"}
            </Button>
          ) : null}
          {screenActions ? (
            <Button variant="outline" onClick={() => void openFolder()}>
              <FolderOpenIcon data-icon="inline-start" aria-hidden="true" />
              Open workspace folder
            </Button>
          ) : null}
        </SettingsActions>
      ) : null}
      <FormStatus error={error} />
      {!view && error ? (
        <Button className="self-start" variant="outline" size="sm" onClick={() => setLoadRequest({ conversationId })}>
          Retry
        </Button>
      ) : null}
    </FieldGroup>
  );
}
