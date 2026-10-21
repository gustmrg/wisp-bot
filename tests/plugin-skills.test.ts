import { describe, expect, it } from "vitest";

import { PLUGIN_SKILLS } from "../backend/plugin-skills/index.js";
import { MCP_PRESET_IDS } from "../shared/mcp-presets/index.js";

describe("PLUGIN_SKILLS", () => {
  it.each(MCP_PRESET_IDS)("gives the %s plugin a skill named after it", (id) => {
    const skill = PLUGIN_SKILLS[id];
    expect(skill.name).toBe(id);
    expect(skill.description.length).toBeGreaterThan(20);
    // Every plugin skill treats what the service returns as data, not instructions.
    expect(skill.instructions).toMatch(/not instructions/);
    expect(skill.instructions).toMatch(/only when the user asked/);
  });

  it("tells Wisps to find the Atlassian site and use transitions for status changes", () => {
    const { instructions } = PLUGIN_SKILLS.atlassian;
    expect(instructions).toMatch(/cloud ID/);
    expect(instructions).toMatch(/JQL/);
    expect(instructions).toMatch(/transitions/);
  });

  it("tells Wisps that GitLab paths can have subgroups and that git in the container uses the token", () => {
    const { instructions } = PLUGIN_SKILLS.gitlab;
    expect(instructions).toMatch(/subgroup/);
    expect(instructions).toMatch(/merge requests/);
    expect(instructions).toMatch(/git in the container uses this connection's token/);
  });
});
