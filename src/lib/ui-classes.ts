// Utility-class strings shared by feature components so repeated
// patterns (icon buttons, settings rows, fields) stay consistent.
export const iconButton =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-transparent text-[#686868] hover:bg-black/[0.06] hover:text-[#444444] dark:text-[#8f8f8f] dark:hover:bg-white/[0.06] dark:hover:text-[#dddddd] [&_svg]:size-[15px]";

export const mainPanel = "flex w-0 min-h-0 min-w-0 flex-[1_1_0%] flex-col bg-background";

export const profileAvatar =
  "inline-flex size-[25px] shrink-0 items-center justify-center rounded-full bg-[#e5e5e5] text-[9px] font-[650] text-[#444444] dark:bg-[#2e2e2e] dark:text-[#dddddd]";

export const detailsField = "mb-3 flex flex-col gap-[5px] text-dim text-[11px]";

export const detailsFieldControl =
  "w-full resize-none rounded-lg border border-black/[0.07] bg-white px-[9px] py-2 text-[12.5px] text-[#272727] outline-none focus:border-black/[0.18] dark:border-white/[0.07] dark:bg-[#191919] dark:text-[#e7e7e7] dark:focus:border-white/[0.18]";

export const notificationCard =
  "mt-[15px] flex items-center gap-3 rounded-[9px] bg-[#f0f0f0] p-[11px] dark:bg-[#1c1c1c]";

export const notificationCardCopy = "flex min-w-0 flex-1 flex-col gap-[3px]";

export const settingsCard =
  "overflow-hidden rounded-[10px] bg-[#f4f4f4] [&_strong]:text-[12.5px] [&_small]:text-dim [&_small]:text-[11.5px] dark:bg-[#202020]";

export const settingsCardStack = `${settingsCard} divide-y divide-black/[0.055] dark:divide-white/[0.055]`;

export const settingsRow = "flex min-h-[58px] items-center gap-3 px-3.5 py-[11px]";

export const settingsRowCopy = "flex min-w-0 flex-1 flex-col gap-[3px]";

export const settingsGroupLabel = "mx-0.5 mb-[7px] mt-[18px] block text-dim text-[11px]";

export const settingsSelect =
  "max-w-[min(280px,65%)] shrink-0 [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:overflow-hidden [&_[data-slot=select-value]]:text-ellipsis";

export const panelResizer = "absolute inset-y-0 z-20 w-1.5 cursor-col-resize";
