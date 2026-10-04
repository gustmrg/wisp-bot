import { UserProfileSettings } from "@/components/user-profile-settings";
import type { UserProfileController } from "@/hooks/use-user-profile";
import { useEffect, useRef, useState } from "react";
import {
  BarChart3Icon,
  BellIcon,
  BotIcon,
  ChevronLeftIcon,
  DownloadIcon,
  ExternalLinkIcon,
  InfoIcon,
  KeyboardIcon,
  PlugIcon,
  RefreshCwIcon,
  ServerIcon,
  SettingsIcon,
  type LucideIcon,
} from "lucide-react";

import { GeneralSettingsSections, PreferenceSwitch, SoonTitle } from "@/components/general-settings-sections";
import { UsageSettingsSection } from "@/components/usage-settings-section";
import { ModelSettingsSection } from "@/components/model-settings-section";
import { PluginSettingsSection } from "@/components/plugin-settings-section";
import { McpSettingsSection } from "@/components/mcp-settings-section";
import { MobileNavigation } from "@/components/mobile-navigation";
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SoonBadge,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import type { AppMetadata, CurrentUser } from "@/config/app-metadata";
import type { AppPreferences } from "@/lib/app-preferences";
import type { PersistenceStatus } from "@/features/persistence/storage-policy";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { normalizeTheme } from "@/lib/theme";
import { profileAvatar } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";
import type { UpdateState } from "../../shared/contracts";

type SettingsSection = "general" | "model" | "plugins" | "mcp" | "about" | "usage";

/** Navigation order; entries without a section are announced but not available yet. */
const NAV_ITEMS: ReadonlyArray<
  { label: string; icon: LucideIcon } & ({ section: SettingsSection; panelId: string } | { soon: true })
> = [
  { section: "general", panelId: "general-settings-panel", label: "General", icon: SettingsIcon },
  { section: "model", panelId: "model-settings-panel", label: "AI Model", icon: BotIcon },
  { section: "plugins", panelId: "plugin-settings-panel", label: "Plugins", icon: PlugIcon },
  { section: "mcp", panelId: "mcp-settings-panel", label: "MCP servers", icon: ServerIcon },
  { section: "usage", panelId: "usage-settings-panel", label: "Token usage", icon: BarChart3Icon },
  { soon: true, label: "Notifications", icon: BellIcon },
  { soon: true, label: "Shortcuts", icon: KeyboardIcon },
  { section: "about", panelId: "about-settings-panel", label: "About", icon: InfoIcon },
];

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

interface AppSettingsDialogProps {
  mobile?: boolean;
  onOpenConversations?: () => void;
  appMetadata: AppMetadata;
  currentUser: CurrentUser;
  userProfile: UserProfileController;
  open: boolean;
  initialSection?: "general" | "model";
  preferences: AppPreferences;
  persistenceStatus: PersistenceStatus;
  persistenceError: string | null;
  onOpenChange: (open: boolean) => void;
  onPreferencesChange: (preferences: AppPreferences) => void;
}

const navButton =
  "settings-nav-button flex items-center gap-2 rounded-[7px] border-0 bg-transparent px-[9px] py-[7px] text-left text-dim hover:bg-muted hover:text-foreground [&_svg]:size-3.5";

