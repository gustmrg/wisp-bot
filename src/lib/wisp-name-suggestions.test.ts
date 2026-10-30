import { describe, expect, it } from "vitest";

import { WISP_NAME_MAX_LENGTH } from "../../shared/conversations";
import { suggestWispName, WISP_NAME_SUGGESTIONS } from "@/lib/wisp-name-suggestions";

describe("Wisp name suggestions", () => {
  it("lists distinct names that fit the name field", () => {
    const lower = WISP_NAME_SUGGESTIONS.map((name) => name.toLowerCase());
    expect(new Set(lower).size).toBe(WISP_NAME_SUGGESTIONS.length);
    for (const name of WISP_NAME_SUGGESTIONS) {
      expect(name.trim()).toBe(name);
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(WISP_NAME_MAX_LENGTH);
    }
  });

  it("never suggests the name already in the field", () => {
    for (const current of WISP_NAME_SUGGESTIONS) {
      for (const draw of [0, 0.5, 0.999]) {
        expect(suggestWispName(current, () => draw)).not.toBe(current);
        expect(suggestWispName(` ${current.toUpperCase()} `, () => draw).toLowerCase()).not.toBe(current.toLowerCase());
      }
    }
  });

  it("suggests any listed name when the field holds something else", () => {
    expect(suggestWispName("", () => 0)).toBe(WISP_NAME_SUGGESTIONS[0]);
    expect(suggestWispName("Ada", () => 0.999)).toBe(WISP_NAME_SUGGESTIONS.at(-1));
  });
});
