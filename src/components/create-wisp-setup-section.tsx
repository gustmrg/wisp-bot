import type { ExecutionMode, WispSetupView } from "../../shared/execution";
import {
  COMMAND_WORKSPACE_QUOTA_BYTES,
  WORKSPACE_QUOTA_BYTES,
  WORKSPACE_QUOTA_PRESETS,
  formatBytes,
} from "../../shared/workspace";
import {
  SettingsCard,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { unlimitedWorkspaceNote } from "@/components/workspace-size-select";
import { FormStatus } from "@/components/ui/form-status";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

/** What a new Wisp is given besides its profile and model. */
export interface WispSetupDraft {
  /** `null` for no size. */
  quotaBytes: number | null;
  executionMode: ExecutionMode;
}

/** The size select's value for a workspace without a size. */
const UNLIMITED = "unlimited";

export const DEFAULT_WISP_SETUP: WispSetupDraft = { quotaBytes: WORKSPACE_QUOTA_BYTES, executionMode: "off" };

/**
 * Applies the setup to a Wisp that was just created. Resolves with what could
 * not be applied, as a sentence fragment, or an empty string when all of it was.
 */
export async function applyWispSetup(conversationId: string, setup: WispSetupDraft): Promise<string> {
  const failures: string[] = [];
  if (setup.quotaBytes !== DEFAULT_WISP_SETUP.quotaBytes) {
    const result = await window.wisp
      .setWorkspaceQuota({ conversationId, quotaBytes: setup.quotaBytes })
      .catch(() => null);
    if (!result?.ok) failures.push(`its workspace size (${result ? result.error.message : "no answer"})`);
  }
  if (setup.executionMode !== DEFAULT_WISP_SETUP.executionMode) {
    const result = await window.wisp
      .saveWispExecution({ conversationId, mode: setup.executionMode, image: null, localNetwork: false })
      .catch(() => null);
    if (!result?.ok) failures.push(`its commands (${result ? result.error.message : "no answer"})`);
  }
  return failures.join(" and ");
}

interface CreateWispSetupSectionProps {
  view: WispSetupView | null;
  /** Why the view could not be loaded. */
  loadError: string;
  draft: WispSetupDraft;
  onChange: (draft: WispSetupDraft) => void;
}

/** Workspace size and commands: the step that gives a new Wisp somewhere to work. */
export function CreateWispSetupSection({ view, loadError, draft, onChange }: CreateWispSetupSectionProps) {
  if (!view) return <FormStatus pending="Checking the server…" error={loadError} />;
  const sizes = [
    ...WORKSPACE_QUOTA_PRESETS.map((bytes) => ({
      value: String(bytes),
      label: formatBytes(bytes),
      disabled: bytes > view.maxQuotaBytes,
    })),
    { value: UNLIMITED, label: "Unlimited", disabled: false },
  ];
  const commands = draft.executionMode === "container";
  return (
    <SettingsCard>
      <SettingsRow className="min-h-0 p-[11px]">
        <SettingsRowCopy>
          <SettingsRowTitle htmlFor="create-wisp-workspace-size">Workspace size</SettingsRowTitle>
          <SettingsRowDescription>
            A private folder for this Wisp's files and attachments. Larger sizes need free space on the disk.
          </SettingsRowDescription>
        </SettingsRowCopy>
        <Select
          items={sizes}
          value={draft.quotaBytes === null ? UNLIMITED : String(draft.quotaBytes)}
          onValueChange={(value) => {
            if (value) onChange({ ...draft, quotaBytes: value === UNLIMITED ? null : Number(value) });
          }}
        >
          <SelectTrigger id="create-wisp-workspace-size" className="w-[120px] flex-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end" alignItemWithTrigger={false}>
            <SelectGroup>
              {sizes.map((size) => (
                <SelectItem key={size.value} value={size.value} disabled={size.disabled}>
                  {size.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </SettingsRow>
      {draft.quotaBytes === null ? (
        // Creating the Wisp is the confirmation; the note says what it means for the disk first.
        <p role="status" className="m-0 px-3.5 pb-3 text-xs text-warning">
          No size limit. {unlimitedWorkspaceNote()}
        </p>
      ) : null}
      <SettingsRow className="min-h-0 p-[11px]">
        <SettingsRowCopy>
          <SettingsRowTitle>Run commands</SettingsRowTitle>
          <SettingsRowDescription>
            Lets this Wisp run git, builds and tests in its own container on the server. The container sees only this
            Wisp's workspace.
          </SettingsRowDescription>
        </SettingsRowCopy>
        <ToggleSwitch
          checked={commands}
          label="Run commands in a container"
          disabled={!view.runtime.available && !commands}
          onChange={() => onChange({ ...draft, executionMode: commands ? "off" : "container" })}
        />
      </SettingsRow>
      {view.runtime.available ? null : (
        <p role="status" className="m-0 px-3.5 pb-3 text-xs text-dim">
          {view.runtime.message}
        </p>
      )}
      {commands && draft.quotaBytes !== null && draft.quotaBytes < COMMAND_WORKSPACE_QUOTA_BYTES ? (
        <p role="status" className="m-0 px-3.5 pb-3 text-xs text-warning">
          Packages installed by commands count toward the workspace. {formatBytes(COMMAND_WORKSPACE_QUOTA_BYTES)} or
          more is recommended.
        </p>
      ) : null}
      {commands ? (
        <p className="m-0 px-3.5 pb-3 text-xs text-dim">
          The image and local network access can be set later in the Wisp's settings. git uses the GitHub and GitLab
          plugins' tokens once the Wisp has access to them.
        </p>
      ) : null}
    </SettingsCard>
  );
}
