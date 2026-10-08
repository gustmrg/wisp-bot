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
import { AVATAR_COLORS, appearanceOptions, luminance, randomAppearance, wispPalette } from "@/lib/wisp-appearance";

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
    ]);
  });

  it("moves colors from before the palette to the closest palette color", () => {
    expect(nearestWispColor("#3d83f7")).toBe("#3c82f6");
    expect(nearestWispColor("#000000")).toBe("#262626");
    expect(nearestWispColor("blue")).toBeUndefined();
  });

  it("derives a soft tone that is lighter than the vivid one, and rings only near-black bodies", () => {
    for (const { value } of WISP_COLORS) {
      expect(luminance(wispPalette(value, "soft").base)).toBeGreaterThan(luminance(wispPalette(value, "vivid").base));
    }
    expect(wispPalette("#262626", "vivid").needsRing).toBe(true);
    expect(wispPalette("#3c82f6", "vivid").needsRing).toBe(false);
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
