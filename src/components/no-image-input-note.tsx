import { EyeOffIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Says that a model cannot see images, wherever a model is chosen or shown,
 * and which image model reads them instead when one is given.
 */
export function NoImageInputNote({ className, imageModel }: { className?: string; imageModel?: string | null }) {
  return (
    <span className={cn("flex items-center gap-1 text-xs text-warning [&_svg]:size-3 [&_svg]:flex-none", className)}>
      <EyeOffIcon aria-hidden="true" />
      {imageModel
        ? `This model can't see images. ${imageModel} reads images and scanned PDF pages for it.`
        : "This model can't see images or scanned PDF pages."}
    </span>
  );
}
