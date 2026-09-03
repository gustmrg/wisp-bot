import { WISP_SHAPE_IDS, type WispShape } from "../../shared/conversations";

const WISP_SHAPE_LABELS: Record<WispShape, string> = {
  circle: "Circle",
  pebble: "Pebble",
  square: "Square",
  pill: "Pill",
  triangle: "Triangle",
  diamond: "Diamond",
  hexagon: "Hexagon",
  cloud: "Cloud",
  drop: "Drop",
};

export const WISP_SHAPES: ReadonlyArray<{ id: WispShape; label: string }> = WISP_SHAPE_IDS.map((id) => ({
  id,
  label: WISP_SHAPE_LABELS[id],
}));

export const AVATAR_COLORS = [
  { id: "charcoal", label: "Charcoal", value: "#262626" },
  { id: "red", label: "Red", value: "#ff3b30" },
  { id: "orange", label: "Orange", value: "#ed712e" },
  { id: "amber", label: "Amber", value: "#f19d38" },
  { id: "teal", label: "Teal", value: "#54b9a6" },
  { id: "blue", label: "Blue", value: "#3c82f6" },
  { id: "indigo", label: "Indigo", value: "#6464ef" },
  { id: "violet", label: "Violet", value: "#885cf5" },
  { id: "magenta", label: "Magenta", value: "#e5498f" },
  { id: "gray", label: "Gray", value: "#8e8e8e" },
] as const;

export type { WispShape };
