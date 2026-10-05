/**
 * How a Wisp sounds: a conversational style and a response length. "default"
 * leaves that aspect to the user's general response preferences, then to the
 * built-in defaults.
 */
export const WISP_TONE_STYLES = ["default", "friendly", "direct", "formal", "casual", "didactic", "custom"] as const;
export const WISP_RESPONSE_LENGTHS = ["default", "short", "balanced", "detailed"] as const;

export type WispToneStyle = (typeof WISP_TONE_STYLES)[number];
export type WispResponseLength = (typeof WISP_RESPONSE_LENGTHS)[number];

export interface WispTone {
  style: WispToneStyle;
  length: WispResponseLength;
  /** Free-form tone description, used only when `style` is "custom". */
  custom: string;
}

export const WISP_TONE_CUSTOM_MAX_LENGTH = 500;

export const DEFAULT_WISP_TONE: WispTone = { style: "default", length: "default", custom: "" };

export const WISP_TONE_STYLE_LABELS: Record<WispToneStyle, string> = {
  default: "Default",
  friendly: "Friendly",
  direct: "Direct",
  formal: "Formal",
  casual: "Casual",
  didactic: "Didactic",
  custom: "Custom",
};

export const WISP_RESPONSE_LENGTH_LABELS: Record<WispResponseLength, string> = {
  default: "Default",
  short: "Short",
  balanced: "Balanced",
  detailed: "Detailed",
};

/** True when the tone changes nothing, so it does not need to be stored. */
export function isDefaultWispTone(tone: WispTone | undefined): boolean {
  return !tone || (tone.style === "default" && tone.length === "default");
}

/**
 * Validates a stored or submitted tone. Returns undefined for a tone that
 * changes nothing; custom text is kept only for the custom style.
 */
export function normalizeWispTone(value: unknown): WispTone | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Wisp tone.");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "style" && key !== "length" && key !== "custom")) {
    throw new Error("Invalid Wisp tone.");
  }
  if (!WISP_TONE_STYLES.includes(raw.style as WispToneStyle)) throw new Error("Invalid Wisp tone.");
  if (!WISP_RESPONSE_LENGTHS.includes(raw.length as WispResponseLength)) throw new Error("Invalid Wisp tone.");
  if (raw.custom !== undefined && typeof raw.custom !== "string") throw new Error("Invalid Wisp tone.");
  const custom = (raw.custom ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (custom.length > WISP_TONE_CUSTOM_MAX_LENGTH) throw new Error("Invalid Wisp tone.");
  const style = raw.style as WispToneStyle;
  const tone: WispTone = {
    // A custom style without a description says nothing, so it falls back to the default.
    style: style === "custom" && !custom ? "default" : style,
    length: raw.length as WispResponseLength,
    custom: style === "custom" ? custom : "",
  };
  return isDefaultWispTone(tone) ? undefined : tone;
}

/** The tone as it will be stored: a form draft with default parts collapsed to undefined. */
export function storedWispTone(tone: WispTone | undefined): WispTone | undefined {
  return tone ? normalizeWispTone(tone) : undefined;
}

export function sameWispTone(a: WispTone | undefined, b: WispTone | undefined): boolean {
  const left = a ?? DEFAULT_WISP_TONE;
  const right = b ?? DEFAULT_WISP_TONE;
  return left.style === right.style && left.length === right.length && left.custom === right.custom;
}
