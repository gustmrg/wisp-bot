import { cn } from "@/lib/utils";

/** A logo on a white tile, so dark marks stay visible in dark mode; without a logo it only keeps the space. */
export function LogoTile({ src, className }: { src: string | undefined; className?: string }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-md",
        src && "border border-border bg-white p-0.5",
        className,
      )}
    >
      {src ? <img src={src} alt="" className="size-full object-contain" /> : null}
    </span>
  );
}
