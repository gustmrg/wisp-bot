import { DEFAULT_TOOL_POLICY, normalizeRuleAction, normalizeToolPolicy } from "../../backend/tool-policy-store.js";
import type { ToolPolicySettings } from "../../shared/tool-policy.js";
import type { ServerDatabase } from "./database.js";

export class SqliteToolPolicy {
  constructor(private readonly database: ServerDatabase) {}
  get(): ToolPolicySettings {
    const value = this.database.getMeta("toolPolicy");
    return value ? normalizeToolPolicy(JSON.parse(value)) : structuredClone(DEFAULT_TOOL_POLICY);
  }
  saveSync(value: unknown): ToolPolicySettings {
    const normalized = normalizeToolPolicy(value);
    this.database.transaction(() => {
      this.database.setMeta("toolPolicy", JSON.stringify(normalized));
      const revision = Number(this.database.getMeta("settingsRevision") ?? 0) + 1;
      this.database.setMeta("settingsRevision", String(revision));
      this.database.appendEvent("settings_changed", { settingsRevision: revision });
    });
    return normalized;
  }
  async save(value: unknown): Promise<ToolPolicySettings> {
    return this.saveSync(value);
  }
  blockSync(category: string, createId: () => string): void {
    const current = this.get();
    this.saveSync({
      ...current,
      rules: [
        ...current.rules.filter((rule) => normalizeRuleAction(rule.action) !== category),
        { id: createId(), action: category, behavior: "block", scope: "workspace" },
      ],
    });
  }
  async blockCategory(category: string, createId: () => string): Promise<void> {
    this.blockSync(category, createId);
  }
}
