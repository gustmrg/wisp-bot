/**
 * How a Wisp is drawn when it has no uploaded picture: a body, a trail, and
 * the details on them. Every axis is a short list of IDs; the renderer owns
 * the geometry, and the backend only checks the IDs.
 */

export const WISP_BODIES = ["round", "drop", "pebble", "crystal", "block"] as const;
export const WISP_TRAILS = ["hook", "flame", "curl", "none"] as const;
export const WISP_TONES = ["vivid", "soft"] as const;
export const WISP_EYES = ["oval", "dot", "wisp", "slit", "arc"] as const;
export const WISP_EYE_INKS = ["auto", "dark", "light"] as const;
export const WISP_FINISHES = ["solid", "glow", "line"] as const;
export const WISP_MARKS = ["none", "spark", "motes"] as const;

export type WispBody = (typeof WISP_BODIES)[number];
export type WispTrail = (typeof WISP_TRAILS)[number];
export type WispTone = (typeof WISP_TONES)[number];
export type WispEyes = (typeof WISP_EYES)[number];
export type WispEyeInk = (typeof WISP_EYE_INKS)[number];
export type WispFinish = (typeof WISP_FINISHES)[number];
export type WispMark = (typeof WISP_MARKS)[number];

export interface WispAppearance {
  body: WispBody;
  trail: WispTrail;
  tone: WispTone;
  eyes: WispEyes;
  eyeInk: WispEyeInk;
  finish: WispFinish;
  mark: WispMark;
}

/** Each appearance field with the values it accepts. */
export const WISP_APPEARANCE_AXES: { readonly [Key in keyof WispAppearance]: ReadonlyArray<WispAppearance[Key]> } = {
  body: WISP_BODIES,
  trail: WISP_TRAILS,
  tone: WISP_TONES,
  eyes: WISP_EYES,
  eyeInk: WISP_EYE_INKS,
  finish: WISP_FINISHES,
  mark: WISP_MARKS,
};

/** A new Wisp's starting appearance, and the value a stored field falls back to when it is unknown. */
export const DEFAULT_WISP_APPEARANCE: WispAppearance = {
  body: "round",
  trail: "hook",
  tone: "vivid",
  eyes: "wisp",
  eyeInk: "auto",
  finish: "glow",
  mark: "none",
};

/** The colors a Wisp can take. A Wisp without one gets a color derived from its name. */
export const WISP_COLORS = [
  { id: "charcoal", value: "#262626" },
  { id: "red", value: "#ff3b30" },
  { id: "orange", value: "#ed712e" },
  { id: "amber", value: "#f19d38" },
  { id: "teal", value: "#54b9a6" },
  { id: "blue", value: "#3c82f6" },
  { id: "indigo", value: "#6464ef" },
  { id: "violet", value: "#885cf5" },
  { id: "magenta", value: "#e5498f" },
  { id: "gray", value: "#8e8e8e" },
] as const;

export type WispColorId = (typeof WISP_COLORS)[number]["id"];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** The palette value for a color, or undefined when it is not one of them. */
export function wispPaletteColor(value: string): string | undefined {
  return WISP_COLORS.find((color) => color.value === value.toLowerCase())?.value;
}

/** The palette color closest to any hex color, for colors saved before the palette was enforced. */
export function nearestWispColor(value: string): string | undefined {
  if (!HEX_COLOR.test(value)) return undefined;
  const channels = (hex: string): [number, number, number] => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
  const [red, green, blue] = channels(value);
  let nearest: string | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const color of WISP_COLORS) {
    const [r, g, b] = channels(color.value);
    const distance = (red - r) ** 2 + (green - g) ** 2 + (blue - b) ** 2;
    if (distance < nearestDistance) {
      nearest = color.value;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/**
 * Wisps saved before appearances had only a shape. Each keeps the closest
 * body, no trail, and the flat look it had.
 */
const LEGACY_SHAPE_BODIES: Readonly<Record<string, WispBody>> = {
  circle: "round",
  pill: "pebble",
  pebble: "pebble",
  square: "block",
  triangle: "crystal",
  diamond: "crystal",
  hexagon: "crystal",
  cloud: "pebble",
  drop: "drop",
};

export function appearanceFromLegacyShape(shape: unknown): WispAppearance | undefined {
  const body = typeof shape === "string" ? LEGACY_SHAPE_BODIES[shape] : undefined;
  if (!body) return undefined;
  return { body, trail: "none", tone: "vivid", eyes: "oval", eyeInk: "auto", finish: "solid", mark: "none" };
}

export function isWispAppearanceValue<Key extends keyof WispAppearance>(
  key: Key,
  value: unknown,
): value is WispAppearance[Key] {
  return (WISP_APPEARANCE_AXES[key] as ReadonlyArray<unknown>).includes(value);
}

export function sameWispAppearance(a: WispAppearance, b: WispAppearance): boolean {
  return (Object.keys(WISP_APPEARANCE_AXES) as Array<keyof WispAppearance>).every((key) => a[key] === b[key]);
}
