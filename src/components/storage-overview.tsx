import { useState } from "react";

import { SettingsCard, SettingsGroup } from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import type { StorageSummary } from "../../shared/storage";
import { formatBytes } from "../../shared/workspace";

/** Rows shown for each kind of largest consumer. */
export const LARGEST_SHOWN = 5;
/** Shares drawn apart in a usage bar; the rest share one grey segment. */
const NAMED_SHARES = 4;
const SHARE_COLORS = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4"];

export interface UsageShare {
  key: string;
  label: string;
  bytes: number;
}

function countFiles(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "file" : "files"}`;
}

/** Where the inspector opens: a workspace, optionally a folder in it and a file to select there. */
export interface InspectTarget {
  conversationId: string;
  path?: string;
  select?: string;
}

/** The largest `NAMED_SHARES` shares, then one for everything else. Expects the shares largest first. */
function groupShares(shares: ReadonlyArray<UsageShare>, restLabel: (count: number) => string): UsageShare[] {
  const named = shares.slice(0, NAMED_SHARES);
  const rest = shares.slice(NAMED_SHARES);
  const restBytes = rest.reduce((sum, { bytes }) => sum + bytes, 0);
  return restBytes > 0 ? [...named, { key: "rest", label: restLabel(rest.length), bytes: restBytes }] : named;
}

/**
 * A stacked bar of how `total` splits into shares, with a legend that carries
 * the same numbers as text. `capacity`, when larger than the total, leaves the
 * free part of the bar empty.
 */
export function UsageBar({
  label,
  shares,
  restLabel,
  capacity,
}: {
  label: string;
  shares: ReadonlyArray<UsageShare>;
  restLabel: (count: number) => string;
  capacity?: number;
}) {
  const grouped = groupShares(
    shares.filter(({ bytes }) => bytes > 0),
    restLabel,
  );
  const total = grouped.reduce((sum, { bytes }) => sum + bytes, 0);
  const scale = Math.max(total, capacity ?? 0);
  if (!scale) return null;
  const color = (index: number, key: string) => (key === "rest" ? "bg-chart-rest" : SHARE_COLORS[index]);
  return (
    <div className="space-y-2.5">
      <div
        role="img"
        aria-label={`${label}: ${grouped.map((share) => `${share.label} ${formatBytes(share.bytes)}`).join(", ")}`}
        className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-muted"
      >
        {grouped.map((share, index) => (
          <div
            key={share.key}
            className={cn("h-full min-w-0.5", color(index, share.key))}
            style={{ width: `${(share.bytes / scale) * 100}%` }}
          />
        ))}
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0 text-xs">
        {grouped.map((share, index) => (
          <li key={share.key} className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-[3px]", color(index, share.key))} />
            <span className="truncate">{share.label}</span>
            <span className="text-dim tabular-nums">{formatBytes(share.bytes)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StorageOverview({ summary }: { summary: StorageSummary }) {
  const { workspaces } = summary;
  const allotted = workspaces.reduce((sum, { quotaBytes }) => sum + quotaBytes, 0);
  const full = workspaces.filter(({ usedBytes, quotaBytes }) => usedBytes >= quotaBytes).length;
  const percent = allotted ? Math.round((summary.workspaceBytes / allotted) * 100) : 0;
  return (
    <SettingsGroup label="Summary">
      <SettingsCard className="space-y-4 p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-0.5">
            <p className="m-0 text-xl font-semibold tabular-nums">
              {formatBytes(summary.workspaceBytes)}
              {summary.partial ? "+" : ""}{" "}
              <span className="text-sm font-normal text-dim">of {formatBytes(allotted)} allotted</span>
            </p>
            <p className="m-0 text-xs text-dim">
              {workspaces.length} {workspaces.length === 1 ? "workspace" : "workspaces"} · {percent}% of their combined
              sizes · a circle counts once
            </p>
          </div>
          <dl className="m-0 flex gap-5 text-right">
            <div>
              <dt className="text-xs text-dim">Archived</dt>
              <dd className="m-0 text-sm font-medium tabular-nums">{formatBytes(summary.archiveBytes)}</dd>
            </div>
            <div>
              <dt className="text-xs text-dim">Full</dt>
              <dd className={cn("m-0 text-sm font-medium", full ? "text-destructive" : undefined)}>
                {full} {full === 1 ? "workspace" : "workspaces"}
              </dd>
            </div>
          </dl>
        </div>
        {summary.workspaceBytes > 0 ? (
          <UsageBar
            label="Space by workspace"
            shares={workspaces.map(({ conversationId, name, usedBytes }) => ({
              key: conversationId,
              label: name,
              bytes: usedBytes,
            }))}
            restLabel={(count) => `Others (${count})`}
          />
        ) : (
          <p className="m-0 text-xs text-dim">No files in workspaces yet.</p>
        )}
      </SettingsCard>
    </SettingsGroup>
  );
}

type LargestKind = "workspaces" | "folders" | "files";

interface LargestRow {
  key: string;
  name: string;
  context: string;
  size: number;
  action: string;
  target: InspectTarget;
}

function largestRows(summary: StorageSummary, kind: LargestKind): LargestRow[] {
  if (kind === "workspaces") {
    return summary.workspaces.slice(0, LARGEST_SHOWN).map((workspace) => ({
      key: workspace.conversationId,
      name: workspace.name,
      context: `${workspace.kind === "circle" ? "Circle" : "Wisp"} · ${countFiles(workspace.fileCount)}`,
      size: workspace.usedBytes,
      action: "Inspect",
      target: { conversationId: workspace.conversationId },
    }));
  }
  if (kind === "folders") {
    return summary.workspaces
      .flatMap((workspace) =>
        (workspace.folders ?? [])
          .filter(({ type }) => type === "directory")
          .map((folder) => ({
            key: `${workspace.conversationId}/${folder.path}`,
            name: `${folder.path}/`,
            context: `${workspace.name} · ${countFiles(folder.fileCount)}`,
            size: folder.size,
            action: "Open",
            target: { conversationId: workspace.conversationId, path: folder.path },
          })),
      )
      .sort((a, b) => b.size - a.size)
      .slice(0, LARGEST_SHOWN);
  }
  return summary.workspaces
    .flatMap((workspace) =>
      (workspace.largestFiles ?? []).map((file) => {
        const slash = file.path.lastIndexOf("/");
        const folder = slash === -1 ? "" : file.path.slice(0, slash);
        return {
          key: `${workspace.conversationId}/${file.path}`,
          name: file.path.slice(slash + 1),
          context: folder ? `${workspace.name} › ${folder}` : workspace.name,
          size: file.size,
          action: "Show",
          target: { conversationId: workspace.conversationId, path: folder, select: file.path },
        };
      }),
    )
    .sort((a, b) => b.size - a.size)
    .slice(0, LARGEST_SHOWN);
}

const KIND_OPTIONS = [
  { value: "workspaces", label: "Workspaces" },
  { value: "folders", label: "Folders" },
  { value: "files", label: "Files" },
] as const;

export function LargestConsumers({
  summary,
  onInspect,
}: {
  summary: StorageSummary;
  onInspect: (target: InspectTarget) => void;
}) {
  const [kind, setKind] = useState<LargestKind>("workspaces");
  const rows = largestRows(summary, kind);
  // Servers before folder and file details leave them out of every workspace.
  const unsupported = kind !== "workspaces" && summary.workspaces.every((workspace) => !workspace.folders);
  const top = rows[0]?.size ?? 0;
  return (
    <SettingsGroup label="Largest">
      <SegmentedControl label="Largest" value={kind} options={KIND_OPTIONS} onChange={setKind} className="mb-2" />
      {unsupported ? (
        <p className="mx-0.5 text-xs text-dim">
          This server is older than this app and does not report folders and files. Update the server to see them.
        </p>
      ) : rows.length === 0 ? (
        <p className="mx-0.5 text-xs text-dim">Nothing stored yet.</p>
      ) : (
        <SettingsCard variant="stacked">
          <ol className="m-0 list-none p-0">
            {rows.map((row, index) => (
              <li
                key={row.key}
                className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-border px-3.5 py-2.5 not-first:border-t sm:grid-cols-[1.25rem_minmax(0,1fr)_8rem_5rem_auto]"
              >
                <span className="text-xs text-dim tabular-nums">{index + 1}</span>
                <span className="min-w-0">
                  <strong className="block truncate text-sm font-medium">{row.name}</strong>
                  <small className="block truncate text-xs text-dim">{row.context}</small>
                </span>
                <span
                  aria-hidden="true"
                  className="col-start-2 h-1.5 overflow-hidden rounded-full bg-muted sm:col-start-auto"
                >
                  <span className="block h-full bg-chart-2" style={{ width: `${top ? (row.size / top) * 100 : 0}%` }} />
                </span>
                <span className="row-start-1 text-right text-sm font-medium tabular-nums sm:row-start-auto col-start-3 sm:col-start-auto">
                  {formatBytes(row.size)}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="col-start-3 sm:col-start-auto"
                  aria-label={`${row.action} ${row.name} in ${row.context}`}
                  onClick={() => onInspect(row.target)}
                >
                  {row.action}
                </Button>
              </li>
            ))}
          </ol>
        </SettingsCard>
      )}
    </SettingsGroup>
  );
}
