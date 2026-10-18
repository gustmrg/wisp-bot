import type { PluginToolMetadata } from "./types.js";

export const HOME_ASSISTANT_TOOL_METADATA = {
  listEntities: {
    name: "home_assistant_list_entities",
    label: "List Home Assistant devices",
    activityLabel: "Looking at your home…",
    category: "search",
  },
  getState: {
    name: "home_assistant_get_state",
    label: "Read Home Assistant device",
    activityLabel: "Checking a device…",
    category: "read",
  },
  getHistory: {
    name: "home_assistant_get_history",
    label: "Read Home Assistant history",
    activityLabel: "Reading device history…",
    category: "read",
  },
  control: {
    name: "home_assistant_control",
    label: "Control Home Assistant device",
    activityLabel: "Controlling a device…",
    category: "external_write",
  },
  controlSecure: {
    name: "home_assistant_control_secure",
    label: "Control lock, alarm, or door",
    activityLabel: "Controlling a lock, alarm, or door…",
    category: "external_write",
  },
  runScene: {
    name: "home_assistant_run_scene",
    label: "Activate Home Assistant scene",
    activityLabel: "Activating a scene…",
    category: "external_write",
  },
  runScript: {
    name: "home_assistant_run_script",
    label: "Run Home Assistant script",
    activityLabel: "Running a script…",
    category: "external_write",
  },
} as const satisfies Record<string, PluginToolMetadata>;
