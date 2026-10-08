import type { ModelSelection } from "../../shared/contracts";
import {
  WISP_NAME_MAX_LENGTH,
  WISP_ROLE_MAX_LENGTH,
  WISP_SOUL_MAX_LENGTH,
  type NewWisp,
} from "../../shared/conversations";

const WISP_TEMPLATE_FORMAT = "wisp-template";
const WISP_TEMPLATE_VERSION = 1;
/** Far above the largest valid template; longer text is rejected before parsing. */
const MAX_TEMPLATE_TEXT_LENGTH = 64_000;

/** What a shared Wisp carries: how it behaves and the model it was made with, never how it looks. */
export interface WispTemplate {
  name: string;
  role: string;
  soul: string;
  model?: ModelSelection;
}

export type WispTemplateParseResult = { ok: true; template: WispTemplate } | { ok: false; error: string };

const INVALID_TEMPLATE = "This text is not a valid Wisp template. Copy it again with Share as template.";

export function serializeWispTemplate(wisp: Pick<NewWisp, "name" | "role" | "soul">, model: ModelSelection | null) {
  return JSON.stringify(
    {
      format: WISP_TEMPLATE_FORMAT,
      version: WISP_TEMPLATE_VERSION,
      name: wisp.name,
      role: wisp.role,
      soul: wisp.soul,
      ...(model ? { model } : {}),
    },
    null,
    2,
  );
}

export function parseWispTemplate(text: string): WispTemplateParseResult {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_TEMPLATE_TEXT_LENGTH) return { ok: false, error: INVALID_TEMPLATE };
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: INVALID_TEMPLATE };
  }
  if (!isRecord(raw) || raw.format !== WISP_TEMPLATE_FORMAT || !Number.isSafeInteger(raw.version))
    return { ok: false, error: INVALID_TEMPLATE };
  if ((raw.version as number) > WISP_TEMPLATE_VERSION)
    return { ok: false, error: "This template was made by a newer version of Wisp Bot. Update the app to import it." };

  const name = limitedString(raw.name, WISP_NAME_MAX_LENGTH);
  const role = limitedString(raw.role, WISP_ROLE_MAX_LENGTH);
  const soul = limitedString(raw.soul, WISP_SOUL_MAX_LENGTH);
  if (!name?.trim() || role === undefined || soul === undefined) return { ok: false, error: INVALID_TEMPLATE };
  if (raw.model === undefined) return { ok: true, template: { name, role, soul } };
  const model = modelSelection(raw.model);
  if (!model) return { ok: false, error: INVALID_TEMPLATE };
  return { ok: true, template: { name, role, soul, model } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length <= maxLength ? value : undefined;
}

function modelSelection(value: unknown): ModelSelection | undefined {
  if (!isRecord(value)) return undefined;
  const { providerId, modelId, maxOutputTokens } = value;
  if (typeof providerId !== "string" || !providerId || typeof modelId !== "string" || !modelId) return undefined;
  if (maxOutputTokens === undefined) return { providerId, modelId };
  if (!Number.isSafeInteger(maxOutputTokens) || (maxOutputTokens as number) < 1) return undefined;
  return { providerId, modelId, maxOutputTokens: maxOutputTokens as number };
}
