import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge the extra steps of the type scale in styles.css, so
// `text-2xs`/`text-md` are merged as font sizes instead of text colors.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["2xs", "md"] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
