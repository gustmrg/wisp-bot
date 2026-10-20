import { readFileSync } from "node:fs";
import path from "node:path";

import type { ToolPolicyBehavior, WispToolPolicy, WorkspaceFileCategory } from "../shared/tool-policy.js";
import { writeFileAtomically } from "./atomic-file.js";

/** A Wisp's own permissions, in its config folder next to its other settings (ADR 023). */
export const WISP_TOOL_POLICY_FILE = "tool-policy.json";

const BEHAVIORS: ReadonlyArray<ToolPolicyBehavior> = ["allow", "ask", "block"];
const FILE_CATEGORIES: ReadonlyArray<WorkspaceFileCategory> = ["create_file", "modify_file"];

export function defaultWispToolPolicy(): WispToolPolicy {
  return { files: {}, allowEverything: false };
}

/**
 * Reads and writes each Wisp's permissions. Checks are synchronous, so an
 * approval card is published in the same tick as the action that needs it:
 * the small file is read once per folder and kept, and only this process
 * writes it. A missing or damaged file means the Wisp has no permissions of
 * its own: it asks, as the app-wide policy says.
 */
export class WispToolPolicyStore {
  private mutation = Promise.resolve();
  private readonly cache = new Map<string, WispToolPolicy>();

  constructor(private readonly resolveConfigDirectory: (wispId: string) => string) {}

  get(wispId: string): WispToolPolicy {
    const filePath = this.filePath(wispId);
    const cached = this.cache.get(filePath);
    if (cached) return structuredClone(cached);
    let policy = defaultWispToolPolicy();
    try {
      policy = normalizeWispToolPolicy(JSON.parse(readFileSync(filePath, "utf8")));
    } catch {
      // Missing or damaged: the Wisp has no permissions of its own.
    }
    this.cache.set(filePath, policy);
    return structuredClone(policy);
  }

  save(wispId: string, policy: WispToolPolicy): Promise<WispToolPolicy> {
    return this.enqueue(async () => {
      const normalized = normalizeWispToolPolicy(policy);
      await this.write(wispId, normalized);
      return normalized;
    });
  }

  /** Sets how one kind of file change is handled for this Wisp, keeping everything else. */
  setFileBehavior(
    wispId: string,
    category: WorkspaceFileCategory,
    behavior: ToolPolicyBehavior,
  ): Promise<WispToolPolicy> {
    return this.enqueue(async () => {
      const current = this.get(wispId);
      const next = { ...current, files: { ...current.files, [category]: behavior } };
      await this.write(wispId, next);
      return next;
    });
  }

  private filePath(wispId: string): string {
    return path.join(this.resolveConfigDirectory(wispId), WISP_TOOL_POLICY_FILE);
  }

  private async write(wispId: string, policy: WispToolPolicy): Promise<void> {
    const filePath = this.filePath(wispId);
    await writeFileAtomically(filePath, `${JSON.stringify(policy)}\n`);
    this.cache.set(filePath, structuredClone(policy));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation);
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Keeps only known fields with valid values; anything else is dropped. */
export function normalizeWispToolPolicy(value: unknown): WispToolPolicy {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const files = typeof raw.files === "object" && raw.files !== null ? (raw.files as Record<string, unknown>) : {};
  const policy = defaultWispToolPolicy();
  for (const category of FILE_CATEGORIES) {
    const behavior = files[category];
    if (typeof behavior === "string" && (BEHAVIORS as ReadonlyArray<string>).includes(behavior)) {
      policy.files[category] = behavior as ToolPolicyBehavior;
    }
  }
  policy.allowEverything = raw.allowEverything === true;
  return policy;
}
