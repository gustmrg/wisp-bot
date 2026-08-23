"use client"

import * as React from "react"
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"

import { cn } from "@/lib/utils"

function ToggleGroup({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive>) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={cn("flex flex-wrap items-center gap-2", className)}
      {...props}
    />
  )
}

function ToggleGroupItem({
  className,
  ...props
}: TogglePrimitive.Props) {
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full border-2 border-transparent p-1 outline-none transition-[transform,box-shadow,border-color] hover:scale-105 focus-visible:ring-3 focus-visible:ring-ring/50 data-pressed:border-ring data-pressed:ring-2 data-pressed:ring-ring/30",
        className
      )}
      {...props}
    />
  )
}

export { ToggleGroup, ToggleGroupItem }
