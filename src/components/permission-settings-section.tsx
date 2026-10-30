import { useState } from "react";
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
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { AppPreferences, AutoReviewRule, RuleBehavior } from "@/lib/app-preferences";
import { withWorkspaceFileBehavior, workspaceFileBehavior, type WorkspaceFileCategory } from "../../shared/tool-policy";

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

/** What Wisps can do without asking, as the default for every Wisp; a Wisp's own choices are in its Access tab. */
export function PermissionSettingsSection({
  preferences,
  onPreferencesChange,
}: {
  preferences: AppPreferences;
  onPreferencesChange: (preferences: AppPreferences) => void;
}) {
  const [ruleNotice, setRuleNotice] = useState("");
  const integrationRules = preferences.autoReviewRules.filter((rule) => rule.scope === "integration");

  function setFileBehavior(category: WorkspaceFileCategory, behavior: RuleBehavior) {
    onPreferencesChange({
      ...preferences,
      autoReviewRules: withWorkspaceFileBehavior(preferences.autoReviewRules, category, behavior, () =>
        crypto.randomUUID(),
      ) as AutoReviewRule[],
    });
    const label = FILE_CATEGORIES.find(({ value }) => value === category)?.label ?? category;
    const behaviorLabel = RULE_BEHAVIORS.find(({ value }) => value === behavior)?.label ?? behavior;
    setRuleNotice(`${label}: ${behaviorLabel}.`);
  }

  return (
    <section
      className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5 [&>*]:max-w-[760px]"
      id="permission-settings-panel"
      aria-labelledby="permission-settings-title"
    >
      <h2 id="permission-settings-title" className="mb-1 mt-0 text-lg font-semibold">
        Permissions
      </h2>
      <p className="mb-4 text-xs leading-relaxed text-dim">
        What Wisps can do without asking. These are the defaults for every Wisp, and a Wisp's Access tab can change them
        for that Wisp.
      </p>
      <div className="animate-tab-forward">
        <SettingsGroup label="File changes">
          <SettingsCard variant="stacked">
            <SettingsRow>
              <SettingsRowCopy>
                <SettingsRowTitle>Auto-review file changes</SettingsRowTitle>
                <SettingsRowDescription>
                  {preferences.autoReview
                    ? "Wisp follows the rules below before changing workspace files."
                    : "Wisp asks before every file change. Turn on to use the rules below."}
                </SettingsRowDescription>
              </SettingsRowCopy>
              <PreferenceSwitch
                label="Auto-review file changes"
                checked={preferences.autoReview}
                onChange={() => onPreferencesChange({ ...preferences, autoReview: !preferences.autoReview })}
              />
            </SettingsRow>
            {FILE_CATEGORIES.map((category) => (
              <SettingsRow key={category.value} aria-disabled={!preferences.autoReview || undefined}>
                <SettingsRowCopy className={preferences.autoReview ? undefined : "opacity-50"}>
                  <SettingsRowTitle>{category.label}</SettingsRowTitle>
                  <SettingsRowDescription>{category.description}</SettingsRowDescription>
                </SettingsRowCopy>
                <SegmentedControl
                  label={`When Wisp wants to ${category.label.toLocaleLowerCase()}`}
                  value={workspaceFileBehavior(preferences.autoReviewRules, category.value)}
                  options={RULE_BEHAVIORS}
                  disabled={!preferences.autoReview}
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
                        aria-label={`Remove rule: ${INTEGRATION_ACTION_LABELS[rule.action] ?? rule.action}`}
                        onClick={() => {
                          onPreferencesChange({
                            ...preferences,
                            autoReviewRules: preferences.autoReviewRules.filter((item) => item.id !== rule.id),
                          });
                          setRuleNotice("Rule removed.");
                        }}
                      >
                        <XIcon aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </SettingsRow>
            ) : null}
          </SettingsCard>
          <p className="mx-0.5 mt-[7px] text-dim text-xs leading-[1.45]">
            Rules are enforced in the desktop backend before the Wisp can create or modify a file. Shell execution
            remains blocked.
          </p>
          <span className="sr-only" role="status">
            {ruleNotice}
          </span>
        </SettingsGroup>
      </div>
    </section>
  );
}
