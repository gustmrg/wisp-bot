import type { PluginId } from "../../shared/plugins";
import braveLogo from "@/assets/plugins/brave.svg";
import firecrawlLogo from "@/assets/plugins/firecrawl.png";
import linearLogo from "@/assets/plugins/linear.svg";

const logos: Record<PluginId, string> = {
  "web-search": braveLogo,
  firecrawl: firecrawlLogo,
  linear: linearLogo,
};

export function PluginLogo({ pluginId }: { pluginId: PluginId }) {
  return (
    <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-white p-2">
      <img src={logos[pluginId]} alt="" className="size-full object-contain" />
    </span>
  );
}
