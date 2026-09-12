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
  SettingsIcon,
} from "lucide-react";

import { GeneralSettingsSections, PreferenceSwitch } from "@/components/general-settings-sections";
import { UsageSettingsSection } from "@/components/usage-settings-section";
import { ModelSettingsSection } from "@/components/model-settings-section";
import { PluginSettingsSection } from "@/components/plugin-settings-section";
import { McpSettingsSection } from "@/components/mcp-settings-section";
import { MobileNavigation } from "@/components/mobile-navigation";
import { SettingsCard, SettingsGroup, SettingsRow, SettingsRowCopy } from "@/components/settings/settings-primitives";
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
  open,
  preferences,
  persistenceStatus,
  persistenceError,
  onOpenChange,
  onPreferencesChange,
}: AppSettingsDialogProps) {
  const [section, setSection] = useState<"general" | "model" | "plugins" | "about" | "usage">(initialSection);
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
    plugins: "Integrations",
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
          <DialogDescription>Manage your account and application preferences.</DialogDescription>
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
          <button
            className={cn(navButton, section === "general" && selected)}
            type="button"
            aria-label="General"
            aria-current={section === "general" ? "page" : undefined}
            aria-controls="general-settings-panel"
            onClick={() => openSection("general")}
          >
            <SettingsIcon aria-hidden="true" />
            <span>General</span>
          </button>
          <button
            className={cn(navButton, section === "model" && selected)}
            type="button"
            aria-label="AI Model"
            aria-current={section === "model" ? "page" : undefined}
            aria-controls="model-settings-panel"
            onClick={() => openSection("model")}
          >
            <BotIcon aria-hidden="true" />
            <span>AI Model</span>
          </button>
          <button
            className={cn(navButton, section === "plugins" && selected)}
            type="button"
            aria-label="Integrations"
            aria-current={section === "plugins" ? "page" : undefined}
            aria-controls="plugin-settings-panel"
            onClick={() => openSection("plugins")}
          >
            <PlugIcon aria-hidden="true" />
            <span>Integrations</span>
          </button>
          <button
            className={cn(navButton, section === "usage" && selected)}
            type="button"
            aria-label="Token usage"
            aria-current={section === "usage" ? "page" : undefined}
            aria-controls="usage-settings-panel"
            onClick={() => openSection("usage")}
          >
            <BarChart3Icon aria-hidden="true" />
            <span>Token usage</span>
          </button>
          {!mobile ? (
            <>
              <button className={navButton} type="button">
                <BellIcon />
                <span>Notifications</span>
              </button>
              <button className={navButton} type="button">
                <KeyboardIcon />
                <span>Shortcuts</span>
              </button>
            </>
          ) : null}
          <button
            className={cn(navButton, section === "about" && selected)}
            type="button"
            aria-label="About"
            aria-current={section === "about" ? "page" : undefined}
            aria-controls="about-settings-panel"
            onClick={() => openSection("about")}
          >
            <InfoIcon aria-hidden="true" />
            <span>About</span>
          </button>
        </nav>
        {section === "usage" && open && !showOverview ? <UsageSettingsSection /> : null}
        {section === "plugins" && open && !showOverview ? (
          <section
            className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5"
            id="plugin-settings-panel"
            aria-label="Integrations settings"
          >
            <h2 id="integrations-settings-title" className="mb-1 mt-0 text-[17px]">
              Integrations
            </h2>
            <p className="mb-4 text-[11.5px] leading-relaxed text-dim">
              Connect services on this device, then choose access in each Wisp's Access tab. Connecting an integration
              does not give any Wisp access automatically.
            </p>
            <PluginSettingsSection />
            <McpSettingsSection />
          </section>
        ) : null}
        <section
          className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5"
          id="general-settings-panel"
          aria-labelledby="general-settings-title"
          hidden={section !== "general" || showOverview}
        >
          <h2 id="general-settings-title" className="mb-[22px] mt-0 text-[17px]">
            General
          </h2>
          <SettingsGroup label="Account">
            <SettingsCard>
              <SettingsRow>
                <span className={profileAvatar}>{currentUser.initials}</span>
                <SettingsRowCopy>
                  <strong className="text-[12.5px]">{currentUser.displayName}</strong>
                  <small className="text-dim text-[11.5px]">{currentUser.email}</small>
                </SettingsRowCopy>
                <Button variant="secondary" size="sm" type="button">
                  Sign out
                </Button>
              </SettingsRow>
            </SettingsCard>
          </SettingsGroup>
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
                  <strong>Launch at login</strong>
                  <small className="text-dim text-[11.5px]">Open Wisp automatically when you sign in.</small>
                </SettingsRowCopy>
                <PreferenceSwitch
                  label="Launch at login"
                  checked={preferences.launchAtLogin}
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
