import type { PluginAdapter } from "../plugin-types.js";
import { webSearch } from "./brave.js";
import { exa } from "./exa.js";
import { gmail } from "./gmail.js";
import { googleCalendar } from "./google-calendar.js";
import { googleDrive } from "./google-drive.js";
import { homeAssistant } from "./home-assistant.js";
import { firecrawl } from "./firecrawl.js";
import { linear } from "./linear.js";
import { tavily } from "./tavily.js";

// Shared web tools choose the first enabled, configured and granted adapter.
// Preserve the existing Brave/Firecrawl priority when adding more providers.
export const PLUGIN_ADAPTERS: ReadonlyArray<PluginAdapter> = [
  webSearch,
  linear,
  firecrawl,
  tavily,
  exa,
  googleCalendar,
  gmail,
  googleDrive,
  homeAssistant,
];
