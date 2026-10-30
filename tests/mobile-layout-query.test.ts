import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { MOBILE_LAYOUT_QUERY } from "../src/hooks/use-mobile-layout";

/** The opposite of the mobile layout's query, for the rules that only apply outside it. */
const DESKTOP_LAYOUT_QUERY = "(min-width: 761px) and (min-device-width: 600px) and (min-device-height: 600px)";

/** The conditions of a stylesheet's `@media` rules that mention the layout's width. */
async function layoutConditions(file: string): Promise<string[]> {
  const css = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
  return [...css.matchAll(/@media ([^{]*\b76[01]px[^{]*?) *\{/g)].flatMap(([, condition]) => condition ?? []);
}

describe("the mobile layout's query", () => {
  it.each(["mobile.css", "aura.css"])("is the one %s uses, so a phone never gets half of each layout", async (file) => {
    const conditions = await layoutConditions(file);

    expect(conditions).not.toHaveLength(0);
    for (const condition of conditions) expect([MOBILE_LAYOUT_QUERY, DESKTOP_LAYOUT_QUERY]).toContain(condition);
  });

  it("looks at the screen's two sides, not the window's height, which the keyboard changes", () => {
    expect(MOBILE_LAYOUT_QUERY).toContain("max-device-width");
    expect(MOBILE_LAYOUT_QUERY).toContain("max-device-height");
    expect(MOBILE_LAYOUT_QUERY).not.toMatch(/max-height/);
  });
});
