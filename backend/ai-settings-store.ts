import { readFile } from "node:fs/promises";

import {
  isThinkingLevel,
  type AuxiliaryModelSelections,
  type AuxiliaryTask,
  type ModelSelection,
  type WispFallback,
} from "../shared/contracts.js";
import { writeFileAtomically } from "./atomic-file.js";

/**
 * Version 1 gained `auxiliary` and `fallback` as optional fields rather than a
 * new version: earlier releases discard files whose version they do not know,
 * which would lose the main selection after a downgrade.
 */
interface SettingsFile {
  schemaVersion: 1;
  selection: ModelSelection | null;
  auxiliary?: AuxiliaryModelSelections;
  fallback?: ModelSelection;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function normalizeSelection(value: unknown): ModelSelection | null {
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
  const thinkingLevel = candidate.thinkingLevel;
  if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) return null;
  return {
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    // "off" is the default, so it is never stored.
    ...(thinkingLevel === undefined || thinkingLevel === "off" ? {} : { thinkingLevel }),
  };
}

/** A selection reduced to its provider and model, or null when it is invalid. */
export function normalizeModelChoice(value: unknown): ModelSelection | null {
  const selection = normalizeSelection(value);
  return selection ? { providerId: selection.providerId, modelId: selection.modelId } : null;
}

/** A saved fallback choice, or undefined when it is missing or invalid: the Wisp then follows its model. */
export function normalizeWispFallback(value: unknown): WispFallback | undefined {
  if (value === "off" || value === "global") return value;
  return normalizeModelChoice(value) ?? undefined;
}

/**
 * An auxiliary selection names a provider and model only; its output limit is
 * fixed by its task, and it never reasons: its tasks are short.
 */
function normalizeAuxiliary(value: unknown): AuxiliaryModelSelections {
  const record = value && typeof value === "object" ? (value as Partial<Record<AuxiliaryTask, unknown>>) : {};
  return { imageUnderstanding: normalizeModelChoice(record.imageUnderstanding) };
}

export class AiSettingsStore {
  private readonly filePath: string;
  private selection: ModelSelection | null = null;
  private auxiliary: AuxiliaryModelSelections = normalizeAuxiliary(undefined);
  private fallback: ModelSelection | null = null;
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
    await this.write();
  }

  async getAuxiliary(): Promise<AuxiliaryModelSelections> {
    await this.load();
    return normalizeAuxiliary(this.auxiliary);
  }

  async setAuxiliary(task: AuxiliaryTask, selection: ModelSelection | null): Promise<void> {
    await this.load();
    this.auxiliary = normalizeAuxiliary({ ...this.auxiliary, [task]: selection });
    await this.write();
  }

  /**
   * The model Wisps on the global model answer with when it fails for good. It
   * names a provider and model only: its output limit and reasoning follow the
   * model it stands in for.
   */
  async getFallback(): Promise<ModelSelection | null> {
    await this.load();
    return this.fallback ? { ...this.fallback } : null;
  }

  async setFallback(selection: ModelSelection | null): Promise<void> {
    await this.load();
    this.fallback = normalizeModelChoice(selection);
    await this.write();
  }

  private async write(): Promise<void> {
    const configured = Object.values(this.auxiliary).some(Boolean);
    const file: SettingsFile = {
      schemaVersion: 1,
      selection: this.selection,
      ...(configured ? { auxiliary: this.auxiliary } : {}),
      ...(this.fallback ? { fallback: this.fallback } : {}),
    };
    await writeFileAtomically(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<SettingsFile>;
      if (parsed.schemaVersion === 1) {
        this.selection = normalizeSelection(parsed.selection);
        this.auxiliary = normalizeAuxiliary(parsed.auxiliary);
        this.fallback = normalizeModelChoice(parsed.fallback);
      }
      this.loaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.loaded = true;
    }
  }
}
