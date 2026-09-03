import { describe, expect, it } from "vitest";

import { DETAILS_LAYOUT, SIDEBAR_LAYOUT, detailsLayoutStyle, sidebarLayoutStyle } from "@/lib/layout";

describe("panel layout", () => {
  it("keeps draggable and responsive sidebar dimensions separate", () => {
    expect(SIDEBAR_LAYOUT).toEqual({
      resize: { defaultWidth: 280, minWidth: 220, maxWidth: 400, direction: 1 },
      responsive: { collapsedWidth: 68, mobileExpandedWidth: 220 },
    });
  });

  it("exposes the panel dimensions as CSS custom properties", () => {
    expect(sidebarLayoutStyle(340, false)).toEqual({
      "--sidebar-width": "340px",
      "--sidebar-min-width": "68px",
      "--sidebar-mobile-expanded-width": "220px",
    });
    expect(sidebarLayoutStyle(340, true)["--sidebar-width"]).toBe("68px");
    expect(detailsLayoutStyle(360)).toEqual({
      "--details-width": "360px",
      "--details-min-width": "280px",
    });
    expect(DETAILS_LAYOUT.resize).toEqual({ defaultWidth: 318, minWidth: 280, maxWidth: 480, direction: -1 });
  });
});
