import { useCallback, useEffect, useId, useState } from "react";
import { DownloadIcon, PencilIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";

import {
  MAX_MEMORY_TEXT_LENGTH,
  type MemoryEntryView,
  type MemoryExport,
  type MemoryOperationRequest,
  type MemoryScope,
  type MemoryView,
} from "../../shared/memory";
import {
  SettingsActions,
  SettingsCard,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { FieldDescription, FieldGroup, FieldTitle } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { describeMemoryTextEdit, planMemoryTextEdit, type MemoryTextEdit } from "@/lib/memory-text-edit";
import { cn } from "@/lib/utils";

const SCOPES: Record<MemoryScope, { title: string; description: string; file: string }> = {
  user: {
    title: "About you",
    description:
      "Facts and preferences every Wisp knows about you. Add them here, or ask any Wisp to remember something.",
    file: "USER.md",
  },
  wisp: { title: "This Wisp", description: "What only this Wisp remembers.", file: "MEMORY.md" },
};

type Apply = (operations: MemoryOperationRequest[]) => Promise<boolean>;

/**
 * Loads and changes memory: a Wisp's own with its `conversationId`, or without one the
 * person's, which every Wisp shares (ADR 029).
 */
function useMemory(conversationId: string | undefined) {
  const [view, setView] = useState<MemoryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const owner = conversationId === undefined ? {} : { conversationId };

  const load = useCallback(async () => {
    try {
      const result = await window.wisp.getMemory(conversationId === undefined ? {} : { conversationId });
      if (result.ok) {
        setView(result.value);
        setError("");
      } else setError(result.error.message);
    } catch {
      setError("Could not load memory.");
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
    // A memory a Wisp just saved shows up without reopening settings. Any Wisp may save about the person.
    return window.wisp.subscribeToAgentEvents((event) => {
      if (
        (conversationId === undefined || event.conversationId === conversationId) &&
        event.type === "turn_item" &&
        event.item.toolName === "save_memory" &&
        event.item.status === "completed"
      ) {
        void load();
      }
    });
  }, [conversationId, load]);

  const apply: Apply = async (operations) => {
    setBusy(true);
    setError("");
    try {
      const result = await window.wisp.applyMemory({ ...owner, operations });
      if (!result.ok) {
        setError(result.error.message);
        return false;
      }
      setView(result.value);
      return true;
    } catch {
      setError("Could not update memory. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  async function exportScope(scope: MemoryScope) {
    setError("");
    try {
      const result = await window.wisp.exportMemory({ ...owner, scope });
      if (result.ok) download(result.value);
      else setError(result.error.message);
    } catch {
      setError("Could not export memory.");
    }
  }

  return { view, busy, error, setError, load, apply, exportScope };
}

type MemoryController = ReturnType<typeof useMemory>;

/** One scope's entries, with the load and save outcome below them. */
function MemoryScopePanel({ scope, memory }: { scope: MemoryScope; memory: MemoryController }) {
  const { view, busy, error, load, apply, exportScope } = memory;
  return (
    <>
      {view === null && !error ? <FormStatus pending="Loading memory…" /> : null}
      {view ? (
        <ScopeSection scope={scope} view={view} busy={busy} apply={apply} onExport={() => void exportScope(scope)} />
      ) : null}
      <FormStatus error={error} />
      {view === null && error ? (
        <SettingsActions>
          <Button variant="ghost" onClick={() => void load()}>
            <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
            Retry
          </Button>
        </SettingsActions>
      ) : null}
    </>
  );
}

/** What every Wisp knows about the person, in Settings → General (ADR 029). */
export function UserMemorySettings() {
  const memory = useMemory(undefined);
  return (
    <FieldGroup className="gap-2">
      <MemoryScopePanel scope="user" memory={memory} />
    </FieldGroup>
  );
}

interface WispMemorySettingsProps {
  conversationId: string;
  /** Whether the Wisp runs without memory (SWE-228). */
  memoryOff: boolean;
  /** Saves the switch; false when it could not be saved. */
  onChangeMemoryOff: (memoryOff: boolean) => Promise<boolean> | void;
  /** Opens Settings → General, where the person's own memory is kept. */
  onOpenAboutYou?: () => void;
}

/** The memory part of a Wisp's Memory settings (ADR 029). */
export function WispMemorySettings(props: WispMemorySettingsProps) {
  return <MemoryPanel key={props.conversationId} {...props} />;
}

function MemoryPanel({ conversationId, memoryOff, onChangeMemoryOff, onOpenAboutYou }: WispMemorySettingsProps) {
  const memory = useMemory(conversationId);
  const [switching, setSwitching] = useState(false);

  async function toggleMemory() {
    setSwitching(true);
    memory.setError("");
    try {
      if ((await onChangeMemoryOff(!memoryOff)) === false)
        memory.setError("Could not change memory. Please try again.");
    } catch {
      memory.setError("Could not change memory. Please try again.");
    } finally {
      setSwitching(false);
    }
  }

  return (
    <FieldGroup className="gap-5">
      <FieldDescription>
        Facts, preferences, and context this Wisp keeps across conversations and new topics. Ask it to remember
        something and approve the change, or add it here. Memory is stored on this device and included in model
        requests.
      </FieldDescription>
      <SettingsCard>
        <SettingsRow className="min-h-0 p-[11px]">
          <SettingsRowCopy>
            <SettingsRowTitle>Use memory</SettingsRowTitle>
            <SettingsRowDescription>
              {memoryOff
                ? "Off: this Wisp doesn't read or save memory, in conversations or jobs. Every entry is kept for when you turn it back on."
                : "This Wisp reads its own memory and what every Wisp knows about you, and can save to them when you ask."}
            </SettingsRowDescription>
          </SettingsRowCopy>
          <ToggleSwitch
            checked={!memoryOff}
            label="Use memory"
            disabled={switching}
            onChange={() => void toggleMemory()}
          />
        </SettingsRow>
      </SettingsCard>
      <MemoryScopePanel scope="wisp" memory={memory} />
      <SettingsCard>
        <SettingsRow className="min-h-0 p-[11px]">
          <SettingsRowCopy>
            <SettingsRowTitle>About you</SettingsRowTitle>
            <SettingsRowDescription>
              What every Wisp knows about you is kept in Settings → General.
            </SettingsRowDescription>
          </SettingsRowCopy>
          {onOpenAboutYou ? (
            <Button variant="outline" size="sm" aria-label="Open About you" onClick={onOpenAboutYou}>
              Open
            </Button>
          ) : null}
        </SettingsRow>
      </SettingsCard>
    </FieldGroup>
  );
}

function ScopeSection({
  scope,
  view,
  busy,
  apply,
  onExport,
}: {
  scope: MemoryScope;
  view: MemoryView;
  busy: boolean;
  apply: Apply;
  onExport: () => void;
}) {
  const titleId = useId();
  const { title, description, file } = SCOPES[scope];
  const entries = view.entries.filter((entry) => entry.scope === scope);
  const active = entries.filter((entry) => entry.status === "active");
  const inactive = entries.filter((entry) => entry.status !== "active");
  const usage = view.usage.find((item) => item.scope === scope);
  const over = usage ? usage.used > usage.limit : false;
  const [adding, setAdding] = useState("");
  const [textDraft, setTextDraft] = useState<string | null>(null);

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <FieldTitle id={titleId} className="text-sm font-medium text-foreground">
          {title}
        </FieldTitle>
        {usage ? (
          <span className={cn("text-xs text-dim", over && "text-destructive")}>
            {usage.used.toLocaleString()} / {usage.limit.toLocaleString()} characters
          </span>
        ) : null}
      </div>
      <FieldDescription>{description}</FieldDescription>
      {over ? (
        <p className="m-0 text-xs text-destructive">Over the limit. Remove or shorten entries to add more.</p>
      ) : null}
      {textDraft === null ? (
        <>
          {active.length === 0 ? (
            <p className="m-0 text-xs text-dim">Nothing saved yet.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label={`${title} entries`}>
              {active.map((entry) => (
                <EntryRow key={entry.id} entry={entry} busy={busy} apply={apply} />
              ))}
            </ul>
          )}
          <form
            className="flex gap-2"
            onSubmit={async (event) => {
              event.preventDefault();
              if (await apply([{ op: "add", scope, text: adding }])) setAdding("");
            }}
          >
            <Input
              aria-label={`New entry for ${title}`}
              placeholder={scope === "user" ? "For example: Prefers short, direct answers." : "Something to remember"}
              maxLength={MAX_MEMORY_TEXT_LENGTH}
              value={adding}
              onChange={(event) => setAdding(event.target.value)}
            />
            <Button type="submit" variant="outline" disabled={busy || !adding.trim()}>
              Add
            </Button>
          </form>
        </>
      ) : (
        <TextEditor
          scope={scope}
          title={title}
          active={active}
          busy={busy}
          apply={apply}
          draft={textDraft}
          onDraft={setTextDraft}
          onClose={() => setTextDraft(null)}
        />
      )}
      <SettingsActions>
        {textDraft === null ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setTextDraft(active.map((entry) => entry.text).join("\n"))}
          >
            Edit as text
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" disabled={active.length === 0} onClick={onExport}>
          <DownloadIcon data-icon="inline-start" aria-hidden="true" />
          Export {file}
        </Button>
      </SettingsActions>
      {inactive.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-dim">Removed and replaced ({inactive.length})</summary>
          <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0" aria-label={`${title} removed and replaced`}>
            {inactive.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start justify-between gap-2 rounded-[10px] border border-border p-2.5"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="m-0 break-words text-dim">{entry.text}</p>
                  <EntryMeta entry={entry} />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void apply([{ op: "restore", id: entry.id }])}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function EntryRow({ entry, busy, apply }: { entry: MemoryEntryView; busy: boolean; apply: Apply }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (editing !== null) {
    return (
      <li className="rounded-[10px] border border-border p-2.5">
        <form
          className="flex flex-col gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await apply([{ op: "patch", id: entry.id, text: editing }])) setEditing(null);
          }}
        >
          <Input
            aria-label="Entry text"
            autoFocus
            maxLength={MAX_MEMORY_TEXT_LENGTH}
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || !editing.trim() || editing.trim() === entry.text}>
              Save
            </Button>
          </div>
        </form>
      </li>
    );
  }
  return (
    <li className="flex items-start justify-between gap-2 rounded-[10px] border border-border p-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="m-0 break-words">{entry.text}</p>
        <EntryMeta entry={entry} />
      </div>
      <div className="flex shrink-0 gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit ${entry.text}`}
          disabled={busy}
          onClick={() => setEditing(entry.text)}
        >
          <PencilIcon aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${entry.text}`}
          disabled={busy}
          onClick={() => void apply([{ op: "remove", id: entry.id }])}
        >
          <Trash2Icon aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

function EntryMeta({ entry }: { entry: MemoryEntryView }) {
  const parts = [
    entry.source === "owner" ? "You" : "Wisp",
    formatDate(entry.createdAt),
    ...(entry.expiresAt
      ? [new Date(entry.expiresAt) <= new Date() ? "Expired" : `Until ${formatDate(entry.expiresAt)}`]
      : []),
    ...(entry.status === "superseded" ? ["Replaced"] : entry.status === "removed" ? ["Removed"] : []),
  ];
  return <span className="text-xs text-dim">{parts.join(" · ")}</span>;
}

function TextEditor({
  scope,
  title,
  active,
  busy,
  apply,
  draft,
  onDraft,
  onClose,
}: {
  scope: MemoryScope;
  title: string;
  active: ReadonlyArray<MemoryEntryView>;
  busy: boolean;
  apply: Apply;
  draft: string;
  onDraft: (draft: string) => void;
  onClose: () => void;
}) {
  const [plan, setPlan] = useState<MemoryTextEdit | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label={`${title} as text`}
        rows={Math.min(Math.max(active.length + 2, 4), 14)}
        value={draft}
        readOnly={plan !== null}
        onChange={(event) => onDraft(event.target.value)}
      />
      <FieldDescription>One entry per line. Lines you leave as they are keep their history.</FieldDescription>
      {plan === null ? (
        <SettingsActions align="end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => setPlan(planMemoryTextEdit(scope, active, draft))}>Review changes</Button>
        </SettingsActions>
      ) : (
        <div className="flex flex-col gap-2 rounded-[10px] border border-border p-3">
          <p role="status" className="m-0 text-xs">
            {describeMemoryTextEdit(plan)}
          </p>
          <SettingsActions align="end">
            <Button variant="ghost" onClick={() => setPlan(null)}>
              Back
            </Button>
            <Button
              disabled={busy || plan.operations.length === 0}
              onClick={async () => {
                if (await apply(plan.operations)) onClose();
                else setPlan(null);
              }}
            >
              Save changes
            </Button>
          </SettingsActions>
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** Saves a file through the browser's download, which works the same in the app and on the web. */
function download({ fileName, markdown }: MemoryExport) {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
