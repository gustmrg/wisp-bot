import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseServerConfig } from "../../server/config.js";

describe("parseServerConfig", () => {
  it("defaults to loopback, port 8787, and the Pi runtime", () => {
    expect(parseServerConfig([], { HOME: "/home/me" })).toMatchObject({
      host: "127.0.0.1",
      port: 8787,
      agentMode: "pi",
      allowExternalBind: false,
      web: false,
    });
  });

  it("serves the browser app only when asked to", () => {
    expect(parseServerConfig([], { WISP_WEB: "1" }).web).toBe(true);
    expect(parseServerConfig([], { WISP_WEB: "0" }).web).toBe(false);
    expect(parseServerConfig(["--web"], {}).web).toBe(true);
  });

  it("prefers flags over environment variables", () => {
    const config = parseServerConfig(["--port", "9000", "--data-dir", "relative", "--allow-external-bind"], {
      WISP_PORT: "8000",
      WISP_DATA_DIR: "/srv/wisp",
      WISP_MASTER_KEY_FILE: "/etc/wisp/key",
      WISP_PUBLIC_ORIGIN: "https://wisp.example.ts.net",
    });
    expect(config).toMatchObject({
      port: 9000,
      dataDirectory: path.resolve("relative"),
      keyFile: "/etc/wisp/key",
      publicOrigin: "https://wisp.example.ts.net",
      allowExternalBind: true,
    });
  });

  it("rejects unknown options and invalid values", () => {
    expect(() => parseServerConfig(["--verbose"], {})).toThrow(/Unknown/);
    expect(() => parseServerConfig(["--port"], {})).toThrow(/incomplete/);
    expect(() => parseServerConfig(["--port", "70000"], {})).toThrow(/port/);
    expect(() => parseServerConfig([], { WISP_AGENT_MODE: "real" })).toThrow(/agent mode/);
  });
});
