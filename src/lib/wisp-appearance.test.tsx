import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_WISP_APPEARANCE,
  WISP_APPEARANCE_AXES,
  WISP_COLORS,
  nearestWispColor,
  type WispAppearance,
} from "../../shared/wisp-appearance";
import { Wisp } from "@/components/wisp";
import {
  AVATAR_COLORS,
  appearanceOptions,
  contrastRatio,
  hashSeed,
  iconFill,
  isNeutralColor,
  luminance,
  randomAppearance,
  wispAccent,
  wispColor,
  wispPalette,
} from "@/lib/wisp-appearance";

const AXES = Object.keys(WISP_APPEARANCE_AXES) as Array<keyof WispAppearance>;

describe("Wisp appearance registry", () => {
  it("labels every option of every axis exactly once", () => {
    for (const axis of AXES) {
      const values = appearanceOptions(axis).map(({ value }) => value);
      expect(values).toEqual(WISP_APPEARANCE_AXES[axis]);
      expect(appearanceOptions(axis).every(({ label }) => label.length > 0)).toBe(true);
    }
  });

  it("renders every option at every size and in every state", () => {
    for (const axis of AXES) {
      for (const value of WISP_APPEARANCE_AXES[axis]) {
        for (const size of ["sm", "default", "lg", "xl"] as const) {
          for (const state of ["idle", "working", "approval", "error"] as const) {
            const { container, unmount } = render(
              <Wisp appearance={{ ...DEFAULT_WISP_APPEARANCE, [axis]: value }} size={size} state={state} />,
            );
            expect(container.querySelector("svg")).toHaveAttribute("data-state", state);
            unmount();
          }
        }
      }
    }
  });

  it("drops the mark and fills in the outline where they would not survive", () => {
    const appearance: WispAppearance = { ...DEFAULT_WISP_APPEARANCE, finish: "line", mark: "spark" };
    const small = render(<Wisp appearance={appearance} size="sm" />).container;
    expect(small.querySelector("mask[id$='-line']")).toBeNull();
    expect(small.querySelectorAll("path[d^='M0-10']")).toHaveLength(0);
    const large = render(<Wisp appearance={appearance} size="xl" />).container;
    expect(large.querySelector("mask[id$='-line']")).not.toBeNull();
    expect(large.querySelectorAll("path[d^='M0-10']")).toHaveLength(1);
  });

  it("preserves the product avatar palette", () => {
    expect(AVATAR_COLORS.map(({ value }) => value)).toEqual([
      "#262626",
      "#ff3b30",
      "#ed712e",
      "#f19d38",
      "#54b9a6",
      "#3c82f6",
      "#6464ef",
      "#885cf5",
      "#e5498f",
      "#8e8e8e",
      "#f2f2f2",
    ]);
  });

  it("moves colors from before the palette to the closest palette color", () => {
    expect(nearestWispColor("#3d83f7")).toBe("#3c82f6");
    expect(nearestWispColor("#000000")).toBe("#262626");
    expect(nearestWispColor("#ffffff")).toBe("#f2f2f2");
    expect(nearestWispColor("blue")).toBeUndefined();
  });

  it("derives a soft tone that is lighter than the vivid one", () => {
    for (const { value } of WISP_COLORS) {
      expect(luminance(wispPalette(value, "soft").base)).toBeGreaterThan(luminance(wispPalette(value, "vivid").base));
    }
  });

  it("rings a body only in the theme whose background would swallow it", () => {
    expect(wispPalette("#262626", "vivid").ring).toMatch(/^light-dark\(transparent, #/);
    expect(wispPalette("#f2f2f2", "vivid").ring).toMatch(/^light-dark\(#[0-9a-f]{6}, transparent\)$/);
    expect(wispPalette("#f2f2f2", "soft").ring).not.toBeNull();
    for (const color of ["#3c82f6", "#8e8e8e", "#f19d38"]) {
      expect(wispPalette(color, "vivid").ring).toBeNull();
      expect(wispPalette(color, "soft").ring).toBeNull();
    }
  });

  it("darkens a white Wisp's marks in the light theme only", () => {
    const white = wispPalette("#f2f2f2", "vivid");
    expect(white.marks.spark).toBe(`light-dark(${white.deep}, ${white.light})`);
    expect(white.marks.motes).toBe(`light-dark(${white.deep}, ${white.base})`);
    const blue = wispPalette("#3c82f6", "vivid");
    expect(blue.marks).toEqual({ spark: blue.light, motes: blue.base });
  });

  it("keeps a face on every body, even when the chosen eye color would vanish into it", () => {
    for (const { value } of WISP_COLORS) {
      for (const tone of WISP_APPEARANCE_AXES.tone) {
        const palette = wispPalette(value, tone);
        for (const ink of WISP_APPEARANCE_AXES.eyeInk) {
          expect(contrastRatio(palette.eyes[ink], palette.base)).toBeGreaterThanOrEqual(1.2);
        }
      }
    }
    const white = wispPalette("#f2f2f2", "vivid");
    expect(white.eyes.light).toBe(white.eyes.dark);
    expect(contrastRatio(white.eyes.auto, white.base)).toBeGreaterThan(7);
    const blue = wispPalette("#3c82f6", "vivid");
    expect(blue.eyes.light).toBe("#f7fbff");
    expect(blue.eyes.dark).not.toBe(blue.eyes.light);
  });

  it("lifts a near-black Wisp's accent in the dark theme, where its glow would not show", () => {
    expect(wispAccent("#3c82f6")).toEqual({ accent: "#3c82f6", ink: "#ffffff" });
    expect(wispAccent("#262626")).toEqual({
      accent: "light-dark(#262626, #a8a8a8)",
      ink: "light-dark(#ffffff, #111111)",
    });
  });

  it("deepens a near-white Wisp's accent in the light theme, where it would not show", () => {
    const { accent, ink } = wispAccent("#f2f2f2");
    expect(accent).toMatch(/^light-dark\(#[0-9a-f]{6}, #f2f2f2\)$/);
    const deepened = accent.slice("light-dark(".length, accent.indexOf(","));
    expect(contrastRatio(deepened, "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(ink).toBe("light-dark(#ffffff, #111111)");
  });

  it("keeps the color a name derives, now that the palette has white", () => {
    const before = WISP_COLORS.slice(
      0,
      WISP_COLORS.findIndex((color) => color.id === "white"),
    );
    for (const name of ["Ada", "Juno", "Sumi", "agent", "Research helper", "Wisp 12"]) {
      expect(wispColor(name)).toBe(before[hashSeed(name) % before.length]?.value);
    }
  });

  it("gives every palette color a fill a white icon reads on, deepening only the light ones", () => {
    for (const { value } of WISP_COLORS) expect(contrastRatio(iconFill(value), "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(iconFill("#3c82f6")).toBe("#3c82f6");
    expect(iconFill("#885cf5")).toBe("#885cf5");
    expect(luminance(iconFill("#f19d38"))).toBeLessThan(luminance("#f19d38"));
    expect(luminance(iconFill("#54b9a6"))).toBeLessThan(luminance("#54b9a6"));
  });

  it("tells the grays of the palette from its hues", () => {
    expect(WISP_COLORS.filter((color) => isNeutralColor(color.value)).map((color) => color.id)).toEqual([
      "charcoal",
      "gray",
      "white",
    ]);
  });

  it("generates appearances from the axes and the palette", () => {
    let seed = 0;
    const random = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    for (let index = 0; index < 50; index += 1) {
      const { appearance, color } = randomAppearance(random);
      for (const axis of AXES) expect(WISP_APPEARANCE_AXES[axis]).toContain(appearance[axis]);
      expect(WISP_COLORS.map(({ value }) => value)).toContain(color);
      expect(appearance.eyeInk).toBe("auto");
    }
  });
});
