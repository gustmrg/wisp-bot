import { useEffect, useState } from "react";
import { XIcon } from "lucide-react";

import { PreferenceSwitch } from "@/components/general-settings-sections";
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { SettingsPanelTitle } from "@/components/settings/settings-scope";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { AppPreferences, AutoReviewRule, RuleBehavior } from "@/lib/app-preferences";
import { useWispApi } from "@/lib/environment-api";
import {
  withWorkspaceFileBehavior,
  workspaceFileBehavior,
  type ToolPolicySettings,
  type WorkspaceFileCategory,
} from "../../shared/tool-policy";

const RULE_BEHAVIORS: ReadonlyArray<{ value: RuleBehavior; label: string }> = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask" },
  { value: "block", label: "Block" },
];
const FILE_CATEGORIES: ReadonlyArray<{ value: WorkspaceFileCategory; label: string; description: string }> = [
  { value: "create_file", label: "Create files", description: "New files in the workspace." },
  { value: "modify_file", label: "Modify files", description: "Edits to existing workspace files." },
];
const INTEGRATION_ACTION_LABELS: Record<string, string> = {
  external_write: "Changes to integrations",
  integration_call: "MCP tool calls",
};

/**
 * What Wisps can do without asking, as the default for every Wisp; a Wisp's own choices are in its Access tab.
 *
 * For the active environment, `preferences` and `onPreferencesChange` keep the workspace controller in sync.
 * When inspecting another environment (`preferences` omitted), reads and writes its tool policy directly via `useWispApi()`.
 */
