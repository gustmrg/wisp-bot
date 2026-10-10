import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WORKSPACE_QUOTA_PRESETS, formatBytes, type WorkspaceView } from "../../shared/workspace";

/** Shown when the server predates resizing workspaces. */
const UNSUPPORTED = "This server is older than this app and cannot resize workspaces. Update the server to change it.";

/**
 * Picks a Wisp's workspace size from the offered ones. A size below what the
 * workspace holds is applied only after the person confirms it.
 */
export function WorkspaceSizeSelect({
  id,
  conversationId,
  name,
  usedBytes,
  quotaBytes,
  maxQuotaBytes,
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
  className?: string;
  onResized: (view: WorkspaceView) => void;
}) {
  const [pending, setPending] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // A size saved outside the offered ones is still shown as the current choice.
  const sizes = [...new Set([...WORKSPACE_QUOTA_PRESETS, quotaBytes])]
    .sort((a, b) => a - b)
    .map((bytes) => ({
      value: String(bytes),
      label: formatBytes(bytes),
      disabled: maxQuotaBytes !== undefined && bytes > maxQuotaBytes && bytes !== quotaBytes,
    }));

  async function resize(bytes: number) {
    setPending(null);
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
    <div className="space-y-2">
      <Select
        items={sizes}
        value={String(quotaBytes)}
        disabled={saving}
        onValueChange={(value) => {
          const bytes = Number(value);
          if (!value || bytes === quotaBytes) return;
          setError("");
          if (bytes < usedBytes) setPending(bytes);
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
      {pending !== null ? (
        <div
          role="alert"
          className="space-y-2.5 rounded-[10px] border border-warning-solid/40 bg-warning-solid/10 p-3 text-xs leading-relaxed"
        >
          <p className="m-0">
            <strong className="font-medium">Smaller than what it holds ({formatBytes(usedBytes)}).</strong> Nothing is
            deleted, but attachments, uploads and the Wisp&apos;s own writes fail until about{" "}
            {formatBytes(usedBytes - pending)} is freed.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void resize(pending)}>
              Set to {formatBytes(pending)} anyway
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
