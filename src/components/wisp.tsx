import type { CSSProperties, ComponentProps } from "react"

import { cn } from "@/lib/utils"

interface WispProps extends ComponentProps<"svg"> {
  color?: string
  name?: string
  size?: "default" | "sm" | "lg"
}

export const AVATAR_COLORS = [
  { id: "red", label: "Red", value: "#FF263C" },
  { id: "orange", label: "Orange", value: "#FF6700" },
  { id: "yellow", label: "Yellow", value: "#FF9800" },
  { id: "green", label: "Green", value: "#00C972" },
  { id: "cyan", label: "Cyan", value: "#00BCA6" },
  { id: "blue", label: "Blue", value: "#1084FE" },
  { id: "violet", label: "Violet", value: "#9159FE" },
  { id: "magenta", label: "Magenta", value: "#FF309B" },
  { id: "gray", label: "Gray", value: "#777777" },
] as const

function hashSeed(seed: string) {
  let hash = 2166136261

  for (const character of seed) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

function generatedWisp(seed: string) {
  const hash = hashSeed(seed || "agent")
  const color =
    AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0]

  return {
    color: color.value,
    blinkDelay: -((hash >>> 16) % 48) / 10,
  }
}

function Wisp({
  color,
  name = "agent",
  size = "default",
  className,
  style,
  ...props
}: WispProps) {
  const avatar = generatedWisp(name)

  return (
    <svg
      data-slot="wisp"
      data-size={size}
      data-wisp-seed={name}
      viewBox="0 0 64 64"
      className={cn(
        "size-8 shrink-0 select-none data-[size=lg]:size-10 data-[size=sm]:size-6",
        className
      )}
      style={
        {
          "--wisp-color": color || avatar.color,
          "--wisp-blink-delay": `${avatar.blinkDelay}s`,
          ...style,
        } as CSSProperties
      }
      {...props}
    >
      <g fill="var(--wisp-color)" stroke="var(--border)" strokeWidth={2}>
        <circle cx={32} cy={33} r={27} />
      </g>
      <g className="wisp-eyes" aria-hidden="true">
        <rect
          x={24.75}
          y={17.5}
          width={4.5}
          height={8}
          rx={2.25}
          fill="#000000"
          stroke="none"
        />
        <rect
          x={35.75}
          y={16.5}
          width={4.5}
          height={8}
          rx={2.25}
          fill="#000000"
          stroke="none"
        />
      </g>
    </svg>
  )
}

export { Wisp }
export type { WispProps }