export function PermissionSettingsSection({
  preferences,
  onPreferencesChange,
}: {
  preferences?: AppPreferences;
  onPreferencesChange?: (preferences: AppPreferences) => void;
}) {
  const api = useWispApi();
  const useScopedPolicy = !preferences || !onPreferencesChange;
  const [remotePolicy, setRemotePolicy] = useState<ToolPolicySettings | null>(null);
  const [loading, setLoading] = useState(useScopedPolicy);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [ruleNotice, setRuleNotice] = useState("");

  useEffect(() => {
    if (!useScopedPolicy) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void api
      .getToolPolicy()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setRemotePolicy(result.value);
        else setError(result.error.message);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setError("Could not load permissions.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, useScopedPolicy]);

  async function saveScopedPolicy(next: ToolPolicySettings): Promise<boolean> {
    setSaving(true);
    setError("");
    try {
      const result = await api.saveToolPolicy(next);
      if (result.ok) {
        setRemotePolicy(result.value);
        return true;
      }
      setError(result.error.message);
      return false;
    } catch {
      setError("Could not save permissions.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  const autoReview = useScopedPolicy ? (remotePolicy?.autoReview ?? true) : preferences.autoReview;
  const autoReviewRules: ReadonlyArray<AutoReviewRule> = useScopedPolicy
    ? ((remotePolicy?.rules ?? []) as AutoReviewRule[])
    : preferences.autoReviewRules;
  const integrationRules = autoReviewRules.filter((rule) => rule.scope === "integration");

  function setAutoReview(enabled: boolean) {
    if (useScopedPolicy) {
      void saveScopedPolicy({ autoReview: enabled, rules: [...autoReviewRules] });
      return;
    }
    onPreferencesChange({ ...preferences, autoReview: enabled });
  }

  function setFileBehavior(category: WorkspaceFileCategory, behavior: RuleBehavior) {
    const nextRules = withWorkspaceFileBehavior(autoReviewRules, category, behavior, () =>
      crypto.randomUUID(),
    ) as AutoReviewRule[];
    if (useScopedPolicy) {
      void saveScopedPolicy({ autoReview, rules: nextRules });
    } else {
      onPreferencesChange({ ...preferences, autoReviewRules: nextRules });
    }
    const label = FILE_CATEGORIES.find(({ value }) => value === category)?.label ?? category;
    const behaviorLabel = RULE_BEHAVIORS.find(({ value }) => value === behavior)?.label ?? behavior;
    setRuleNotice(`${label}: ${behaviorLabel}.`);
  }

  function removeRule(ruleId: string) {
    const nextRules = autoReviewRules.filter((item) => item.id !== ruleId);
    if (useScopedPolicy) {
      void saveScopedPolicy({ autoReview, rules: nextRules });
    } else {
      onPreferencesChange({ ...preferences, autoReviewRules: nextRules });
    }
    setRuleNotice("Rule removed.");
  }

  return (
    <section
      className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5 [&>*]:max-w-[760px]"
      id="permission-settings-panel"
      aria-labelledby="permission-settings-title"
    >
      <SettingsPanelTitle id="permission-settings-title" scope="environment">
        Permissions
      </SettingsPanelTitle>
      <p className="mb-4 text-xs leading-relaxed text-dim">
        What Wisps can do without asking. A Wisp's Access tab can override this.
      </p>
      {loading ? (
        <p role="status" className="text-sm text-dim">
          Loading permissions…
        </p>
      ) : useScopedPolicy && !remotePolicy && error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        <div className="animate-panel-in">
          <SettingsGroup label="File changes">
            <SettingsCard variant="stacked">
              <SettingsRow>
                <SettingsRowCopy>
                  <SettingsRowTitle>Auto-review file changes</SettingsRowTitle>
                  <SettingsRowDescription>
                    {autoReview
                      ? "Wisp follows the rules below before changing workspace files."
                      : "Wisp asks before every file change. Turn on to use the rules below."}
                  </SettingsRowDescription>
                </SettingsRowCopy>
                <PreferenceSwitch
                  label="Auto-review file changes"
                  checked={autoReview}
                  disabled={saving}
                  onChange={() => setAutoReview(!autoReview)}
                />
              </SettingsRow>
              {FILE_CATEGORIES.map((category) => (
                <SettingsRow key={category.value} aria-disabled={!autoReview || undefined}>
                  <SettingsRowCopy className={autoReview ? undefined : "opacity-50"}>
                    <SettingsRowTitle>{category.label}</SettingsRowTitle>
                    <SettingsRowDescription>{category.description}</SettingsRowDescription>
                  </SettingsRowCopy>
                  <SegmentedControl
                    label={`When Wisp wants to ${category.label.toLocaleLowerCase()}`}
                    value={workspaceFileBehavior(autoReviewRules, category.value)}
                    options={RULE_BEHAVIORS}
                    disabled={!autoReview || saving}
                    onChange={(behavior) => setFileBehavior(category.value, behavior)}
                  />
                </SettingsRow>
              ))}
              {integrationRules.length ? (
                <SettingsRow className="flex-col items-stretch gap-[5px]">
                  <SettingsRowTitle>Integration blocks</SettingsRowTitle>
                  <SettingsRowDescription>
                    Changes to integrations always ask first. Actions you block from an approval prompt are listed here.
                  </SettingsRowDescription>
                  <ul className="m-0 mt-[3px] flex list-none flex-col p-0" aria-label="Integration blocks">
                    {integrationRules.map((rule) => (
                      <li key={rule.id} className="flex items-center gap-3 border-t border-border py-2">
                        <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
                          {INTEGRATION_ACTION_LABELS[rule.action] ?? rule.action}
                          <span className="mt-0.5 block text-xs text-dim">
                            {RULE_BEHAVIORS.find((behavior) => behavior.value === rule.behavior)?.label}
                          </span>
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={saving}
                          aria-label={`Remove rule: ${INTEGRATION_ACTION_LABELS[rule.action] ?? rule.action}`}
                          onClick={() => removeRule(rule.id)}
                        >
                          <XIcon aria-hidden="true" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                </SettingsRow>
              ) : null}
            </SettingsCard>
            {error ? (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <span className="sr-only" role="status">
              {ruleNotice}
            </span>
          </SettingsGroup>
        </div>
      )}
    </section>
  );
}
