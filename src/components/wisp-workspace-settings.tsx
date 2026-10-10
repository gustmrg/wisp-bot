import { useScreenActions } from "@/features/connections/active-connection";
import { useEffect, useId, useState } from "react";
import { FolderOpenIcon, HardDriveIcon } from "lucide-react";

import type { IntegrationSettingsTarget } from "@/lib/plugin-access";
import { formatBytes, type WorkspaceView } from "../../shared/workspace";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { WorkspaceSizeSelect } from "@/components/workspace-size-select";

export function WispWorkspaceSettings({
  conversationId,
  onOpenSettings,
}: {
  conversationId: string;
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
}) {
  const [visited, setVisited] = useState(false);
  return (
    <Accordion
      className="mt-4"
      onValueChange={(values) => {
        if (values.length) setVisited(true);
      }}
    >
      <AccordionItem value="workspace">
        <AccordionTrigger>Workspace</AccordionTrigger>
        <AccordionContent keepMounted>
          {visited ? (
            <WorkspacePanel key={conversationId} conversationId={conversationId} onOpenSettings={onOpenSettings} />
          ) : null}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
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

  useEffect(() => {
    let active = true;
    void window.wisp
      .getWorkspace({ conversationId })
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
  }, [conversationId]);

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
    <div className="space-y-3 text-sm">
      <p className="text-dim">
        A private folder only this Wisp can read and write. Attached files are copied to its inbox folder.
      </p>
      {view ? (
        <div className="space-y-1.5">
          <p>
            {formatBytes(view.usedBytes)} of {formatBytes(view.quotaBytes)} used
          </p>
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
        </div>
      ) : null}
      {view ? (
        <div className="space-y-1.5">
          <label htmlFor={`${id}-size`}>Size</label>
          <WorkspaceSizeSelect
            id={`${id}-size`}
            conversationId={conversationId}
            usedBytes={view.usedBytes}
            quotaBytes={view.quotaBytes}
            maxQuotaBytes={view.maxQuotaBytes}
            className="w-full"
            onResized={setView}
          />
          <p className="text-dim">
            {view.usedBytes > view.quotaBytes
              ? "Holds more than this size. Nothing is deleted, but no new files fit until you free space."
              : "Larger sizes need free space on the disk."}
          </p>
        </div>
      ) : null}
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
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
