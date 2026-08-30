import { useEffect, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Tabs } from "@base-ui/react/tabs";
import { PencilIcon, ShuffleIcon, UploadIcon, XIcon } from "lucide-react";

import type { AgentSettings, Chat } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
import { AVATAR_COLORS, WISP_SHAPES, Wisp } from "@/components/wisp";

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
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    return canvas.toDataURL("image/webp", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface AvatarEditorProps {
  chat: Chat;
  onChange: (changes: Partial<AgentSettings>) => void;
}

function AvatarEditor({ chat, onChange }: AvatarEditorProps) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const uploadVersion = useRef(0);

  useEffect(() => () => { uploadVersion.current += 1; }, []);

  function selectWisp(changes: Partial<AgentSettings>) {
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
    <div className="avatar-editor-root">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger className="edit-avatar-button" aria-label="Edit avatar">
          <span className="editable-avatar"><ChatAvatar chat={chat} size="xl" /></span>
          <span className="avatar-edit-overlay" aria-hidden="true"><PencilIcon /></span>
          <span className="avatar-edit-tip">Edit Avatar</span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner className="avatar-editor-positioner" side="bottom" align="center" sideOffset={8} collisionPadding={12}>
            <Popover.Popup className="avatar-editor-sheet" aria-label="Avatar editor">
              <Tabs.Root defaultValue="wisp">
                <header className="avatar-editor-header">
                  <Tabs.List className="avatar-editor-tabs" aria-label="Avatar source" activateOnFocus>
                    <Tabs.Tab value="wisp">Wisp</Tabs.Tab>
                    <Tabs.Tab value="generate">Generate</Tabs.Tab>
                    <Tabs.Tab value="upload">Upload</Tabs.Tab>
                  </Tabs.List>
                  <Popover.Close className="icon-button" aria-label="Close avatar editor"><XIcon aria-hidden="true" /></Popover.Close>
                </header>
                <Tabs.Panel value="wisp" className="avatar-editor-body">
                  <div className="shape-grid" role="group" aria-label="Wisp shape">
                    {WISP_SHAPES.map((shape) => {
                      const selected = !chat.avatarImage && chat.shape === shape.id;
                      return (
                        <button type="button" data-selected={selected} aria-pressed={selected} aria-label={shape.label} title={shape.label} key={shape.id} onClick={() => selectWisp({ shape: shape.id })}>
                          <Wisp color={chat.color} name={chat.name} shape={shape.id} outlined={selected} aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                  <div className="color-grid" role="group" aria-label="Wisp color">
                    {AVATAR_COLORS.map((color) => {
                      const selected = !chat.avatarImage && chat.color?.toLowerCase() === color.value.toLowerCase();
                      return <button type="button" data-selected={selected} aria-pressed={selected} aria-label={color.label} title={color.label} key={color.id} style={{ backgroundColor: color.value }} onClick={() => selectWisp({ color: color.value })} />;
                    })}
                  </div>
                </Tabs.Panel>
                <Tabs.Panel value="generate" className="avatar-editor-alternative">
                  <ShuffleIcon aria-hidden="true" />
                  <strong>A fresh look for your Wisp</strong>
                  <p>Generate a random shape and color combination. AI image generation is not connected yet.</p>
                  <button className="avatar-action" type="button" onClick={generateWisp}>Generate Wisp</button>
                </Tabs.Panel>
                <Tabs.Panel value="upload" className="avatar-editor-alternative">
                  <UploadIcon aria-hidden="true" />
                  <strong>Upload an avatar</strong>
                  <p>PNG, JPG, or WebP, up to 5 MB. Images are cropped to a square and saved on this device.</p>
                  <label className="avatar-action avatar-upload-button" aria-disabled={uploading}>
                    {uploading ? "Processing…" : "Choose image"}
                    <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose avatar image" disabled={uploading} onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) void upload(file);
                    }} />
                  </label>
                  {chat.avatarImage ? <button className="avatar-reset" type="button" onClick={() => selectWisp({})}>Use Wisp avatar instead</button> : null}
                  {error ? <p className="avatar-error" role="alert">{error}</p> : null}
                </Tabs.Panel>
              </Tabs.Root>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

export { AvatarEditor };
