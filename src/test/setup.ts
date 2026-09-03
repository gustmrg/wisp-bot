import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

class MatchMediaMock implements MediaQueryList {
  readonly matches = false;
  readonly media: string;
  readonly onchange = null;

  constructor(media: string) {
    this.media = media;
  }

  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  addListener = vi.fn();
  removeListener = vi.fn();
  dispatchEvent = vi.fn(() => true);
}

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => new MatchMediaMock(query),
});

Object.defineProperty(window, "scrollTo", {
  configurable: true,
  value: vi.fn(),
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
});
