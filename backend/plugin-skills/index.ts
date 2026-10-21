import type { McpPresetId } from "../../shared/mcp-presets/index.js";
import type { IntegrationSkill } from "../integration-tool-source.js";
import { ATLASSIAN_SKILL } from "./atlassian.js";
import { GITHUB_SKILL } from "./github.js";
import { GITLAB_SKILL } from "./gitlab.js";

/** The skill each MCP plugin brings to the Wisps that can use its connection. */
export const PLUGIN_SKILLS: Readonly<Record<McpPresetId, IntegrationSkill>> = {
  github: GITHUB_SKILL,
  gitlab: GITLAB_SKILL,
  atlassian: ATLASSIAN_SKILL,
};
