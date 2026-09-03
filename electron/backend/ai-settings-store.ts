import { readFile } from "node:fs/promises";

import type { ModelSelection } from "../../shared/contracts.js";
import { writeFileAtomically } from "./atomic-file.js";

interface SettingsFile {
  schemaVersion: 1;
  selection: ModelSelection | null;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeSelection(value: unknown): ModelSelection | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ModelSelection>;
  if (!isId(candidate.providerId) || !isId(candidate.modelId)) return null;
  const maxOutputTokens = candidate.maxOutputTokens;
  if (
    maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 1_000_000)
  ) {
    return null;
  }
  return {
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

export class AiSettingsStore {
  private readonly filePath: string;
  private selection: ModelSelection | null = null;
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async getSelection(): Promise<ModelSelection | null> {
    await this.load();
    return this.selection ? { ...this.selection } : null;
  }

  async setSelection(selection: ModelSelection | null): Promise<void> {
    await this.load();
    this.selection = selection ? { ...selection } : null;
    const file: SettingsFile = { schemaVersion: 1, selection: this.selection };
    await writeFileAtomically(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<SettingsFile>;
      this.selection = parsed.schemaVersion === 1 ? normalizeSelection(parsed.selection) : null;
      this.loaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.loaded = true;
    }
  }
}
