import type { WispApi } from "../shared/contracts";

declare global {
  interface Window {
    readonly wisp: WispApi;
  }
}

export {};
