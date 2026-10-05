import type { PluginId } from "../../shared/plugins";
import braveLogo from "@/assets/plugins/brave.svg";
import firecrawlLogo from "@/assets/plugins/firecrawl.png";
import linearLogo from "@/assets/plugins/linear.svg";
import tavilyLogo from "@/assets/plugins/tavily.svg";
import exaLogo from "@/assets/plugins/exa.png";
import { cn } from "@/lib/utils";

const logos: Record<PluginId, string> = {
  "web-search": braveLogo,
  firecrawl: firecrawlLogo,
  linear: linearLogo,
  tavily: tavilyLogo,
  exa: exaLogo,
};

export function PluginLogo({ pluginId, size = "default" }: { pluginId: PluginId; size?: "default" | "sm" }) {
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