function AppSettingsDialog({
  appMetadata,
  initialSection = "general",
  mobile = false,
  onOpenConversations,
  currentUser,
  userProfile,
  open,
  preferences,
  persistenceStatus,
  persistenceError,
  onOpenChange,
  onPreferencesChange,
}: AppSettingsDialogProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [mobileSectionOpen, setMobileSectionOpen] = useState(initialSection !== "general");

  useEffect(() => {
    if (!open) return;
    setSection(initialSection);
    setMobileSectionOpen(initialSection !== "general");
  }, [open, initialSection]);
  const showOverview = mobile && !mobileSectionOpen;
  const mobileHeadingRef = useRef<HTMLHeadingElement>(null);
  const sectionTitles = {
    general: "General",
    model: "AI Model",
    plugins: "Plugins",
    mcp: "MCP servers",
    about: "About",
    usage: "Token usage",
  };
  function openSection(nextSection: typeof section) {
    setSection(nextSection);
    setMobileSectionOpen(true);
  }
  const focusSection = mobile && open ? (showOverview ? "Settings" : sectionTitles[section]) : null;
  useEffect(() => {
    if (focusSection) mobileHeadingRef.current?.focus();
  }, [focusSection]);
  const selected = "bg-accent text-accent-foreground";
  const [updateState, setUpdateState] = useState<UpdateState>({
    phase: "idle",
    currentVersion: appMetadata.version,
  });

  useEffect(() => {
    if (!open) return;
    let active = true;
    const unsubscribe = window.wisp.subscribeToUpdateState((state) => {
      if (active) setUpdateState(state);
    });
    void window.wisp.getUpdateState().then((result) => {
      if (active && result.ok) setUpdateState(result.value);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [open]);

  async function handleUpdateAction(): Promise<void> {
    const result =
      updateState.phase === "manual-download"
        ? await window.wisp.openReleasesPage()
        : updateState.phase === "available"
          ? await window.wisp.downloadUpdate()
          : updateState.phase === "downloaded"
            ? await window.wisp.installUpdate()
            : await window.wisp.checkForUpdates();
    if (!result.ok) setUpdateState((current) => ({ ...current, phase: "error", message: result.error.message }));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) setSection("general");
      }}
    >
      <DialogContent
        mobileFullscreen
        showCloseButton={!mobile}
        className="app-settings-dialog grid h-[min(580px,calc(100vh-32px))] w-[min(760px,calc(100vw-32px))] max-w-[760px] grid-cols-[190px_1fr] gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Wisp settings</DialogTitle>
          <DialogDescription>Manage your profile and application preferences.</DialogDescription>
        </DialogHeader>
        {mobile ? (
          <header className="mobile-settings-header">
            <Button
              variant="ghost"
              size="icon"
              type="button"
              aria-label={showOverview ? "Close settings" : "Back to settings"}
              onClick={() => (showOverview ? onOpenChange(false) : setMobileSectionOpen(false))}
            >
              <ChevronLeftIcon aria-hidden="true" />
            </Button>
            <h2 ref={mobileHeadingRef} tabIndex={-1} className="outline-none">
              {showOverview ? "Settings" : sectionTitles[section]}
            </h2>
          </header>
        ) : null}
        <nav
          hidden={mobile && !showOverview}
          className={cn(
            "settings-navigation flex flex-col gap-[3px] border-r border-border bg-sidebar px-2.5 py-[18px]",
            mobile && !showOverview && "hidden",
          )}
          aria-label="Settings sections"
        >
          {mobile ? (
            <div className="mobile-settings-profile">
              <span className={profileAvatar}>{currentUser.initials}</span>
              <div>
                <strong>{currentUser.displayName}</strong>
                <small>Your workspace</small>
              </div>
            </div>
          ) : (
            <strong className="mx-2 mb-[15px] mt-0 text-[17px]">Settings</strong>
          )}
          {NAV_ITEMS.map((item) =>
            "section" in item ? (
              <button
                key={item.section}
                className={cn(navButton, section === item.section && selected)}
                type="button"
                aria-label={item.label}
                aria-current={section === item.section ? "page" : undefined}
                aria-controls={item.panelId}
                onClick={() => openSection(item.section)}
              >
                <item.icon aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            ) : (
              <button
                key={item.label}
                className={cn(navButton, "cursor-not-allowed hover:bg-transparent hover:text-dim")}
                type="button"
                aria-label={`${item.label} (coming soon)`}
                disabled
              >
                <item.icon aria-hidden="true" className="opacity-60" />
                <span className="opacity-60">{item.label}</span>
                <SoonBadge className="ml-auto" />
              </button>
            ),
          )}
        </nav>
        {section === "usage" && open && !showOverview ? <UsageSettingsSection /> : null}
        {section === "plugins" && open && !showOverview ? <PluginSettingsSection /> : null}
        {section === "mcp" && open && !showOverview ? <McpSettingsSection /> : null}
        <section
          className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5"
          id="general-settings-panel"
          aria-labelledby="general-settings-title"
          hidden={section !== "general" || showOverview}
        >
          <h2 id="general-settings-title" className="mb-[22px] mt-0 text-[17px]">
            General
          </h2>
          {userProfile.loading ? (
            <p role="status">Loading profile…</p>
          ) : (
            <UserProfileSettings controller={userProfile} />
          )}
          <SettingsGroup label="Application">
            <SettingsCard variant="stacked">
              <SettingsRow>
                <SettingsRowCopy>
                  <label htmlFor="app-theme">
                    <strong>Theme</strong>
                  </label>
                  <small className="text-dim text-[11.5px]">Choose how Wisp looks on this device.</small>
                </SettingsRowCopy>
                <Select
                  items={THEME_OPTIONS}
                  value={preferences.theme}
                  onValueChange={(value) => {
                    if (value !== null) onPreferencesChange({ ...preferences, theme: normalizeTheme(value) });
                  }}
                >
                  <SelectTrigger id="app-theme" className="w-28 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end" alignItemWithTrigger={false}>
                    <SelectGroup>
                      {THEME_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </SettingsRow>
              <SettingsRow>
                <SettingsRowCopy>
                  <SoonTitle>Launch at login</SoonTitle>
                  <small className="text-dim text-[11.5px]">Open Wisp automatically when you sign in.</small>
                </SettingsRowCopy>
                <PreferenceSwitch
                  label="Launch at login"
                  checked={preferences.launchAtLogin}
                  disabled
                  onChange={() => onPreferencesChange({ ...preferences, launchAtLogin: !preferences.launchAtLogin })}
                />
              </SettingsRow>
              <SettingsRow>
                <SettingsRowCopy>
                  <strong>Notification sounds</strong>
                  <small className="text-dim text-[11.5px]">Play a sound when a Wisp finishes or needs input.</small>
                </SettingsRowCopy>
                <PreferenceSwitch
                  label="Notification sounds"
                  checked={preferences.notificationSounds}
                  onChange={() =>
                    onPreferencesChange({ ...preferences, notificationSounds: !preferences.notificationSounds })
                  }
                />
              </SettingsRow>
            </SettingsCard>
          </SettingsGroup>
          <GeneralSettingsSections preferences={preferences} onPreferencesChange={onPreferencesChange} />
          <p className="mt-4 text-[11.5px] text-dim" role={persistenceError ? "alert" : "status"} aria-live="polite">
            {persistenceError ??
              (persistenceStatus === "saving"
                ? "Saving preferences…"
                : persistenceStatus === "saved"
                  ? "Preferences saved on this device."
                  : "Preferences are stored on this device.")}
          </p>
        </section>
        <ModelSettingsSection active={section === "model" && !showOverview} />
        <section
          className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5"
          id="about-settings-panel"
          aria-labelledby="about-settings-title"
          hidden={section !== "about" || showOverview}
        >
          <h2 id="about-settings-title" className="mb-[22px] mt-0 text-[17px]">
            About
          </h2>
          <SettingsGroup label="Version">
            <SettingsCard>
              <SettingsRow>
                <SettingsRowCopy>
                  <strong className="text-[12.5px]">{appMetadata.displayName}</strong>
                  <small className="text-dim text-[11.5px]">Version {appMetadata.version}</small>
                </SettingsRowCopy>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  aria-label={updateActionLabel(updateState)}
                  title={updateActionLabel(updateState)}
                  disabled={updateState.phase === "checking" || updateState.phase === "downloading"}
                  onClick={() => void handleUpdateAction()}
                >
                  {updateState.phase === "available" ? (
                    <DownloadIcon aria-hidden="true" />
                  ) : updateState.phase === "manual-download" ? (
                    <ExternalLinkIcon aria-hidden="true" />
                  ) : (
                    <RefreshCwIcon aria-hidden="true" />
                  )}
                </Button>
              </SettingsRow>
            </SettingsCard>
          </SettingsGroup>
          <p className="mt-3 text-[11.5px] text-dim" role={updateState.phase === "error" ? "alert" : "status"}>
            {updateStatusText(updateState)}
          </p>
          <p className="mt-2 text-[11px] text-faint">Manual recovery: github.com/gustmrg/wisp-bot/releases/latest</p>
        </section>
        {mobile ? (
          <MobileNavigation
            current="settings"
            onConversations={onOpenConversations ?? (() => onOpenChange(false))}
            onSettings={() => setMobileSectionOpen(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export { AppSettingsDialog };
export type { AppPreferences, AppSettingsDialogProps };

function updateActionLabel(state: UpdateState): string {
  if (state.phase === "available") return "Download update";
  if (state.phase === "manual-download") return "Open the releases page to download the update";
  if (state.phase === "downloaded") return "Restart and install update";
  return "Check for updates";
}

function updateStatusText(state: UpdateState): string {
  if (state.phase === "checking") return "Checking for updates…";
  if (state.phase === "available") return `Version ${state.availableVersion ?? "new"} is available.`;
  if (state.phase === "manual-download")
    return `Version ${state.availableVersion ?? "new"} is available. This build can't install updates automatically — open the releases page and replace the app with the latest download.`;
  if (state.phase === "downloading") return `Downloading update… ${state.progress ?? 0}%`;
  if (state.phase === "downloaded") return `Version ${state.availableVersion ?? "new"} is ready to install.`;
  if (state.phase === "up-to-date") return "Wisp Bot is up to date.";
  if (state.phase === "error") return state.message ?? "Could not check for updates.";
  return "Updates are checked only when you ask.";
}
