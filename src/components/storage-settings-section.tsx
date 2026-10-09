import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCwIcon, SearchIcon } from "lucide-react";

import { StorageInspector } from "@/components/storage-inspector";
import {
  ConfirmAction,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { describeStorageFailure, formatMeasuredAt } from "@/lib/storage-format";
import { ActiveConnectionContext } from "@/features/connections/active-connection";
import type { StorageArchive, StorageSummary, StorageWorkspace } from "../../shared/storage";
import { formatBytes } from "../../shared/workspace";

export function StorageSettingsSection({ initialConversationId }: { initialConversationId?: string }) {
  const connection = useContext(ActiveConnectionContext);
  const connectionName =
    connection?.profiles.find((profile) => profile.id === connection.activeId)?.name ?? "This computer";
  const [state, setState] = useState<{ summary?: StorageSummary; error?: string; loading: boolean }>({ loading: true });
  const [refreshCount, setRefreshCount] = useState(0);
  const [query, setQuery] = useState("");
  const [onlyConversation, setOnlyConversation] = useState(initialConversationId ?? null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const first = useRef(true);

  useEffect(() => {
    let active = true;
    const refresh = !first.current;
    first.current = false;
    setState((current) => ({ summary: current.summary, loading: true }));
    void window.wisp
      .getStorageSummary(refresh ? { refresh: true } : {})
      .then((result) => {
        if (!active) return;
        setState(
          result.ok
            ? { summary: result.value, loading: false }
            : { summary: undefined, error: describeStorageFailure(result), loading: false },
        );
      })
      .catch(() => {
        if (active) setState({ error: "Could not measure storage.", loading: false });
      });
    return () => {
      active = false;
    };
  }, [refreshCount]);

  const { summary } = state;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (summary?.workspaces ?? []).filter(
      (workspace) =>
        (!onlyConversation || workspace.conversationId === onlyConversation) &&
        (!needle || workspace.name.toLowerCase().includes(needle)),
    );
  }, [summary, query, onlyConversation]);
  const inspected = summary?.workspaces.find((workspace) => workspace.conversationId === inspecting);

  return (
    <section
      id="storage-settings-panel"
      aria-labelledby="storage-settings-title"
      className="min-w-0 overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5"
    >
      <h2 id="storage-settings-title" className="mb-1 mt-0 text-lg font-semibold">
        Storage
      </h2>
      <p className="mb-4 text-xs leading-relaxed text-dim">
        Files in workspaces on <strong className="font-medium text-foreground">{connectionName}</strong>. Sizes are the
        length of the files, not the space they take on disk. Conversations, settings and sessions are not counted.
      </p>

      {inspected ? (
        <StorageInspector
          workspace={inspected}
          onClose={() => setInspecting(null)}
          onChanged={() => setRefreshCount((count) => count + 1)}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span role="status" className="text-xs text-dim">
              {state.loading
                ? "Measuring…"
                : summary
                  ? `Measured ${formatMeasuredAt(summary.measuredAt)}. Changes made outside Wisp need a refresh.`
                  : ""}
            </span>
            <Button size="sm" variant="ghost" disabled={state.loading} onClick={() => setRefreshCount((c) => c + 1)}>
              <RefreshCwIcon aria-hidden="true" />
              Refresh
            </Button>
          </div>
          {state.error ? (
            <p role="alert" className="mt-4 text-xs text-destructive">
              {state.error}
            </p>
          ) : null}
          {summary ? (
            <div aria-busy={state.loading || undefined} className={state.loading ? "opacity-60" : undefined}>
              <SettingsGroup label="Summary">
                <SettingsCard variant="stacked">
                  <SettingsRow>
                    <SettingsRowCopy>
                      <strong>Active workspaces</strong>
                      <small>
                        {summary.workspaces.length} {summary.workspaces.length === 1 ? "workspace" : "workspaces"}
                      </small>
                    </SettingsRowCopy>
                    <span className="text-md font-medium tabular-nums">{formatBytes(summary.workspaceBytes)}</span>
                  </SettingsRow>
                  <SettingsRow>
                    <SettingsRowCopy>
                      <strong>Archived conversations</strong>
                      <small>Kept after a Wisp or circle is deleted. Measured apart from workspaces.</small>
                    </SettingsRowCopy>
                    <span className="text-md font-medium tabular-nums">{formatBytes(summary.archiveBytes)}</span>
                  </SettingsRow>
                </SettingsCard>
              </SettingsGroup>
              {summary.partial ? (
                <p role="alert" className="mx-0.5 mt-[7px] text-xs text-destructive">
                  Some folders could not be read, so the totals shown are a minimum.
                </p>
              ) : null}

              <SettingsGroup label="Workspaces">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <div className="relative min-w-40 flex-1">
                    <SearchIcon
                      aria-hidden="true"
                      className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-dim"
                    />
                    <Input
                      aria-label="Search workspaces"
                      placeholder="Search workspaces"
                      className="pl-8"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                  {onlyConversation ? (
                    <Button size="sm" variant="outline" onClick={() => setOnlyConversation(null)}>
                      Show all workspaces
                    </Button>
                  ) : null}
                </div>
                {visible.length === 0 ? (
                  <p className="mx-0.5 text-xs text-dim">
                    {summary.workspaces.length === 0
                      ? "No workspaces yet."
                      : "No workspace matches. Clear the search to see them all."}
                  </p>
                ) : (
                  <SettingsCard variant="stacked">
                    {visible.map((workspace) => (
                      <WorkspaceRow key={workspace.conversationId} workspace={workspace} onInspect={setInspecting} />
                    ))}
                  </SettingsCard>
                )}
              </SettingsGroup>

              <ArchiveList archives={summary.archives} onDeleted={() => setRefreshCount((count) => count + 1)} />
            </div>
          ) : state.loading && !state.error ? (
            <p role="status" className="mt-4 text-xs text-dim">
              Loading storage…
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function WorkspaceRow({
  workspace,
  onInspect,
}: {
  workspace: StorageWorkspace;
  onInspect: (conversationId: string) => void;
}) {
  const percent = Math.min(100, Math.round((workspace.usedBytes / workspace.quotaBytes) * 100));
  return (
    <SettingsRow>
      <SettingsRowCopy>
        <strong className="truncate">{workspace.name}</strong>
        <small>
          {workspace.kind === "circle" ? "Circle · " : ""}
          {workspace.fileCount.toLocaleString("en-US")} {workspace.fileCount === 1 ? "file" : "files"} ·{" "}
          {formatBytes(workspace.usedBytes)} of {formatBytes(workspace.quotaBytes)} ({percent}%)
          {workspace.partial ? " · partial" : ""}
        </small>
        <div
          className="mt-1 h-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={`${workspace.name} usage`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className={percent >= 90 ? "h-full bg-destructive" : "h-full bg-primary"}
            style={{ width: `${percent}%` }}
          />
        </div>
      </SettingsRowCopy>
      <Button
        size="sm"
        variant="outline"
        aria-label={`Inspect ${workspace.name}`}
        onClick={() => onInspect(workspace.conversationId)}
      >
        Inspect
      </Button>
    </SettingsRow>
  );
}

function ArchiveList({ archives, onDeleted }: { archives: ReadonlyArray<StorageArchive>; onDeleted: () => void }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const present = useMemo(() => new Set(archives.map(({ id }) => id)), [archives]);
  const chosen = [...selected].filter((id) => present.has(id));
  const chosenBytes = archives.filter(({ id }) => selected.has(id)).reduce((sum, { usedBytes }) => sum + usedBytes, 0);

  async function remove() {
    setPending(true);
    setMessage("");
    try {
      const result = await window.wisp.deleteArchivedStorage({ ids: chosen });
      if (!result.ok) {
        setMessage(describeStorageFailure(result));
        return;
      }
      const { removed, failed } = result.value;
      setMessage(
        failed.length
          ? `Deleted ${removed.length}; ${failed.length} could not be deleted: ${failed.map(({ message: reason }) => reason).join(" ")}`
          : `Deleted ${removed.length} archived ${removed.length === 1 ? "conversation" : "conversations"}.`,
      );
      setSelected(new Set());
      onDeleted();
    } catch {
      setMessage("Could not delete the archives.");
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsGroup label="Archived">
      {archives.length === 0 ? (
        <p className="mx-0.5 text-xs text-dim">No archived conversations.</p>
      ) : (
        <div className="space-y-2">
          <SettingsCard variant="stacked">
            {archives.map((archive) => (
              <SettingsRow key={archive.id}>
                <input
                  type="checkbox"
                  aria-label={`Select archive ${archive.id}`}
                  checked={selected.has(archive.id)}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(archive.id);
                    else next.delete(archive.id);
                    setSelected(next);
                  }}
                />
                <SettingsRowCopy>
                  <strong className="truncate">{archive.id}</strong>
                  <small>
                    {archive.archivedAt ? `Archived ${formatMeasuredAt(archive.archivedAt)}` : "Archive date unknown"} ·{" "}
                    {archive.fileCount.toLocaleString("en-US")} files{archive.partial ? " · partial" : ""}
                  </small>
                </SettingsRowCopy>
                <span className="text-sm tabular-nums">{formatBytes(archive.usedBytes)}</span>
              </SettingsRow>
            ))}
          </SettingsCard>
          <ConfirmAction
            label={chosen.length ? `Delete ${chosen.length} permanently` : "Delete selected permanently"}
            confirmLabel="Delete permanently"
            pending={pending}
            pendingLabel="Deleting…"
            disabled={chosen.length === 0}
            description={
              <>
                Permanently deletes {chosen.length} archived {chosen.length === 1 ? "conversation" : "conversations"} (
                {formatBytes(chosenBytes)} of files). Each archive can hold the workspace, saved sessions and the
                Wisp&apos;s settings, not just attachments. This cannot be undone.
              </>
            }
            onConfirm={() => void remove()}
          />
        </div>
      )}
      {message ? (
        <p role="status" className="mx-0.5 mt-2 text-xs text-dim">
          {message}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
