import { readFile, rename } from "node:fs/promises";

import type { ToolPolicyBehavior, ToolPolicyRule, ToolPolicySettings } from "../../shared/tool-policy.js";
import { writeFileAtomically } from "./atomic-file.js";
import { WispBackendError } from "./backend-error.js";

const MAX_RULES = 100;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const BEHAVIORS = new Set<ToolPolicyBehavior>(["allow", "ask", "block"]);

export const DEFAULT_TOOL_POLICY: ToolPolicySettings = {
  autoReview: true,
  rules: [],
};

export class ToolPolicyStore {
  private readonly filePath: string;
  private settings: ToolPolicySettings = DEFAULT_TOOL_POLICY;
  private mutation = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      this.settings = normalizeToolPolicy(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      await rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`).catch(() => undefined);
      this.settings = DEFAULT_TOOL_POLICY;
    }
  }

  get(): ToolPolicySettings {
    return structuredClone(this.settings);
  }

  save(value: unknown): Promise<ToolPolicySettings> {
    const settings = normalizeToolPolicy(value);
    return this.enqueue(async () => {
      await writeFileAtomically(this.filePath, `${JSON.stringify(settings, null, 2)}\n`);
      this.settings = settings;
      return this.get();
    });
  }

  async blockCategory(category: string, createId: () => string): Promise<void> {
    const current = this.get();
    const rules = current.rules.filter((rule) => normalizeRuleAction(rule.action) !== category);
    await this.save({
      ...current,
      rules: [...rules, { id: createId(), action: category, behavior: "block" }],
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function normalizeToolPolicy(value: unknown): ToolPolicySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidPolicy();
  const raw = value as Record<string, unknown>;
  if (typeof raw.autoReview !== "boolean" || !Array.isArray(raw.rules) || raw.rules.length > MAX_RULES) {
    throw invalidPolicy();
  }
  return {
    autoReview: raw.autoReview,
    rules: raw.rules.map(normalizeRule),
  };
}

export function normalizeRuleAction(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
}

function normalizeRule(value: unknown): ToolPolicyRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidPolicy();
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    !ID_PATTERN.test(raw.id) ||
    typeof raw.action !== "string" ||
    !raw.action.trim() ||
    raw.action.length > 240 ||
    typeof raw.behavior !== "string" ||
    !BEHAVIORS.has(raw.behavior as ToolPolicyBehavior)
  ) {
    throw invalidPolicy();
  }
  const behavior = raw.scope === undefined && raw.behavior === "allow" ? "ask" : (raw.behavior as ToolPolicyBehavior);
  if (raw.scope !== undefined && raw.scope !== "workspace") throw invalidPolicy();
  return { id: raw.id, action: raw.action.trim(), behavior, scope: "workspace" };
}

function invalidPolicy(): WispBackendError {
  return new WispBackendError("invalid_request", "The tool policy is invalid.");
}
