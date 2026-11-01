import { describe, expect, it } from "vitest";

import { DETAILS_LAYOUT, SIDEBAR_LAYOUT, detailsLayoutStyle, sidebarLayoutStyle } from "@/lib/layout";

describe("panel layout", () => {
  it("keeps the draggable sidebar dimensions", () => {
    expect(SIDEBAR_LAYOUT).toEqual({
      resize: { defaultWidth: 280, minWidth: 220, maxWidth: 400, direction: 1, cssVariable: "--sidebar-width" },
    });
  });

  it("exposes the panel dimensions as CSS custom properties", () => {
    expect(sidebarLayoutStyle(340)).toEqual({ "--sidebar-width": "340px" });
    expect(detailsLayoutStyle(360)).toEqual({
      "--details-width": "360px",
      "--details-min-width": "280px",
    });
    expect(DETAILS_LAYOUT.resize).toEqual({
      defaultWidth: 400,
      minWidth: 280,
      maxWidth: 480,
      direction: -1,
      cssVariable: "--details-width",
    });
  });
});
