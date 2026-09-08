import type { ConnectionApi } from "../shared/connections";
import type { WispApi } from "../shared/contracts";

declare global {
  interface Window {
    readonly wisp: WispApi;
    readonly wispConnections?: ConnectionApi;
  }
}

export {};
