import { describe, expect, it } from "vitest";

import { mcpToolAlias } from "../shared/mcp.js";
import { humanizeToolName, toolDisplayLabel } from "../shared/tool-catalog.js";

describe("humanizeToolName", () => {
  it.each([
    ["getEntry", "Get entry"],
    ["get_entry", "Get entry"],
    ["search.users", "Search users"],
    ["list-items", "List items"],
    ["getHTTPStatus", "Get HTTP status"],
    ["URLFetch", "URL fetch"],
    ["v2Search", "V2 search"],
    ["GITHUB_GET_ME", "Github get me"],
    ["search", "Search"],
  ])("reads %s as %s", (name, words) => {
    expect(humanizeToolName(name)).toBe(words);
  });

  it("keeps a name with no words in it", () => {
    expect(humanizeToolName("___")).toBe("___");
  });
});

describe("toolDisplayLabel", () => {
  it("prefers the catalog's label, then the alias, then the name in words", () => {
    expect(toolDisplayLabel("linear_create_issue")).toBe("Create Linear issue");
    expect(toolDisplayLabel(mcpToolAlias("server-a", "create_issue"))).toBe("Create issue");
    expect(toolDisplayLabel("getEntry")).toBe("Get entry");
  });
});
