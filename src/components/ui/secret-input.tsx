import * as React from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A password field with a button that shows what was typed. Saved secrets are
 * never sent back to the renderer, so only the value being entered is revealed.
 */
function SecretInput({ className, disabled, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  const [revealed, setRevealed] = React.useState(false);
  return (
    <div className={cn("relative w-full min-w-0", className)}>
      <Input {...props} type={revealed ? "text" : "password"} disabled={disabled} className="pr-8" />
      <button
        type="button"
        className="absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-r-lg text-dim outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5"
        aria-label={revealed ? "Hide value" : "Show value"}
        aria-pressed={revealed}
        disabled={disabled}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
      </button>
    </div>
  );
}

export { SecretInput };
