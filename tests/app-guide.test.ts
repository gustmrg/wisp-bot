import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { APP_GUIDE_TOPICS } from "../backend/app-guide-content.js";
import { APP_GUIDE_INSTRUCTIONS, APP_GUIDE_TOOL, createAppGuideTool } from "../backend/app-guide.js";
import { GUIDE_MODULE, readGuideTopics, renderGuideModule } from "../scripts/build-app-guide.mjs";
import { APP_SETTINGS_SECTIONS, WISP_SETTINGS_SECTIONS, appLinkHref, parseAppLink } from "../shared/app-links.js";
import { BUILTIN_TOOL_NAMES } from "../shared/tool-catalog.js";

const links = APP_GUIDE_TOPICS.flatMap((topic) =>
  [...topic.body.matchAll(/\]\((wisp:[^)\s]*)\)/g)].map((match) => ({ topic: topic.id, href: match[1]! })),
);

describe("app links", () => {
  it("parses the settings panels and the pages of a Wisp's settings", () => {
    expect(parseAppLink("wisp://settings/model")).toEqual({ scope: "settings", section: "model" });
    expect(parseAppLink("wisp://settings/remote-access/")).toEqual({ scope: "settings", section: "remote-access" });
    expect(parseAppLink("wisp://wisp/skills")).toEqual({ scope: "wisp", section: "skills" });
    for (const section of APP_SETTINGS_SECTIONS) {
      expect(parseAppLink(appLinkHref({ scope: "settings", section }))).toEqual({ scope: "settings", section });
    }
  });

  it("rejects anything else", () => {
    for (const href of [
      "wisp://settings/unknown",
      "wisp://wisp/general",
      "wisp://settings",
      "wisp://other/model",
      "wisp://settings/model?x=1",
      "https://settings/model",
      "javascript:alert(1)",
    ]) {
      expect(parseAppLink(href), href).toBeNull();
    }
  });
});

describe("app guide", () => {
  it("is generated from docs/guide", async () => {
    expect(await readFile(GUIDE_MODULE, "utf8")).toBe(renderGuideModule(await readGuideTopics()));
  });

  it("only links to screens that exist", () => {
    expect(links.length).toBeGreaterThan(0);
    for (const { topic, href } of links) expect(parseAppLink(href), `${topic}: ${href}`).not.toBeNull();
  });

  it("links every settings panel and every page of a Wisp's settings", () => {
    const linked = new Set(links.map(({ href }) => href));
    for (const section of APP_SETTINGS_SECTIONS) expect(linked).toContain(appLinkHref({ scope: "settings", section }));
    for (const section of WISP_SETTINGS_SECTIONS) expect(linked).toContain(appLinkHref({ scope: "wisp", section }));
  });

  it("starts with the overview and gives every topic a title and summary", () => {
    expect(APP_GUIDE_TOPICS[0]?.id).toBe("overview");
    for (const topic of APP_GUIDE_TOPICS) {
      expect(topic.id).toMatch(/^[a-z-]+$/);
      expect(topic.title).not.toBe("");
      expect(topic.summary).not.toBe("");
      expect(topic.body).not.toBe("");
    }
  });
});

describe("wisp_help", () => {
  const tool = createAppGuideTool();

  it("is a tool every Wisp has, named in the system prompt", () => {
    expect(BUILTIN_TOOL_NAMES).toContain(APP_GUIDE_TOOL);
    expect(APP_GUIDE_INSTRUCTIONS).toContain(APP_GUIDE_TOOL);
  });

  it("lists every topic with its summary", () => {
    expect(tool.parameters.properties.topic.enum).toEqual(APP_GUIDE_TOPICS.map((topic) => topic.id));
    for (const topic of APP_GUIDE_TOPICS) expect(tool.description).toContain(`- ${topic.id}: ${topic.summary}`);
  });

  it("returns a topic's guide page", async () => {
    const topic = APP_GUIDE_TOPICS.find(({ id }) => id === "skills")!;
    await expect(tool.execute("call-1", { topic: "skills" })).resolves.toEqual({
      content: [{ type: "text", text: topic.body }],
      details: {},
    });
  });

  it("answers an unknown topic with the list of topics", async () => {
    const result = await tool.execute("call-2", { topic: "billing" });
    expect(result.content[0]?.text).toContain('No guide topic named "billing"');
    expect(result.content[0]?.text).toContain("- overview:");
  });
});
