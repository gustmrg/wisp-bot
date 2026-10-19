import type { McpPresetId } from "../../shared/mcp-presets";
import type { PluginId } from "../../shared/plugins";
import braveLogo from "@/assets/plugins/brave.svg";
import firecrawlLogo from "@/assets/plugins/firecrawl.png";
import linearLogo from "@/assets/plugins/linear.svg";
import tavilyLogo from "@/assets/plugins/tavily.svg";
import exaLogo from "@/assets/plugins/exa.png";
import deepseekLogo from "@/assets/plugins/deepseek.svg";
import githubLogo from "@/assets/plugins/github.svg";
import googleCalendarLogo from "@/assets/plugins/google-calendar.svg";
import gmailLogo from "@/assets/plugins/gmail.svg";
import googleDriveLogo from "@/assets/plugins/google-drive.svg";
import homeAssistantLogo from "@/assets/plugins/home-assistant.svg";
import atlassianLogo from "@/assets/plugins/atlassian.svg";
import { cn } from "@/lib/utils";

const logos: Record<PluginId | McpPresetId, string> = {
  "web-search": braveLogo,
  firecrawl: firecrawlLogo,
  linear: linearLogo,
  tavily: tavilyLogo,
  exa: exaLogo,
  deepseek: deepseekLogo,
  "google-calendar": googleCalendarLogo,
  gmail: gmailLogo,
  "google-drive": googleDriveLogo,
  "home-assistant": homeAssistantLogo,
  github: githubLogo,
  atlassian: atlassianLogo,
};

export function PluginLogo({
  pluginId,
  size = "default",
}: {
  pluginId: PluginId | McpPresetId;
  size?: "default" | "sm";
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden border border-border bg-white",
        size === "sm" ? "size-7 rounded-lg p-1" : "size-11 rounded-xl p-2",
      )}
    >
      <img src={logos[pluginId]} alt="" className="size-full object-contain" />
    </span>
  );
}
