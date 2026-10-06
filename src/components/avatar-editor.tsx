import { useEffect, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { ShuffleIcon, UploadIcon, XIcon } from "lucide-react";

import type { WispChatChanges, WispSummary } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
import { Wisp } from "@/components/wisp";
import { cn } from "@/lib/utils";
import { AVATAR_COLORS, WISP_SHAPES } from "@/lib/wisp-appearance";

const avatarAction =
  "relative mt-1 inline-flex justify-center rounded-[9px] border border-border bg-secondary px-3.5 py-2 text-foreground hover:bg-accent";

const hoverReveal =
  "[&:not([aria-expanded=true]):hover_.editable-avatar]:brightness-75 [&:not([aria-expanded=true]):focus-visible_.editable-avatar]:brightness-75 [&:not([aria-expanded=true]):hover_.avatar-edit-overlay]:opacity-100 [&:not([aria-expanded=true]):focus-visible_.avatar-edit-overlay]:opacity-100 [&:not([aria-expanded=true]):hover_.avatar-edit-tip]:opacity-100 [&:not([aria-expanded=true]):focus-visible_.avatar-edit-tip]:opacity-100";

async function readAvatar(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("Choose a PNG, JPG, or WebP image.");
  }
  if (file.size > 5 * 1024 * 1024) throw new Error("Choose an image smaller than 5 MB.");

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not process this image. Try another file.");
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      256,
      256,
    );
    return canvas.toDataURL("image/webp", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface AvatarEditorProps {
  chat: WispSummary;
  onChange: (changes: Omit<WispChatChanges, "kind">) => void;
}

function AvatarEditor({ chat, onChange }: AvatarEditorProps) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const uploadVersion = useRef(0);

  useEffect(
    () => () => {
      uploadVersion.current += 1;
    },
    [],
  );

  function selectWisp(changes: Omit<WispChatChanges, "kind">) {
    uploadVersion.current += 1;
    setUploading(false);
    setError("");
    onChange({ ...changes, avatarImage: undefined });
  }

  async function upload(file: File) {
    const version = ++uploadVersion.current;
    setError("");
    setUploading(true);
    try {
      const avatarImage = await readAvatar(file);
      if (uploadVersion.current === version) onChange({ avatarImage });
    } catch (cause) {
      if (uploadVersion.current === version) {
        setError(cause instanceof Error ? cause.message : "Could not load this image.");
      }
    } finally {
      if (uploadVersion.current === version) setUploading(false);
    }
  }

  function generateWisp() {
    const shapes = WISP_SHAPES.filter((shape) => shape.id !== chat.shape);
    const colors = AVATAR_COLORS.filter((color) => color.value !== chat.color);
    const shape = shapes[Math.floor(Math.random() * shapes.length)];
    const color = colors[Math.floor(Math.random() * colors.length)];
    if (!shape || !color) return;
    selectWisp({
      shape: shape.id,
      color: color.value,
    });
  }

  return (
    <div className="relative">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          className={cn(
            "relative mb-2 flex w-full flex-col items-center rounded-xl border-0 bg-transparent pt-5 pb-[30px]",
            hoverReveal,
          )}
          aria-label="Upload avatar image"
        >
          <span className="flex transition-[filter] duration-[120ms] [&>img]:size-20! [&>img]:overflow-visible [&>svg]:size-20! [&>svg]:overflow-visible">
            <ChatAvatar chat={chat} size="xl" />
          </span>
          <span
            className="avatar-edit-overlay pointer-events-none absolute top-5 left-1/2 flex size-20 -translate-x-1/2 items-center justify-center opacity-0 transition-opacity duration-[120ms] [&_svg]:size-[23px] [&_svg]:text-white"
            aria-hidden="true"
          >
            <UploadIcon />
          </span>
          <span className="avatar-edit-tip pointer-events-none absolute top-[105px] left-1/2 z-[5] -translate-x-1/2 rounded-lg border border-border bg-secondary px-[9px] py-1 text-sm whitespace-nowrap text-secondary-foreground opacity-0 shadow-md transition-opacity duration-[120ms]">
            Upload image
          </span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            className="z-[60] w-[min(var(--anchor-width),360px)] max-w-[calc(100vw-24px)]"
            side="bottom"
            align="center"
            sideOffset={8}
            collisionPadding={12}
          >
            <Popover.Popup
              className="max-h-(--available-height) animate-avatar-sheet-in overflow-y-auto rounded-[18px] border border-border bg-card shadow-xl"
              aria-label="Upload avatar image"
            >
              <header className="flex items-center justify-between gap-0.5 border-b border-black/[0.08] p-2 dark:border-white/[0.08]">
                <strong className="pl-1.5 text-base font-medium">Upload an avatar</strong>
                <Popover.Close
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-transparent text-dim hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
                  aria-label="Close avatar upload"
                >
                  <XIcon aria-hidden="true" />
                </Popover.Close>
              </header>
              <div className="flex min-h-[250px] flex-col items-center justify-center gap-2.5 px-5 py-6 text-center">
                <UploadIcon aria-hidden="true" className="mb-1 size-7 text-dim" />
                <p className="m-0 text-dim text-sm leading-[1.5]">
                  PNG, JPG, or WebP, up to 5 MB. Images are cropped to a square and saved on this device.
                </p>
                <label
                  className={cn(
                    avatarAction,
                    "overflow-hidden focus-within:outline-2 focus-within:outline-ring focus-within:outline-offset-2 aria-disabled:opacity-50",
                  )}
                  aria-disabled={uploading}
                >
                  {uploading ? "Processing…" : "Choose image"}
                  <input
                    className="absolute inset-0 size-full cursor-pointer opacity-0"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    aria-label="Choose avatar image"
                    disabled={uploading}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) void upload(file);
                    }}
                  />
                </label>
                {error ? (
                  <p className="m-0 text-destructive" role="alert">
                    {error}
                  </p>
                ) : null}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <section className="px-1 pb-5" aria-label="Wisp appearance">
        <header className="mb-3.5 flex items-center justify-between gap-2">
          <strong className="text-dim text-sm font-medium">Appearance</strong>
        </header>
        <div
          className="mb-7 grid grid-cols-4 gap-x-2 gap-y-3.5"
          role="group"
          data-slot="shape-grid"
          aria-label="Wisp shape"
        >
          {WISP_SHAPES.map((shape) => {
            const selected = !chat.avatarImage && chat.shape === shape.id;
            return (
              <button
                type="button"
                data-selected={selected}
                className="flex h-[52px] items-center justify-center rounded-xl p-[5px] hover:bg-black/[0.045] dark:hover:bg-white/[0.045] [&_svg]:h-auto [&_svg]:max-w-[44px] [&_svg]:w-full [&_svg]:overflow-visible"
                aria-pressed={selected}
                aria-label={shape.label}
                title={shape.label}
                key={shape.id}
                onClick={() => selectWisp({ shape: shape.id })}
              >
                <Wisp color={chat.color} name={chat.name} shape={shape.id} outlined={selected} aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <div
          className="mx-auto flex w-full max-w-[300px] flex-wrap justify-center gap-x-3.5 gap-y-4"
          role="group"
          data-slot="color-grid"
          aria-label="Wisp color"
        >
          {AVATAR_COLORS.map((color) => {
            const selected = !chat.avatarImage && chat.color?.toLowerCase() === color.value.toLowerCase();
            return (
              <button
                type="button"
                data-selected={selected}
                className="aspect-square w-[calc((100%-70px)/6)] max-w-8 flex-none rounded-full border-0 p-0 transition-transform duration-100 hover:scale-[1.08] data-[selected=true]:ring-2 data-[selected=true]:ring-ring data-[selected=true]:ring-offset-2 data-[selected=true]:ring-offset-card"
                aria-pressed={selected}
                aria-label={color.label}
                title={color.label}
                key={color.id}
                style={{ backgroundColor: color.value }}
                onClick={() => selectWisp({ color: color.value })}
              />
            );
          })}
        </div>
        <div className="mt-3.5 flex justify-center">
          <button
            className={cn(avatarAction, "mt-0 items-center gap-2 [&_svg]:size-3.5")}
            type="button"
            onClick={generateWisp}
          >
            <ShuffleIcon aria-hidden="true" />
            Random Wisp
          </button>
        </div>
        {chat.avatarImage ? (
          <p className="m-0 mt-3.5 text-dim text-sm">
            Choosing a shape, color, or random Wisp replaces the uploaded image.
          </p>
        ) : null}
      </section>
    </div>
  );
}

export { AvatarEditor };
