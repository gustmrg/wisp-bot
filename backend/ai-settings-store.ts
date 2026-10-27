import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  isThinkingLevel,
  MAX_FALLBACK_MODELS,
  type AuxiliaryModelSelections,
  type AuxiliaryTask,
  type ModelSelection,
  type WispFallback,
} from "../shared/contracts.js";
import { writeFileAtomically } from "./atomic-file.js";

/**
 * Version 1 gained `auxiliary`, `fallback`, `moreFallbacks`, and
 * `installationId` as optional fields rather than a new version: earlier
 * releases discard files whose version they do not know, which would lose the
 * main selection after a downgrade. The first fallback stays in `fallback`,
 * where earlier releases read it, and the others follow in `moreFallbacks`.
 */
interface SettingsFile {
  schemaVersion: 1;
  selection: ModelSelection | null;
  auxiliary?: AuxiliaryModelSelections;
  fallback?: ModelSelection;
  moreFallbacks?: ModelSelection[];
  installationId?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Valid fallback models in order, without repeats, at most `MAX_FALLBACK_MODELS`. */
export function normalizeFallbacks(values: ReadonlyArray<unknown>): ModelSelection[] {
  const fallbacks: ModelSelection[] = [];
  for (const value of values) {
    const selection = normalizeModelChoice(value);
    if (!selection || fallbacks.some((saved) => sameChoice(saved, selection))) continue;
    fallbacks.push(selection);
    if (fallbacks.length === MAX_FALLBACK_MODELS) break;
  }
  return fallbacks;
}

function sameChoice(left: ModelSelection, right: ModelSelection): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
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
  private fallbacks: ModelSelection[] = [];
  private installationId: string | undefined;
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
   * The models Wisps on the global model answer with when it fails, tried in
   * order (ADR 035). Each names a provider and model only: its output limit
   * and reasoning follow the model it stands in for.
   */
  async getFallbacks(): Promise<ModelSelection[]> {
    await this.load();
    return this.fallbacks.map((selection) => ({ ...selection }));
  }

  async setFallbacks(selections: ReadonlyArray<ModelSelection>): Promise<void> {
    await this.load();
    this.fallbacks = normalizeFallbacks(selections);
    await this.write();
  }

  /**
   * A stable ID for this installation, created on first use. Provider sign-ins
   * that identify the installing app, such as Sign in with ChatGPT, send it.
   */
  async getInstallationId(): Promise<string> {
    await this.load();
    if (!this.installationId) {
      this.installationId = randomUUID();
      await this.write();
    }
    return this.installationId;
  }

  private async write(): Promise<void> {
    const configured = Object.values(this.auxiliary).some(Boolean);
    const file: SettingsFile = {
      schemaVersion: 1,
      selection: this.selection,
      ...(configured ? { auxiliary: this.auxiliary } : {}),
      ...(this.fallbacks[0] ? { fallback: this.fallbacks[0] } : {}),
      ...(this.fallbacks.length > 1 ? { moreFallbacks: this.fallbacks.slice(1) } : {}),
      ...(this.installationId ? { installationId: this.installationId } : {}),
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
        // A release without the list rewrites the file with its first fallback only, which then stands alone.
        const first = normalizeModelChoice(parsed.fallback);
        this.fallbacks = first
          ? normalizeFallbacks([first, ...(Array.isArray(parsed.moreFallbacks) ? parsed.moreFallbacks : [])])
          : [];
        this.installationId =
          typeof parsed.installationId === "string" && UUID_PATTERN.test(parsed.installationId)
            ? parsed.installationId
            : undefined;
      }
      this.loaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.loaded = true;
    }
  }
}
