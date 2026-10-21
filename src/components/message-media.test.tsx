import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackendResult, WispApi } from "../../shared/contracts";
import type { ConversationMedia, ReadConversationMediaRequest } from "../../shared/media";
import { MessageView } from "@/components/message-view";

type Reader = (request: ReadConversationMediaRequest) => Promise<BackendResult<ConversationMedia>>;

function useReader(reader: Reader) {
  const readConversationMedia = vi.fn(reader);
  (window as unknown as { wisp: Partial<WispApi> }).wisp = { readConversationMedia };
  return readConversationMedia;
}

const file = (name: string, mimeType: string, text = "bytes"): BackendResult<ConversationMedia> => ({
  ok: true,
  value: { name, mimeType, bytes: new TextEncoder().encode(text) },
});

function reply(text: string, status: "complete" | "streaming" = "complete") {
  return render(<MessageView conversationId="atlas" message={{ id: "reply-1", type: "incoming", text, status }} />);
}

beforeEach(() => {
  let count = 0;
  URL.createObjectURL = vi.fn(() => `blob:media-${++count}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  delete (window as unknown as { wisp?: unknown }).wisp;
});

describe("files in a Wisp's reply", () => {
  it("shows an image the reply refers to, fetched for that message", async () => {
    const read = useReader(async () => file("page.jpg", "image/jpeg"));
    reply('The page:\n<media src="browser-screenshots/page.jpg" />');

    const image = await screen.findByRole("img", { name: "page.jpg" });
    expect(image.getAttribute("src")).toMatch(/^blob:media-/);
    expect(read).toHaveBeenCalledWith({
      conversationId: "atlas",
      messageId: "reply-1",
      path: "browser-screenshots/page.jpg",
      maxBytes: 16 * 1024 * 1024,
    });
  });

  it("waits for a reply to be stored before fetching its files", () => {
    const read = useReader(async () => file("page.jpg", "image/jpeg"));
    reply("![](page.jpg)", "streaming");
    expect(read).not.toHaveBeenCalled();
  });

  it("plays audio and video", async () => {
    useReader(async (request) =>
      request.path.endsWith(".mp3") ? file("song.mp3", "audio/mpeg") : file("clip.mp4", "video/mp4"),
    );
    const { container } = reply("![](song.mp3)\n\n![](clip.mp4)");
    await waitFor(() => expect(container.querySelector("audio")?.getAttribute("src")).toMatch(/^blob:/));
    expect(container.querySelector("video")?.getAttribute("src")).toMatch(/^blob:/);
  });

  it("says when a file cannot be loaded, and tries again", async () => {
    const read = useReader(async () => ({
      ok: false,
      error: { code: "not_found", message: "The file is no longer in the workspace.", retryable: false },
    }));
    reply("![](gone.png)");

    expect(await screen.findByText("gone.png could not be loaded")).toBeTruthy();
    expect(screen.getByText("The file is no longer in the workspace.")).toBeTruthy();
    read.mockImplementation(async () => file("gone.png", "image/png"));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("img", { name: "gone.png" })).toBeTruthy();
  });

  it("offers a file too large to show as a download", async () => {
    const read = useReader(async (request) =>
      request.maxBytes === 16 * 1024 * 1024
        ? { ok: false, error: { code: "too_large", message: "This file is 20 MiB.", retryable: false } }
        : file("huge.png", "image/png"),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    reply("![](huge.png)");

    await userEvent.click(await screen.findByRole("button", { name: "Download huge.png" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ maxBytes: 512 * 1024 * 1024 }));
  });

  it("opens an HTML file in a sandboxed preview that gets the document from the app", async () => {
    useReader(async () => file("report.html", "text/html", "<h1>Report</h1>"));
    reply('<media src="/workspace/report.html" />');

    expect(screen.getByText("HTML page")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const frame = await waitFor(() => document.querySelector("iframe")!);
    expect(frame.title).toBe("report.html");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-popups allow-popups-to-escape-sandbox");
    expect(frame.getAttribute("src")).toBe("/media-preview.html");

    const post = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "wisp-preview-ready" }, source: frame.contentWindow }),
    );
    expect(post).toHaveBeenCalledWith({ type: "wisp-preview", html: "<h1>Report</h1>" }, "*");
    // A page a link opened in the frame later never gets the document.
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "wisp-preview-ready" }, source: frame.contentWindow }),
    );
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("shows a Markdown file formatted", async () => {
    useReader(async () => file("notes.md", "text/markdown", "# Plan\n\n- **first**"));
    reply("![](notes.md)");

    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(screen.getByText("first").tagName).toBe("STRONG");
  });

  it("leaves web images and code examples as they are", () => {
    const read = useReader(async () => file("x.png", "image/png"));
    const { container } = reply('![logo](https://example.com/logo.png)\n\n`<media src="x.png" />`');
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/logo.png");
    expect(screen.getByText('<media src="x.png" />')).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });
});
