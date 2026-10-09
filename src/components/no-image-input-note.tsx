import { EyeOffIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** Says that a model cannot see images, wherever a model is chosen or shown. */
export function NoImageInputNote({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-1 text-xs text-warning [&_svg]:size-3 [&_svg]:flex-none", className)}>
      <EyeOffIcon aria-hidden="true" />
      This model can't see images or scanned PDF pages.
    </span>
  );
}
