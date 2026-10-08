import {
  WISP_APPEARANCE_AXES,
  WISP_COLORS,
  type WispAppearance,
  type WispBody,
  type WispColorId,
  type WispTrail,
} from "../../shared/wisp-appearance";

type AppearanceLabels = { readonly [Key in keyof WispAppearance]: Readonly<Record<WispAppearance[Key], string>> };

const LABELS: AppearanceLabels = {
  body: { round: "Round", drop: "Drop", pebble: "Pebble", crystal: "Crystal", block: "Block" },
  trail: { hook: "Hook", flame: "Flame", curl: "Curl", none: "None" },
  tone: { vivid: "Vivid", soft: "Soft" },
  eyes: { oval: "Oval", dot: "Dots", wisp: "Wisp", slit: "Slits", arc: "Arcs" },
  eyeInk: { auto: "Auto", dark: "Dark", light: "Light" },
  finish: { solid: "Solid", glow: "Glow", line: "Outline" },
  mark: { none: "None", spark: "Spark", motes: "Motes" },
};

/** Each appearance axis with its options and their labels, in display order. */
export function appearanceOptions<Key extends keyof WispAppearance>(
  key: Key,
): ReadonlyArray<{ value: WispAppearance[Key]; label: string }> {
  return WISP_APPEARANCE_AXES[key].map((value) => ({ value, label: LABELS[key][value] }));
}

const COLOR_LABELS: Readonly<Record<WispColorId, string>> = {
  charcoal: "Charcoal",
  red: "Red",
  orange: "Orange",
  amber: "Amber",
  teal: "Teal",
  blue: "Blue",
  indigo: "Indigo",
  violet: "Violet",
  magenta: "Magenta",
  gray: "Gray",
};

export const AVATAR_COLORS = WISP_COLORS.map((color) => ({ ...color, label: COLOR_LABELS[color.id] }));

/** A random appearance and palette color, for "Random Wisp". */
export function randomAppearance(random: () => number = Math.random): { appearance: WispAppearance; color: string } {
  const pick = <T>(values: ReadonlyArray<T>): T => values[Math.floor(random() * values.length)] as T;
  const appearance = Object.fromEntries(
    Object.entries(WISP_APPEARANCE_AXES).map(([key, values]) => [key, pick(values)]),
  ) as unknown as WispAppearance;
  // Eye color follows the body unless someone chooses otherwise.
  return { appearance: { ...appearance, eyeInk: "auto" }, color: pick(WISP_COLORS).value };
}

// ---------- color ----------

