import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WISP_SHAPE_IDS } from "../../shared/conversations";
import { Wisp } from "@/components/wisp";
import { AVATAR_COLORS, WISP_SHAPES } from "@/lib/wisp-appearance";

describe("Wisp appearance registry", () => {
  it("exposes every shared shape, including diamond, exactly once", () => {
    const registeredIds = WISP_SHAPES.map(({ id }) => id);

    expect(registeredIds).toEqual(WISP_SHAPE_IDS);
    expect(new Set(registeredIds).size).toBe(registeredIds.length);
    expect(registeredIds).toContain("diamond");
  });

  it("renders every registered shape", () => {
    for (const { id } of WISP_SHAPES) {
      const { unmount } = render(<Wisp aria-label={id} shape={id} />);
      unmount();
    }
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
});
