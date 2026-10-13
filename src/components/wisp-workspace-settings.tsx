import { useScreenActions } from "@/features/connections/active-connection";
import { useEffect, useId, useState } from "react";
import { FolderOpenIcon, HardDriveIcon } from "lucide-react";

import type { IntegrationSettingsTarget } from "@/lib/plugin-access";
import { formatBytes, type WorkspaceView } from "../../shared/workspace";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import { WorkspaceSizeSelect } from "@/components/workspace-size-select";

export function WispWorkspaceSettings({
  conversationId,
  onOpenSettings,
}: {
  conversationId: string;
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
}) {
  return <WorkspacePanel key={conversationId} conversationId={conversationId} onOpenSettings={onOpenSettings} />;
}

function WorkspacePanel({
  conversationId,
  onOpenSettings,
}: {
  conversationId: string;
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
        else setError(result.error.message);
      })
      .catch(() => {
        if (active) setError("Could not load workspace usage.");
      });
    return () => {
      active = false;
    };
  }, [loadRequest]);

  async function openFolder() {
    setError("");
    try {
      const result = await window.wisp.openWorkspaceFolder({ conversationId });
      if (!result.ok) setError(result.error.message);
    } catch {
      setError("Could not open the folder.");
    }
  }

  const percent = view ? Math.min(100, Math.round((view.usedBytes / view.quotaBytes) * 100)) : 0;
  return (
    <FieldGroup className="gap-3">
      <FieldDescription>
        A private folder only this Wisp can read and write. Attached files are copied to its inbox folder.
      </FieldDescription>
      {view ? (
        <>
          <Field>
            <FieldTitle>
              {formatBytes(view.usedBytes)} of {formatBytes(view.quotaBytes)} used
            </FieldTitle>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="Workspace usage"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div
                className={percent >= 90 ? "h-full bg-destructive" : "h-full bg-primary"}
                style={{ width: `${percent}%` }}
              />
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-size`}>Size</FieldLabel>
            <WorkspaceSizeSelect
              id={`${id}-size`}
              conversationId={conversationId}
              usedBytes={view.usedBytes}
              quotaBytes={view.quotaBytes}
              maxQuotaBytes={view.maxQuotaBytes}
              className="w-full"
              onResized={setView}
            />
            <FieldDescription>
              {view.usedBytes > view.quotaBytes
                ? "Holds more than this size. Nothing is deleted, but no new files fit until you free space."
                : "Larger sizes need free space on the disk."}
            </FieldDescription>
          </Field>
        </>
      ) : error ? null : (
        <FormStatus pending="Loading workspace…" />
      )}
      {onOpenSettings ? (
        <Button
          className="w-full"
          variant={percent >= 90 ? "default" : "outline"}
          onClick={() => onOpenSettings({ section: "storage", conversationId })}
        >
          <HardDriveIcon aria-hidden="true" />
          {percent >= 90 ? "Free up space" : "Inspect and clean up"}
        </Button>
      ) : null}
      {screenActions ? (
        <Button className="w-full" variant="outline" onClick={() => void openFolder()}>
          <FolderOpenIcon aria-hidden="true" />
          Open workspace folder
        </Button>
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
