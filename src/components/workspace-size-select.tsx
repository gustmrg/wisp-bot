import { useState } from "react";

import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  WORKSPACE_DISK_RESERVE_BYTES,
  WORKSPACE_QUOTA_PRESETS,
  formatBytes,
  type WorkspaceView,
} from "../../shared/workspace";

/** Shown when the server predates resizing workspaces. */
const UNSUPPORTED = "This server is older than this app and cannot resize workspaces. Update the server to change it.";
/** The select's value for a workspace without a size. */
const UNLIMITED = "unlimited";

/** What a workspace without a size means for its disk, as the person is told before choosing it. */
export function unlimitedWorkspaceNote(freeDiskBytes?: number): string {
  return `It can grow until its disk has ${formatBytes(WORKSPACE_DISK_RESERVE_BYTES)} left${
    freeDiskBytes === undefined ? "" : ` (${formatBytes(freeDiskBytes)} free now)`
  }, which Wisp keeps for conversations and settings. Then attachments, uploads, the Wisp's own writes and commands stop until space is freed.`;
}

/**
 * Picks a Wisp's workspace size from the offered ones, or none. A size below
 * what the workspace holds, and no size at all, are applied only after the
 * person confirms them.
 */
export function WorkspaceSizeSelect({
  id,
  conversationId,
  name,
  usedBytes,
  quotaBytes,
  maxQuotaBytes,
  unlimited,
  freeDiskBytes,
  className,
  onResized,
}: {
  id?: string;
  conversationId: string;
  /** Names the workspace for screen readers when no visible label points at `id`. */
  name?: string;
  usedBytes: number;
  quotaBytes: number;
  /** Sizes above it are offered disabled; unknown, every size is offered and the server decides. */
  maxQuotaBytes?: number;
  /** The workspace has no size. Unknown, the server predates that and none is offered. */
  unlimited?: boolean;
  freeDiskBytes?: number;
  className?: string;
  onResized: (view: WorkspaceView) => void;
}) {
  // Undefined while nothing waits for confirmation; `quotaBytes: null` is no size.
  const [pending, setPending] = useState<{ quotaBytes: number | null }>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const current = unlimited ? null : quotaBytes;
  // A size saved outside the offered ones is still shown as the current choice.
  const sizes = [
    ...[...new Set([...WORKSPACE_QUOTA_PRESETS, ...(current === null ? [] : [current])])]
      .sort((a, b) => a - b)
      .map((bytes) => ({
        value: String(bytes),
        label: formatBytes(bytes),
        disabled: maxQuotaBytes !== undefined && bytes > maxQuotaBytes && bytes !== current,
      })),
    ...(unlimited === undefined ? [] : [{ value: UNLIMITED, label: "Unlimited", disabled: false }]),
  ];

  async function resize(bytes: number | null) {
    setPending(undefined);
    setError("");
    setSaving(true);
    try {
      const result = await window.wisp.setWorkspaceQuota({ conversationId, quotaBytes: bytes });
      if (result.ok) onResized(result.value);
      else setError(result.error.code === "unsupported" ? UNSUPPORTED : result.error.message);
    } catch {
      setError("Could not change the workspace size.");
    } finally {
      setSaving(false);
    }
  }

  return (
    // Flex gap, not space-y: the select's hidden form input follows the trigger and would add a margin below it.
    <div className="flex flex-col gap-2">
      <Select
        items={sizes}
        value={current === null ? UNLIMITED : String(current)}
        disabled={saving}
        onValueChange={(value) => {
          if (!value) return;
          const bytes = value === UNLIMITED ? null : Number(value);
          if (bytes === current) return;
          setError("");
          if (bytes === null || bytes < usedBytes) setPending({ quotaBytes: bytes });
          else void resize(bytes);
        }}
      >
        <SelectTrigger id={id} aria-label={name ? `Workspace size for ${name}` : undefined} className={className}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {sizes.map((size) => (
            <SelectItem key={size.value} value={size.value} disabled={size.disabled}>
              {size.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {pending ? (
        <div
          role="alert"
          className="space-y-2.5 rounded-[10px] border border-warning-solid/40 bg-warning-solid/10 p-3 text-xs leading-relaxed"
        >
          {pending.quotaBytes === null ? (
            <p className="m-0">
              <strong className="font-medium">No size limit.</strong> {unlimitedWorkspaceNote(freeDiskBytes)}
            </p>
          ) : (
            <p className="m-0">
              <strong className="font-medium">Smaller than what it holds ({formatBytes(usedBytes)}).</strong> Nothing is
              deleted, but attachments, uploads and the Wisp&apos;s own writes fail until about{" "}
              {formatBytes(usedBytes - pending.quotaBytes)} is freed.
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPending(undefined)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void resize(pending.quotaBytes)}>
              {pending.quotaBytes === null ? "Remove the limit" : `Set to ${formatBytes(pending.quotaBytes)} anyway`}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}
