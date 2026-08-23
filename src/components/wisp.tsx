import type { CSSProperties } from "react"

import { cn } from "@/lib/utils"

interface WispProps extends React.ComponentProps<"svg"> {
  color?: string
  size?: "default" | "sm" | "lg"
}

function Wisp({
  color,
  size = "default",
  className,
  style,
  ...props
}: WispProps) {
  return (
    <svg
      data-slot="wisp"
      data-size={size}
      viewBox="0 0 64 64"
      className={cn(
        "size-8 shrink-0 select-none data-[size=lg]:size-10 data-[size=sm]:size-6",
        className
      )}
      style={{ ...style, "--wisp-color": color } as CSSProperties}
      {...props}
    >
      <circle
        cx={32}
        cy={32}
        r={30.5}
        fill="var(--wisp-color, #ffffff)"
        stroke="var(--border)"
        strokeWidth={2}
      />
      <rect
        x={24.75}
        y={17.5}
        width={4.5}
        height={8}
        rx={2.25}
        fill="#000000"
        transform="rotate(10 27 21.5)"
      />
      <rect
        x={35.75}
        y={16.5}
        width={4.5}
        height={8}
        rx={2.25}
        fill="#000000"
        transform="rotate(18 38 20.5)"
      />
    </svg>
  )
}

export { Wisp }
export type { WispProps }
