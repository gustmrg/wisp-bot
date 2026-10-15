import type { ToolMetadata } from "../tool-catalog.js";

/** Display and policy metadata a bundled plugin tool declares; plugin ownership is added by the catalog. */
export type PluginToolMetadata = Pick<ToolMetadata, "name" | "label" | "activityLabel" | "category">;
