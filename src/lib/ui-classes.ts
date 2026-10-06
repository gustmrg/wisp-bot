// Utility-class strings shared by feature components so repeated
// patterns (icon buttons, settings rows, fields) stay consistent.
export const mainPanel = "flex w-0 min-h-0 min-w-0 flex-[1_1_0%] flex-col bg-background";

export const profileAvatar =
  "inline-flex size-[25px] shrink-0 items-center justify-center rounded-full bg-accent text-[9px] font-semibold text-accent-foreground";

export const settingsSelect =
  "max-w-[min(280px,65%)] shrink-0 [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:overflow-hidden [&_[data-slot=select-value]]:text-ellipsis";

export const panelResizer = "absolute inset-y-0 z-20 w-1.5 cursor-col-resize";
