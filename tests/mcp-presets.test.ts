import { describe, expect, it } from "vitest";

import {
  GITHUB_MCP_PRESET,
  GITLAB_MCP_PRESET,
  presetInstanceAddress,
  presetInstanceEndpoint,
  presetInstancePage,
} from "../shared/mcp-presets/index.js";

describe("preset instances", () => {
  it("puts the MCP path on the instance's address, keeping a path it is served under", () => {
    expect(presetInstanceEndpoint(GITLAB_MCP_PRESET, "https://gitlab.com")).toBe(GITLAB_MCP_PRESET.endpoint);
    expect(presetInstanceEndpoint(GITLAB_MCP_PRESET, " gitlab.example.com/ ")).toBe(
      "https://gitlab.example.com/api/v4/mcp",
    );
    expect(presetInstanceEndpoint(GITLAB_MCP_PRESET, "https://example.com:8443/gitlab/")).toBe(
      "https://example.com:8443/gitlab/api/v4/mcp",
    );
  });

  it("refuses addresses that are not plain URLs, and leaves the scheme for the server to check", () => {
    expect(presetInstanceEndpoint(GITLAB_MCP_PRESET, "")).toBeUndefined();
    expect(presetInstanceEndpoint(GITLAB_MCP_PRESET, "https://user:secret@gitlab.example.com")).toBeUndefined();
    expect(presetInstanceEndpoint(GITLAB_MCP_PRESET, "https://gitlab.example.com/?x=1")).toBeUndefined();
    expect(presetInstanceEndpoint(GITLAB_MCP_PRESET, "http://gitlab.example.com")).toBe(
      "http://gitlab.example.com/api/v4/mcp",
    );
  });

  it("reads the address back from a saved endpoint", () => {
    expect(presetInstanceAddress(GITLAB_MCP_PRESET, "https://example.com/gitlab/api/v4/mcp")).toBe(
      "https://example.com/gitlab",
    );
  });

  it("moves the token page to the instance, or keeps the hosted one", () => {
    const hosted = "https://gitlab.com/-/user_settings/personal_access_tokens";
    expect(presetInstancePage(GITLAB_MCP_PRESET, "gitlab.example.com", hosted)).toBe(
      "https://gitlab.example.com/-/user_settings/personal_access_tokens",
    );
    expect(presetInstancePage(GITLAB_MCP_PRESET, "not a url", "https://gitlab.com/x")).toBe("https://gitlab.com/x");
  });

  it("keeps the endpoint of a preset without instances", () => {
    expect(presetInstanceEndpoint(GITHUB_MCP_PRESET, "https://example.com")).toBe(GITHUB_MCP_PRESET.endpoint);
  });
});