function channels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function toHex(values: ReadonlyArray<number>): string {
  return `#${values.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

export function mixColors(from: string, to: string, amount: number): string {
  const target = channels(to);
  return toHex(channels(from).map((value, index) => value + ((target[index] ?? value) - value) * amount));
}

/** Relative luminance (WCAG), from 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const [red, green, blue] = channels(hex);
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

export interface WispPalette {
  base: string;
  light: string;
  deep: string;
  /** Eye color on a light body. */
  darkInk: string;
  /** Eye color on a dark body. */
  lightInk: string;
  /** Outline color on light and dark backgrounds. */
  line: { light: string; dark: string };
  /** True when the body is too dark to tell apart from a dark background. */
  needsRing: boolean;
}

/** The tones a Wisp is drawn with, from its palette color. A soft tone is the same color, lighter. */
export function wispPalette(color: string, tone: WispAppearance["tone"]): WispPalette {
  const base = tone === "soft" ? mixColors(color, "#ffffff", 0.55) : color;
  const light = mixColors(base, "#ffffff", 0.45);
  const deep = mixColors(base, "#000000", tone === "soft" ? 0.3 : 0.32);
  const baseLuminance = luminance(base);
  return {
    base,
    light,
    deep,
    darkInk: mixColors(color, "#000000", 0.74),
    lightInk: "#f7fbff",
    line: { light: baseLuminance > 0.45 ? deep : base, dark: baseLuminance < 0.04 ? light : base },
    needsRing: baseLuminance < 0.04,
  };
}

// ---------- geometry (a 100 × 100 view box) ----------

export interface BodyGeometry {
  element: "ellipse" | "path" | "rect";
  attributes: Readonly<Record<string, number | string>>;
  /** Where the eyes are centered. */
  face: readonly [number, number];
  /** Extra stroke that rounds sharp corners. */
  round: number;
}

export const BODY_GEOMETRY: Readonly<Record<WispBody, BodyGeometry>> = {
  round: { element: "ellipse", attributes: { cx: 46, cy: 64, rx: 37, ry: 32 }, face: [46, 65], round: 0 },
  drop: {
    element: "path",
    attributes: { d: "M72 30C80 44 85 54 85 67C85 85 67 96 47 96C27 96 10 85 10 66C10 46 30 34 72 30Z" },
    face: [46, 67],
    round: 0,
  },
  pebble: {
    element: "path",
    attributes: { d: "M40 32C60 26 82 36 86 56C90 76 76 94 52 95C28 96 10 86 9 66C8 48 22 37 40 32Z" },
    face: [47, 65],
    round: 0,
  },
  crystal: {
    element: "path",
    attributes: { d: "M42 34L73 38L84 62L67 89L29 89L13 63L23 41Z" },
    face: [48, 64],
    round: 10,
  },
  block: { element: "rect", attributes: { x: 10, y: 33, width: 76, height: 61, rx: 24 }, face: [48, 64], round: 0 },
};

/** A curve that thins from its base to its tip: cubic segments, and the radius at each end. */
interface TrailStroke {
  segments: ReadonlyArray<readonly [number, number, number, number, number, number, number, number]>;
  radius: readonly [number, number];
}

const TRAIL_STROKES: Readonly<Record<WispTrail, { origin: readonly [number, number]; strokes: TrailStroke[] }>> = {
  hook: {
    origin: [64, 46],
    strokes: [
      {
        segments: [
          [64, 50, 80, 42, 85, 24, 75, 14],
          [75, 14, 68, 7, 57, 9, 50, 4],
        ],
        radius: [15, 1.6],
      },
    ],
  },
  flame: { origin: [58, 44], strokes: [{ segments: [[56, 48, 60, 32, 68, 22, 73, 5]], radius: [16, 1.4] }] },
  curl: {
    origin: [62, 46],
    strokes: [
      {
        segments: [
          [60, 50, 79, 42, 86, 18, 71, 11],
          [71, 11, 60, 6, 54, 18, 63, 21],
        ],
        radius: [14, 1.7],
      },
    ],
  },
  none: { origin: [50, 50], strokes: [] },
};

export interface TrailGeometry {
  /** The point the trail sways around. */
  origin: readonly [number, number];
  paths: ReadonlyArray<string>;
  circles: ReadonlyArray<{ cx: number; cy: number; r: number }>;
}

function bezierPoint(segment: TrailStroke["segments"][number], t: number): [number, number] {
  const u = 1 - t;
  const at = (a: number, b: number, c: number, d: number) =>
    u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  return [at(segment[0], segment[2], segment[4], segment[6]), at(segment[1], segment[3], segment[5], segment[7])];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Outlines a tapering stroke as a polygon, with round caps at both ends. */
function trailGeometry(trail: WispTrail): TrailGeometry {
  const { origin, strokes } = TRAIL_STROKES[trail];
  const paths: string[] = [];
  const circles: Array<{ cx: number; cy: number; r: number }> = [];
  for (const { segments, radius } of strokes) {
    const points: Array<[number, number]> = [];
    segments.forEach((segment, index) => {
      for (let step = index === 0 ? 0 : 1; step <= 40; step += 1) points.push(bezierPoint(segment, step / 40));
    });
    const last = points.length - 1;
    const left: Array<[number, number]> = [];
    const right: Array<[number, number]> = [];
    points.forEach((point, index) => {
      const before = points[Math.max(0, index - 1)] ?? point;
      const after = points[Math.min(last, index + 1)] ?? point;
      const dx = after[0] - before[0];
      const dy = after[1] - before[1];
      const length = Math.hypot(dx, dy) || 1;
      const r = radius[1] + (radius[0] - radius[1]) * (1 - index / last) ** 1.15;
      left.push([point[0] - (dy / length) * r, point[1] + (dx / length) * r]);
      right.push([point[0] + (dy / length) * r, point[1] - (dx / length) * r]);
    });
    paths.push(
      `${[...left, ...right.reverse()]
        .map(([x, y], index) => `${index === 0 ? "M" : "L"}${round2(x)} ${round2(y)}`)
        .join("")}Z`,
    );
    const base = points[0];
    const tip = points[last];
    if (base) circles.push({ cx: round2(base[0]), cy: round2(base[1]), r: radius[0] });
    if (tip) circles.push({ cx: round2(tip[0]), cy: round2(tip[1]), r: radius[1] });
  }
  return { origin, paths, circles };
}

export const TRAIL_GEOMETRY: Readonly<Record<WispTrail, TrailGeometry>> = {
  hook: trailGeometry("hook"),
  flame: trailGeometry("flame"),
  curl: trailGeometry("curl"),
  none: trailGeometry("none"),
};

/** Without a trail the body sits lower in the box; it moves up to stay centered. */
export const NO_TRAIL_OFFSET = "translate(2 -12)";
