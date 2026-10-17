import { cn } from "@/lib/utils";
import { CONNECTION_BACKDROP } from "./connection-steps";

const bar = "rounded-full bg-muted";

/** Placeholder conversations: the widths of each row's name and preview. */
const ROWS = [
  [52, 78],
  [38, 64],
  [60, 82],
  [44, 70],
  [56, 58],
  [34, 76],
] as const;

/** Placeholder messages: who sent each one, and how wide and tall it is. */
const MESSAGES = [
  { mine: false, width: 62, lines: 3 },
  { mine: true, width: 40, lines: 1 },
  { mine: false, width: 70, lines: 4 },
  { mine: true, width: 48, lines: 2 },
] as const;

/**
 * A blurred outline of the app behind the screens shown before it can load,
 * so they read as a step on the way into the app rather than a blank page.
 * It draws only shapes: the app itself needs a backend that is not there yet.
 * On a phone it shows the conversation list, the app's first page there.
 */
export function AppBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden bg-background select-none">
      <div className="absolute -inset-4 flex blur-[6px]">
        <div className="flex w-[296px] flex-none flex-col gap-1 bg-sidebar px-6 pt-8 max-[760px]:w-full">
          <div className={cn(bar, "mb-4 h-8 w-full rounded-lg")} />
          {ROWS.map(([name, preview]) => (
            <div key={`${name}-${preview}`} className="flex items-center gap-3 py-2.5">
              <div className="size-9 flex-none rounded-full bg-muted" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className={cn(bar, "h-2.5")} style={{ width: `${name}%` }} />
                <div className={cn(bar, "h-2 opacity-70")} style={{ width: `${preview}%` }} />
              </div>
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col max-[760px]:hidden">
          <div className="flex h-16 flex-none items-center gap-3 border-b border-border px-10">
            <div className="size-8 rounded-full bg-muted" />
            <div className={cn(bar, "h-3 w-40")} />
          </div>
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-end gap-5 px-10 pb-6">
            {MESSAGES.map(({ mine, width, lines }) => (
              <div
                key={`${width}-${lines}`}
                className={cn("flex flex-col gap-2 rounded-2xl p-4", mine ? "self-end bg-muted" : "self-start")}
                style={{ width: `${width}%` }}
              >
                {Array.from({ length: lines }, (_, line) => (
                  <div
                    key={line}
                    className={cn(bar, "h-2.5", mine && "bg-dim/25")}
                    style={{ width: line === lines - 1 && lines > 1 ? "60%" : "100%" }}
                  />
                ))}
              </div>
            ))}
            <div className="mt-2 h-24 rounded-2xl border border-border bg-card" />
          </div>
        </div>
      </div>
      <div className={cn("absolute inset-0", CONNECTION_BACKDROP)} />
    </div>
  );
}
