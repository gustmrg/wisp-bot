import { createElement, useId, type CSSProperties, type ComponentProps, type ReactNode } from "react";

import { DEFAULT_WISP_APPEARANCE, WISP_COLORS, type WispAppearance } from "../../shared/wisp-appearance";
import { cn } from "@/lib/utils";
import {
  BODY_GEOMETRY,
  NO_TRAIL_OFFSET,
  TRAIL_GEOMETRY,
  luminance,
  mixColors,
  wispPalette,
} from "@/lib/wisp-appearance";

type WispSize = "default" | "sm" | "lg" | "xl";

/** What the Wisp is doing, shown by how it moves. */
type WispState = "idle" | "working" | "approval" | "error";

interface WispProps extends ComponentProps<"svg"> {
  appearance?: WispAppearance;
  color?: string;
  name?: string;
  size?: WispSize;
  state?: WispState;
}

/** The size each variant is drawn at, which decides how much detail survives. */
const PIXELS: Readonly<Record<WispSize, number>> = { sm: 24, default: 32, lg: 36, xl: 80 };

function hashSeed(seed: string) {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function generatedColor(seed: string): string {
  const hash = hashSeed(seed || "agent");
  return WISP_COLORS[hash % WISP_COLORS.length]?.value ?? WISP_COLORS[0].value;
}

/** The body and trail; `extra` widens every edge, which masks use to draw outlines. */
function WispShapes({ appearance, extra }: { appearance: WispAppearance; extra: number }): ReactNode {
  const body = BODY_GEOMETRY[appearance.body];
  const trail = TRAIL_GEOMETRY[appearance.trail];
  return (
    <>
      {createElement(body.element, { ...body.attributes, strokeWidth: body.round + extra })}
      {trail.paths.length ? (
        <g
          className="wisp-trail"
          style={{ transformOrigin: `${trail.origin[0]}px ${trail.origin[1]}px` }}
          strokeWidth={extra}
        >
          {trail.paths.map((d) => (
            <path key={d} d={d} />
          ))}
          {trail.circles.map(({ cx, cy, r }) => (
            <circle key={`${cx} ${cy}`} cx={cx} cy={cy} r={r} />
          ))}
        </g>
      ) : null}
    </>
  );
}

/** An outline of the shapes, `width` wide, as a mask. */
function OutlineMask({ id, appearance, width }: { id: string; appearance: WispAppearance; width: number }) {
  return (
    <mask id={id} maskUnits="userSpaceOnUse" x="-20" y="-20" width="140" height="140">
      <g fill="#fff" stroke="#fff" strokeLinejoin="round">
        <WispShapes appearance={appearance} extra={width * 2} />
      </g>
      <g fill="#000" stroke="#000" strokeLinejoin="round">
        <WispShapes appearance={appearance} extra={0} />
      </g>
    </mask>
  );
}

function WispEyes({ kind, ink, scale }: { kind: WispAppearance["eyes"]; ink: string; scale: number }): ReactNode {
  const transform = `scale(${scale}) rotate(-8)`;
  const fill = { fill: ink };
  switch (kind) {
    case "oval":
      return (
        <g transform={transform} style={fill}>
          <ellipse cx="-9" rx="4.6" ry="7.6" />
          <ellipse cx="9" rx="4.6" ry="7.6" />
        </g>
      );
    case "dot":
      return (
        <g transform={transform} style={fill}>
          <circle cx="-9" r="5.2" />
          <circle cx="9" r="5.2" />
        </g>
      );
    case "wisp":
      return (
        <g transform={transform} style={fill}>
          <ellipse cx="-10" cy="-3" rx="6" ry="8.5" transform="rotate(14 -10 -3)" />
          <ellipse cx="9" cy="7" rx="7.2" ry="5.2" transform="rotate(-12 9 7)" />
        </g>
      );
    case "slit":
      return (
        <g transform={transform} style={fill}>
          <rect x="-16" y="-2.5" width="12" height="5" rx="2.5" />
          <rect x="4" y="-2.5" width="12" height="5" rx="2.5" />
        </g>
      );
    case "arc":
      return (
        <g transform={transform}>
          <path
            d="M-15 3Q-9.5-6-4 3M4 3Q9.5-6 15 3"
            fill="none"
            style={{ stroke: ink }}
            strokeWidth="4.8"
            strokeLinecap="round"
          />
        </g>
      );
    default:
      return assertNever(kind);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Wisp appearance: ${String(value)}`);
}

function Wisp({
  appearance = DEFAULT_WISP_APPEARANCE,
  color,
  name = "agent",
  size = "default",
  state = "idle",
  className,
  style,
  ...props
}: WispProps) {
  const id = `wisp-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const pixels = PIXELS[size];
  const small = pixels < 32;
  const large = pixels >= 48;
  // A thin outline breaks up at small sizes, so it fills in instead.
  const finish = appearance.finish === "line" && pixels < 28 ? "solid" : appearance.finish;
  const palette = wispPalette(color || generatedColor(name), appearance.tone);
  const unit = 100 / pixels;
  const lineWidth = Math.max(3, 1.4 * unit);
  const lineColor = `light-dark(${palette.line.light}, ${palette.line.dark})`;
  const [faceX, faceY] = BODY_GEOMETRY[appearance.body].face;
  const hasTrail = appearance.trail !== "none";

  const autoInk = luminance(palette.base) > 0.4 ? palette.darkInk : palette.lightInk;
  const ink =
    finish === "line"
      ? lineColor
      : appearance.eyeInk === "dark"
        ? palette.darkInk
        : appearance.eyeInk === "light"
          ? palette.lightInk
          : autoInk;
  // Eyes grow a little where they would otherwise be a pixel or two, and while waiting for approval.
  const eyeScale = (small ? 1.22 : 1) * (state === "approval" ? 1.15 : 1);
  const paint = finish === "glow" ? `url(#${id}-glow)` : palette.base;

  return (
    <svg
      data-slot="wisp"
      data-size={size}
      data-state={state}
      viewBox="0 0 100 100"
      className={cn(
        "size-8 shrink-0 overflow-visible select-none data-[size=lg]:size-9 data-[size=sm]:size-6 data-[size=xl]:size-14",
        className,
      )}
      style={style as CSSProperties}
      {...props}
    >
      <defs>
        {finish === "line" ? <OutlineMask id={`${id}-line`} appearance={appearance} width={lineWidth} /> : null}
        {finish !== "line" && palette.needsRing ? (
          <OutlineMask id={`${id}-ring`} appearance={appearance} width={Math.max(2.5, 1.2 * unit)} />
        ) : null}
        {finish === "glow" ? (
          <radialGradient id={`${id}-glow`} gradientUnits="userSpaceOnUse" cx="36" cy="52" r="62">
            <stop offset="0" stopColor={palette.light} />
            <stop offset=".55" stopColor={palette.base} />
            <stop offset="1" stopColor={palette.deep} />
          </radialGradient>
        ) : null}
        {finish === "glow" && large ? (
          <filter id={`${id}-blur`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        ) : null}
      </defs>
      <g className="wisp-art">
        <g transform={hasTrail ? undefined : NO_TRAIL_OFFSET}>
          {finish === "line" ? (
            <rect x="-20" y="-20" width="140" height="140" style={{ fill: lineColor }} mask={`url(#${id}-line)`} />
          ) : (
            <>
              {finish === "glow" && large ? (
                <g fill={palette.base} stroke={palette.base} opacity=".45" filter={`url(#${id}-blur)`}>
                  <WispShapes appearance={appearance} extra={0} />
                </g>
              ) : null}
              {palette.needsRing ? (
                // Only the dark theme needs it: a near-black body on a near-black background.
                <rect
                  x="-20"
                  y="-20"
                  width="140"
                  height="140"
                  style={{ fill: `light-dark(transparent, ${mixColors(palette.base, "#ffffff", 0.32)})` }}
                  mask={`url(#${id}-ring)`}
                />
              ) : null}
              <g fill={paint} stroke={paint} strokeLinejoin="round">
                <WispShapes appearance={appearance} extra={0} />
              </g>
              {finish === "glow" && large ? (
                <g
                  transform={`translate(${faceX} ${faceY}) scale(.72) translate(${-faceX} ${-faceY})`}
                  fill={palette.light}
                  stroke={palette.light}
                  opacity=".3"
                >
                  <WispShapes appearance={{ ...appearance, trail: "none" }} extra={0} />
                </g>
              ) : null}
            </>
          )}
          <g transform={`translate(${faceX} ${faceY})`}>
            <g className="wisp-look">
              <g className="wisp-blink" style={{ animationDelay: `${-(hashSeed(name) % 6000)}ms` }}>
                <WispEyes kind={appearance.eyes} ink={ink} scale={eyeScale} />
              </g>
            </g>
          </g>
          {!small && appearance.mark === "spark" ? (
            <path
              style={{ fill: finish === "line" ? lineColor : palette.light }}
              transform={`translate(${hasTrail ? 22 : 78} 22) scale(.9)`}
              d="M0-10L2.6-2.6L10 0L2.6 2.6L0 10L-2.6 2.6L-10 0L-2.6-2.6Z"
            />
          ) : null}
          {!small && appearance.mark === "motes" ? (
            <g style={{ fill: finish === "line" ? lineColor : palette.base }}>
              <circle cx="16" cy="28" r="3.2" />
              <circle cx="24" cy="20" r="2" />
              <circle cx="92" cy="46" r="3" />
              <circle cx="91" cy="78" r="2.3" />
            </g>
          ) : null}
        </g>
      </g>
    </svg>
  );
}

export { Wisp };
export type { WispProps, WispState };
