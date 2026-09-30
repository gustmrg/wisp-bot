import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";

// The sandboxed preload cannot import shared modules at runtime, so it keeps its
// own copy of the channel map. A rename on only one side would still compile but
// fail at runtime with "No handler registered"; this keeps the copies identical.
describe("preload IPC channel allowlist", () => {
  it("matches the shared channel contract exactly", async () => {
    const source = await readFile(path.resolve("electron/preload.ts"), "utf8");
    const block = /const WISP_IPC_CHANNELS = \{([\s\S]*?)\} as const;/.exec(source)?.[1];
    expect(block, "preload channel map not found").toBeDefined();
    const entries = [...block!.matchAll(/^\s*(\w+):\s*"([^"]+)",?\s*$/gm)].map(([, key, value]) => [key, value]);

    expect(Object.fromEntries(entries)).toEqual(WISP_IPC_CHANNELS);
    expect(entries).toHaveLength(Object.keys(WISP_IPC_CHANNELS).length);
  });
});
