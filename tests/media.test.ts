import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  MEDIA_PREVIEW_CONTENT_SECURITY_POLICY,
  isWorkspaceMediaPath,
  mediaKind,
  mediaName,
  normalizeMediaPath,
  referencedMediaPaths,
  withMediaImages,
} from "../shared/media.js";

describe("media references", () => {
  it("writes media tags as Markdown images, outside code", () => {
    expect(withMediaImages("Here:\n<media src=\"charts/sales q1.png\" />\nand <media src='a.mp3'></media>")).toBe(
      "Here:\n![](<charts/sales q1.png>)\nand ![](<a.mp3>)",
    );
    expect(withMediaImages('Use `<media src="x.png" />` like this.')).toBe('Use `<media src="x.png" />` like this.');
    expect(withMediaImages('```\n<media src="x.png" />\n```')).toBe('```\n<media src="x.png" />\n```');
  });

  it("finds the workspace paths a message shows, in one spelling", () => {
    const text = [
      '<media src="/workspace/report.html" />',
      "![chart](./charts/sales%20q1.png)",
      '![](<notes/read me.md> "Notes")',
      "![remote](https://example.com/a.png)",
      "![inline](data:image/png;base64,AAAA)",
      "`![](hidden.png)`",
    ].join("\n");
    expect([...referencedMediaPaths(text)]).toEqual(["report.html", "charts/sales q1.png", "notes/read me.md"]);
  });

  it("tells workspace paths from addresses and names files by kind", () => {
    expect(isWorkspaceMediaPath("shots/a.jpg")).toBe(true);
    expect(isWorkspaceMediaPath("/workspace/a.jpg")).toBe(true);
    expect(isWorkspaceMediaPath("https://example.com/a.jpg")).toBe(false);
    expect(isWorkspaceMediaPath("//example.com/a.jpg")).toBe(false);
    expect(isWorkspaceMediaPath("javascript:alert(1)")).toBe(false);
    expect(normalizeMediaPath("/workspace/a//b.png")).toBe("a/b.png");
    expect(mediaName("a/b/c.PNG")).toBe("c.PNG");
    expect(mediaKind("c.PNG")).toBe("image");
    expect(mediaKind("song.mp3")).toBe("audio");
    expect(mediaKind("clip.webm")).toBe("video");
    expect(mediaKind("page.htm")).toBe("html");
    expect(mediaKind("README.md")).toBe("markdown");
    expect(mediaKind("data.parquet")).toBe("file");
  });

  it("gives the preview page the policy it is served with", async () => {
    const pages = await Promise.all(
      ["../public/media-preview.html", "../web/public/media-preview.html"].map((file) =>
        readFile(new URL(file, import.meta.url), "utf8"),
      ),
    );
    expect(pages[0]).toBe(pages[1]);
    expect(pages[0]).toContain(`content="${MEDIA_PREVIEW_CONTENT_SECURITY_POLICY}"`);
    expect(MEDIA_PREVIEW_CONTENT_SECURITY_POLICY).toContain("connect-src 'none'");
    expect(MEDIA_PREVIEW_CONTENT_SECURITY_POLICY).toContain("form-action 'none'");
  });
});
