import type { ReactNode } from "react";
import { MessageCircleIcon, SettingsIcon, ShieldAlertIcon, type LucideIcon } from "lucide-react";

interface MobileNavigationProps {
  current: "wisps" | "approvals" | "settings";
  onConversations: () => void;
  /** Without it the Approvals tab is left out, as in component tests that do not need it. */
  onApprovals?: () => void;
  onSettings: () => void;
  unreadCount?: number;
  approvalCount?: number;
}

/** The mobile bottom bar (ADR 015): Wisps, Approvals, and Settings. */
export function MobileNavigation({
  current,
  onConversations,
  onApprovals,
  onSettings,
  unreadCount = 0,
  approvalCount = 0,
}: MobileNavigationProps) {
  return (
    <nav className="mobile-navigation" aria-label="Main navigation">
      <Tab
        icon={MessageCircleIcon}
        label="Wisps"
        current={current === "wisps"}
        onClick={onConversations}
        badge={badge(unreadCount, "unread")}
      />
      {onApprovals ? (
        <Tab
          icon={ShieldAlertIcon}
          label="Approvals"
          current={current === "approvals"}
          onClick={onApprovals}
          badge={badge(approvalCount, "pending", "warning")}
        />
      ) : null}
      <Tab icon={SettingsIcon} label="Settings" current={current === "settings"} onClick={onSettings} />
    </nav>
  );
}

interface TabBadge {
  count: number;
  description: string;
  tone?: "warning";
}

function badge(count: number, description: string, tone?: "warning"): TabBadge | undefined {
  return count > 0 ? { count, description, ...(tone ? { tone } : {}) } : undefined;
}

function Tab({
  icon: Icon,
  label,
  current,
  onClick,
  badge,
}: {
  icon: LucideIcon;
  label: string;
  current: boolean;
  onClick: () => void;
  badge?: TabBadge;
}): ReactNode {
  return (
    <button type="button" aria-current={current ? "page" : undefined} onClick={onClick}>
      <span className="mobile-navigation-icon">
        <Icon aria-hidden="true" />
        {badge ? (
          <span className="mobile-navigation-badge" data-tone={badge.tone} aria-hidden="true">
            {badge.count > 99 ? "99+" : badge.count}
          </span>
        ) : null}
      </span>
      <span>{label}</span>
      {badge ? <span className="sr-only">{`, ${badge.count} ${badge.description}`}</span> : null}
    </button>
  );
}
