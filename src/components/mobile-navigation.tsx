import { MessageCircleIcon, SettingsIcon } from "lucide-react";

interface MobileNavigationProps {
  current: "wisps" | "settings";
  onConversations: () => void;
  onSettings: () => void;
}

export function MobileNavigation({ current, onConversations, onSettings }: MobileNavigationProps) {
  return (
    <nav className="mobile-navigation" aria-label="Main navigation">
      <button type="button" aria-current={current === "wisps" ? "page" : undefined} onClick={onConversations}>
        <MessageCircleIcon aria-hidden="true" />
        <span>Wisps</span>
      </button>
      <button type="button" aria-current={current === "settings" ? "page" : undefined} onClick={onSettings}>
        <SettingsIcon aria-hidden="true" />
        <span>Settings</span>
      </button>
    </nav>
  );
}
