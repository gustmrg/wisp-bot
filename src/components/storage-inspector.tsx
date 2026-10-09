import { useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon, FolderOpenIcon } from "lucide-react";

import { describeStorageFailure, formatMeasuredAt } from "@/lib/storage-format";
import { ConfirmAction, SettingsCard } from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { useScreenActions } from "@/features/connections/active-connection";
import type { StorageCleanupPreview, StorageEntry, StorageWorkspace } from "../../shared/storage";
import { WORKSPACE_INBOX_DIRECTORY, formatBytes } from "../../shared/workspace";

interface Listing {
  entries: StorageEntry[];
  nextCursor: string | null;
}

export function StorageInspector({
  workspace,
  onClose,
  onChanged,
}: {
  workspace: StorageWorkspace;
  onClose: () => void;
  /** Called after files were removed, so the summary measures again. */
  onChanged: () => void;
}) {
  const { conversationId } = workspace;
  const screenActions = useScreenActions();
  const [folder, setFolder] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState<StorageCleanupPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void window.wisp
      .listStorageDirectory({ conversationId, path: folder })
      .then((result) => {
        if (!active) return;
        if (result.ok) setListing({ entries: [...result.value.entries], nextCursor: result.value.nextCursor });
        else setError(describeStorageFailure(result));
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setError("Could not read this folder.");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [conversationId, folder, reload]);

  function go(next: string) {
    setFolder(next);
    setSelected(new Set());
    setPreview(null);
    setMessage("");
  }

  async function loadMore() {
    if (!listing?.nextCursor) return;
    setLoading(true);
    try {
      const result = await window.wisp.listStorageDirectory({
        conversationId,
        path: folder,
        cursor: listing.nextCursor,
      });
      if (result.ok) {
        setListing({ entries: [...listing.entries, ...result.value.entries], nextCursor: result.value.nextCursor });
      } else setError(describeStorageFailure(result));
    } catch {
      setError("Could not read more entries.");
    } finally {
      setLoading(false);
    }
  }

  async function prepare() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await window.wisp.prepareStorageCleanup({ conversationId, paths: [...selected] });
      if (result.ok) setPreview(result.value);
      else setError(describeStorageFailure(result));
    } catch {
      setError("Could not prepare the cleanup.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.wisp.cleanStorage({
        conversationId,
        paths: [...selected],
        fingerprint: preview.fingerprint,
      });
      if (!result.ok) {
        setError(describeStorageFailure(result));
        // The files changed or the workspace is busy: the preview is stale either way.
        setPreview(null);
        return;
      }
      const { removed, failed, removedBytes } = result.value;
      setMessage(
        failed.length
          ? `Removed ${removed.length} of ${removed.length + failed.length} items (${formatBytes(removedBytes)} of files). Not removed: ${failed.map((item) => `${item.path} (${item.message})`).join(", ")}`
          : `Removed ${removed.length} ${removed.length === 1 ? "item" : "items"} (${formatBytes(removedBytes)} of files). Space on disk may be recovered differently.`,
      );
      setPreview(null);
      setSelected(new Set());
      setReload((count) => count + 1);
      onChanged();
    } catch {
      setError("Could not remove the files.");
    } finally {
      setBusy(false);
    }
  }

  const openFolder = useCallback(async () => {
    try {
      const result = await window.wisp.openWorkspaceFolder({ conversationId });
      if (!result.ok) setError(result.error.message);
    } catch {
      setError("Could not open the folder.");
    }
  }, [conversationId]);

  const segments = folder ? folder.split("/") : [];
  const inInbox = folder === WORKSPACE_INBOX_DIRECTORY || folder.startsWith(`${WORKSPACE_INBOX_DIRECTORY}/`);
  const nearlyFull = workspace.usedBytes / workspace.quotaBytes >= 0.9;
  const entries = listing?.entries ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          <ArrowLeftIcon aria-hidden="true" />
          All workspaces
        </Button>
        {screenActions ? (
          <Button size="sm" variant="outline" onClick={() => void openFolder()}>
            <FolderOpenIcon aria-hidden="true" />
            Open folder
          </Button>
        ) : null}
      </div>
      <h3 className="m-0 text-sm font-medium">
        {workspace.name} · {formatBytes(workspace.usedBytes)} of {formatBytes(workspace.quotaBytes)}
      </h3>
      {nearlyFull ? (
        <p role="alert" className="m-0 text-xs text-destructive">
          This workspace is almost full. New attachments are refused once it is. Select files below to remove them.
        </p>
      ) : null}

      <nav aria-label="Folder" className="flex flex-wrap items-center gap-1 text-xs">
        <Button size="xs" variant="link" className="h-auto p-0" onClick={() => go("")}>
          Workspace
        </Button>
        {segments.map((segment, index) => (
          <span key={segments.slice(0, index + 1).join("/")} className="flex items-center gap-1">
            <span aria-hidden="true">/</span>
            <Button
              size="xs"
              variant="link"
              className="h-auto p-0"
              onClick={() => go(segments.slice(0, index + 1).join("/"))}
            >
              {segment}
            </Button>
          </span>
        ))}
      </nav>
      {inInbox ? (
        <p className="m-0 text-xs text-dim">
          Attachments you sent to this Wisp. Messages may still refer to files removed from here.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="m-0 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="m-0 text-xs text-dim">
          {message}
        </p>
      ) : null}

      {loading && !listing ? (
        <p role="status" className="m-0 text-xs text-dim">
          Loading folder…
        </p>
      ) : entries.length === 0 ? (
        <p className="m-0 text-xs text-dim">This folder is empty.</p>
      ) : (
        <SettingsCard className="overflow-x-auto" aria-busy={loading || undefined}>
          <table className="w-full text-left text-xs tabular-nums">
            <caption className="sr-only">Contents of {folder || "the workspace"}, largest first</caption>
            <thead>
              <tr className="text-dim">
                <th scope="col" className="w-8 border-b border-border px-3 py-2 font-normal">
                  <span className="sr-only">Select</span>
                </th>
                {["Name", "Size", "Modified"].map((heading) => (
                  <th scope="col" key={heading} className="border-b border-border px-3 py-2 font-normal">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="[&>tr:not(:last-child)>*]:border-b [&>tr>*]:border-border">
              {entries.map((entry) => (
                <tr key={entry.path}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${entry.name}`}
                      disabled={entry.type !== "file" && entry.type !== "directory"}
                      checked={selected.has(entry.path)}
                      onChange={(event) => {
                        const next = new Set(selected);
                        if (event.target.checked) next.add(entry.path);
                        else next.delete(entry.path);
                        setSelected(next);
                        setPreview(null);
                      }}
                    />
                  </td>
                  <td className="max-w-56 px-3 py-2 break-words">
                    {entry.type === "directory" ? (
                      <Button size="xs" variant="link" className="h-auto p-0" onClick={() => go(entry.path)}>
                        {entry.name}/
                      </Button>
                    ) : (
                      entry.name
                    )}
                    {entry.type === "link" ? <span className="block text-dim">Link</span> : null}
                    {entry.type === "directory" ? (
                      <span className="block text-dim">{entry.fileCount.toLocaleString("en-US")} files</span>
                    ) : null}
                  </td>
                  <td className="px-3">
                    {formatBytes(entry.size)}
                    {entry.partial ? " +" : ""}
                  </td>
                  <td className="px-3">{entry.modifiedAt ? formatMeasuredAt(entry.modifiedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SettingsCard>
      )}
      {listing?.nextCursor ? (
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void loadMore()}>
          Load more
        </Button>
      ) : null}

      {preview ? (
        <div role="group" aria-label="Cleanup preview" className="space-y-2 rounded-[10px] bg-popover p-3 text-xs">
          <p className="m-0 font-medium">
            {preview.items.length} {preview.items.length === 1 ? "item" : "items"} ·{" "}
            {preview.fileCount.toLocaleString("en-US")} files · {formatBytes(preview.totalBytes)}
          </p>
          <ul className="m-0 max-h-40 list-none overflow-y-auto p-0 font-mono">
            {preview.items.map((item) => (
              <li key={item.path} className="break-all">
                {item.path}
                {item.type === "directory" ? "/" : ""} <span className="text-dim">{formatBytes(item.size)}</span>
              </li>
            ))}
          </ul>
          {preview.includesInbox ? (
            <p className="m-0 text-dim">
              Messages that refer to removed attachments may no longer be able to open them.
            </p>
          ) : null}
          <ConfirmAction
            label="Review permanent removal"
            confirmLabel="Remove permanently"
            pending={busy}
            pendingLabel="Removing…"
            description={`Permanently removes ${preview.items.length} ${preview.items.length === 1 ? "item" : "items"} (${formatBytes(preview.totalBytes)} of files) from this workspace. This cannot be undone. The conversation and the Wisp's settings are kept.`}
            onConfirm={() => void confirm()}
          />
        </div>
      ) : (
        <Button size="sm" variant="destructive" disabled={selected.size === 0 || busy} onClick={() => void prepare()}>
          {selected.size ? `Clean ${selected.size} selected…` : "Clean selected…"}
        </Button>
      )}
    </div>
  );
}
