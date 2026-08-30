import type { CSSProperties, ComponentProps, ReactNode } from "react";

import type { WispShape } from "@/chat-data";
import { cn } from "@/lib/utils";

interface WispProps extends ComponentProps<"svg"> {
  color?: string;
  name?: string;
  shape?: WispShape;
  size?: "default" | "sm" | "lg" | "xl";
  outlined?: boolean;
}

export const AVATAR_COLORS = [
  { id: "charcoal", label: "Charcoal", value: "#262626" },
  { id: "brown", label: "Brown", value: "#8b6b52" },
  { id: "red", label: "Red", value: "#e5484d" },
  { id: "orange", label: "Orange", value: "#f0762b" },
  { id: "yellow", label: "Yellow", value: "#eebb4d" },
  { id: "green", label: "Green", value: "#35b06f" },
  { id: "cyan", label: "Cyan", value: "#40c4aa" },
  { id: "blue", label: "Blue", value: "#4a9eff" },
  { id: "violet", label: "Violet", value: "#8b70f6" },
  { id: "magenta", label: "Magenta", value: "#e5498f" },
  { id: "gray", label: "Gray", value: "#8e8e8e" },
] as const;

export const WISP_SHAPES: ReadonlyArray<{ id: WispShape; label: string }> = [
  { id: "circle", label: "Circle" },
  { id: "pebble", label: "Pebble" },
  { id: "square", label: "Square" },
  { id: "pill", label: "Pill" },
  { id: "triangle", label: "Triangle" },
  { id: "hexagon", label: "Hexagon" },
  { id: "cloud", label: "Cloud" },
  { id: "drop", label: "Drop" },
];

function hashSeed(seed: string) {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function generatedWisp(seed: string) {
  const hash = hashSeed(seed || "agent");
  return {
    color: AVATAR_COLORS[hash % AVATAR_COLORS.length]?.value ?? AVATAR_COLORS[0].value,
    blinkDelay: -((hash >>> 16) % 48) / 10,
  };
}

function WispBody({ shape }: { shape: WispShape }): ReactNode {
  switch (shape) {
    case "pebble":
      return <path d="M31 6C46 4 56 17 59 33s-9 24-25 24S5 49 5 35 15 8 31 6Z" />;
    case "triangle":
      return <path d="M26 8q6-10 12 0l23 40q6 11-7 11H10Q-3 59 3 48Z" />;
    case "cloud":
      return <path d="M14 25C9 7 34 2 40 13c13-5 22 6 19 18C72 48 49 61 37 53 20 64 0 52 5 38q1-9 9-13Z" />;
    case "square":
      return <rect x="6" y="6" width="52" height="52" rx="15" />;
    case "pill":
      return <rect x="3" y="14" width="58" height="36" rx="18" />;
    case "diamond":
      return <rect x="11" y="11" width="42" height="42" rx="12" transform="rotate(45 32 32)" />;
    case "hexagon":
      return <path d="M27 3q5-3 10 0l19 11q5 3 5 9v20q0 6-5 9L37 63q-5 3-10 0L8 52q-5-3-5-9V23q0-6 5-9Z" transform="translate(2 0) scale(.94)" />;
    case "drop":
      return <path d="M32 4c8 11 20 23 20 36a20 20 0 1 1-40 0C12 27 24 15 32 4Z" />;
    default:
      return <circle cx="32" cy="32" r="27" />;
  }
}

function Wisp({
  color,
  name = "agent",
  shape = "circle",
  size = "default",
  outlined = false,
  className,
  style,
  ...props
}: WispProps) {
  const avatar = generatedWisp(name);

  return (
    <svg
      data-slot="wisp"
      data-size={size}
      viewBox="0 0 64 64"
      className={cn(
        "size-8 shrink-0 select-none data-[size=lg]:size-9 data-[size=sm]:size-6 data-[size=xl]:size-14",
        className,
      )}
      style={{
        "--wisp-color": color || avatar.color,
        "--wisp-blink-delay": `${avatar.blinkDelay}s`,
        ...style,
      } as CSSProperties}
      {...props}
    >
      {outlined ? <g className="text-[#5c5c5c] dark:text-[#b8b8b8]" fill="none" stroke="currentColor" strokeWidth="2" transform="translate(-3.2 -3.2) scale(1.1)"><WispBody shape={shape} /></g> : null}
      <g fill="var(--wisp-color)">
        <WispBody shape={shape} />
      </g>
      <g aria-hidden="true" fill="white" transform={`${shape === "triangle" || shape === "drop" || shape === "diamond" ? "translate(-6 8) " : ""}rotate(-18 38 27)`}>
        <rect x="31" y="23" width="4.5" height="10" rx="2.25" />
        <rect x="46" y="23" width="4.5" height="10" rx="2.25" />
      </g>
    </svg>
  );
}

export { Wisp };
export type { WispProps };
