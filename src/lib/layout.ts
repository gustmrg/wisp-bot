import type { CSSProperties } from "react";

interface ResizablePanelLayout {
  readonly defaultWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly direction: 1 | -1;
}

type SidebarLayoutStyle = CSSProperties & {
  "--sidebar-width": string;
  "--sidebar-min-width": string;
  "--sidebar-mobile-expanded-width": string;
};

type DetailsLayoutStyle = CSSProperties & {
  "--details-width": string;
  "--details-min-width": string;
};

const SIDEBAR_LAYOUT = {
  resize: {
    defaultWidth: 280,
    minWidth: 220,
    maxWidth: 400,
    direction: 1,
  },
  responsive: {
    collapsedWidth: 68,
    mobileExpandedWidth: 220,
  },
} as const satisfies {
  readonly resize: ResizablePanelLayout;
  readonly responsive: {
    readonly collapsedWidth: number;
    readonly mobileExpandedWidth: number;
  };
};

const DETAILS_LAYOUT = {
  resize: {
    defaultWidth: 318,
    minWidth: 280,
    maxWidth: 480,
    direction: -1,
  },
} as const satisfies {
  readonly resize: ResizablePanelLayout;
};

function sidebarLayoutStyle(width: number, collapsed: boolean): SidebarLayoutStyle {
  return {
    "--sidebar-width": `${collapsed ? SIDEBAR_LAYOUT.responsive.collapsedWidth : width}px`,
    "--sidebar-min-width": `${SIDEBAR_LAYOUT.responsive.collapsedWidth}px`,
    "--sidebar-mobile-expanded-width": `${SIDEBAR_LAYOUT.responsive.mobileExpandedWidth}px`,
  };
}

function detailsLayoutStyle(width: number): DetailsLayoutStyle {
  return {
    "--details-width": `${width}px`,
    "--details-min-width": `${DETAILS_LAYOUT.resize.minWidth}px`,
  };
}

export { DETAILS_LAYOUT, SIDEBAR_LAYOUT, detailsLayoutStyle, sidebarLayoutStyle };
export type { ResizablePanelLayout };
