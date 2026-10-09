import { LaunchAtLoginSetting } from "@/components/launch-at-login-setting";
import { isBrowserApp } from "@/lib/platform";
import { UserProfileSettings } from "@/components/user-profile-settings";
import type { UserProfileController } from "@/hooks/use-user-profile";
import { useEffect, useRef, useState } from "react";
import {
  BarChart3Icon,
  BellIcon,
  BotIcon,
  CableIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleFadingArrowUpIcon,
  DownloadIcon,
  HardDriveIcon,
  ExternalLinkIcon,
  InfoIcon,
  KeyboardIcon,
  LoaderCircleIcon,
  MicIcon,
  PlugIcon,
  RefreshCwIcon,
  ServerIcon,
  SettingsIcon,
  type LucideIcon,
} from "lucide-react";

import { GeneralSettingsSections } from "@/components/general-settings-sections";
import { NotificationSettingsSection } from "@/components/notification-settings-section";
import { StorageSettingsSection } from "@/components/storage-settings-section";
import { UsageSettingsSection } from "@/components/usage-settings-section";
import { ModelSettingsSection } from "@/components/model-settings-section";
import { PluginSettingsSection } from "@/components/plugin-settings-section";
import { McpSettingsSection } from "@/components/mcp-settings-section";
import { ShortcutSettingsSection } from "@/components/shortcut-settings-section";
import { VoiceSettingsSection } from "@/components/voice-settings-section";
import { ConnectionSettingsSection } from "@/components/connection-settings-section";
import { MobileNavigation } from "@/components/mobile-navigation";
import { MobileSettingsProfile } from "@/components/mobile-settings-profile";
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
import { cn } from "@/lib/utils";
import { WISP_RELEASES_URL, WISP_REPOSITORY_URL, type UpdateState } from "../../shared/contracts";
import type { PluginId } from "../../shared/plugins";
import type { WispOption } from "@/lib/plugin-access";

type SettingsSection =
  | "general"
  | "notifications"
  | "connections"
  | "model"
  | "voice"
  | "plugins"
  | "mcp"
  | "shortcuts"
  | "about"
  | "usage"
  | "storage";
/** Sections other parts of the app can open the dialog at. */
export type SettingsEntrySection = "general" | "model" | "voice" | "plugins" | "mcp" | "storage";

/** Navigation order; entries without a section are announced but not available yet. */
const NAV_ITEMS: ReadonlyArray<
  { label: string; description: string; icon: LucideIcon } & (
    | { section: SettingsSection; panelId: string }
    | { soon: true }
  )
> = [
  {
    section: "general",
    panelId: "general-settings-panel",
    label: "General",
    description: "Your profile and how Wisp looks",
    icon: SettingsIcon,
  },
  {
    section: "connections",
    panelId: "connection-settings-panel",
    label: "Connections",
    description: "Where your Wisps run",
    icon: CableIcon,
  },
  {
    section: "model",
    panelId: "model-settings-panel",
    label: "AI Model",
    description: "The provider and model your Wisps use",
    icon: BotIcon,
  },
  {
    section: "voice",
    panelId: "voice-settings-panel",
    label: "Voice input",
    description: "Dictate messages and transcribe them",
    icon: MicIcon,
  },
  {
    section: "plugins",
    panelId: "plugin-settings-panel",
    label: "Plugins",
    description: "Extra tools and which Wisps can use them",
    icon: PlugIcon,
  },
  {
    section: "mcp",
    panelId: "mcp-settings-panel",
    label: "MCP servers",
    description: "Connect outside tools over MCP",
    icon: ServerIcon,
  },
  {
    section: "usage",
    panelId: "usage-settings-panel",
    label: "Token usage",
    description: "How many tokens each Wisp used",
    icon: BarChart3Icon,
  },
  {
    section: "storage",
    panelId: "storage-settings-panel",
    label: "Storage",
    description: "See the space used and clean up Wisp files",
    icon: HardDriveIcon,
  },
  {
    section: "notifications",
    panelId: "notification-settings-panel",
    label: "Notifications",
    description: "Sounds and alerts for new messages",
    icon: BellIcon,
  },
  {
    section: "shortcuts",
    panelId: "shortcut-settings-panel",
    label: "Shortcuts",
    description: "Keyboard shortcuts for common actions",
    icon: KeyboardIcon,
  },
  {
    section: "about",
    panelId: "about-settings-panel",
    label: "About",
    description: "Version, release notes, and support",
    icon: InfoIcon,
  },
];

/** How the mobile overview groups the sections, under the profile card. */
const MOBILE_NAV_GROUPS: ReadonlyArray<{ label: string; sections: ReadonlyArray<SettingsSection> }> = [
  { label: "Account and server", sections: ["general", "connections"] },
  { label: "Wisps", sections: ["model", "voice", "plugins", "mcp"] },
  { label: "Notifications and input", sections: ["notifications", "shortcuts"] },
  { label: "Storage and data", sections: ["storage", "usage"] },
  { label: "App", sections: ["about"] },
];

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

interface AppSettingsDialogProps {
  mobile?: boolean;
  onOpenConversations?: () => void;
  /** Opens the mobile Approvals tab; without it the bar leaves the tab out. */
  onOpenApprovals?: () => void;
  /** Counts for the mobile bar's badges. */
  navigationCounts?: { unread: number; approvals: number };
  appMetadata: AppMetadata;
  currentUser: CurrentUser;
  userProfile: UserProfileController;
  open: boolean;
  initialSection?: SettingsEntrySection;
  /** Plugin to open directly when the dialog starts at Plugins. */
  initialPluginId?: PluginId;
  /** Workspace to show when the dialog starts at Storage. */
  initialStorageConversationId?: string;
  /** Wisps that Plugins can give access to. */
  wisps?: ReadonlyArray<WispOption>;
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
  initialPluginId,
  initialStorageConversationId,
  wisps,
  mobile = false,
  onOpenConversations,
  onOpenApprovals,
  navigationCounts,
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
    notifications: "Notifications",
    connections: "Connections",
    model: "AI Model",
    voice: "Voice input",
    shortcuts: "Shortcuts",
    plugins: "Plugins",
    mcp: "MCP servers",
    about: "About",
    usage: "Token usage",
    storage: "Storage",
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
  function renderNavItem(item: (typeof NAV_ITEMS)[number]) {
    // On mobile each section is a card that says what it controls.
    const descriptionId = mobile ? `${"section" in item ? item.panelId : item.label}-description` : undefined;
    const copy = mobile ? (
      <span className="mobile-settings-copy">
        <strong>{item.label}</strong>
        <small id={descriptionId}>{item.description}</small>
      </span>
    ) : (
      <span>{item.label}</span>
    );
    return "section" in item ? (
      <button
        key={item.section}
        className={cn(navButton, section === item.section && !mobile && selected)}
        type="button"
        aria-label={item.label}
        aria-describedby={descriptionId}
        aria-current={section === item.section ? "page" : undefined}
        aria-controls={item.panelId}
        onClick={() => openSection(item.section)}
      >
        <item.icon aria-hidden="true" />
        {copy}
        {mobile ? <ChevronRightIcon aria-hidden="true" className="mobile-settings-chevron" /> : null}
      </button>
    ) : (
      <button
        key={item.label}
        className={cn(navButton, "cursor-not-allowed hover:bg-transparent hover:text-dim")}
        type="button"
        aria-label={`${item.label} (coming soon)`}
        aria-describedby={descriptionId}
        disabled
      >
        <item.icon aria-hidden="true" className="opacity-60" />
        <span className="opacity-60">{copy}</span>
        <SoonBadge className="ml-auto" />
      </button>
    );
  }
  // Updates and launch at login belong to the desktop app.
  const browserApp = isBrowserApp();
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
        className="app-settings-dialog grid h-[min(760px,calc(100vh-64px))] w-[min(1080px,calc(100vw-32px))] max-w-[1080px] grid-cols-[190px_1fr] lg:grid-cols-[220px_1fr] gap-0 overflow-hidden p-0"
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
            <>
              <MobileSettingsProfile
                currentUser={currentUser}
                appVersion={appMetadata.version}
                onOpenProfile={() => openSection("general")}
                onOpenConnection={() => openSection("connections")}
              />
              {MOBILE_NAV_GROUPS.map((group) => (
                <div
                  key={group.label}
                  className="mobile-settings-group"
                  role="group"
                  aria-labelledby={`settings-group-${group.sections[0]}`}
                >
                  <h3 id={`settings-group-${group.sections[0]}`}>{group.label}</h3>
                  {NAV_ITEMS.filter((item) => "section" in item && group.sections.includes(item.section)).map(
                    renderNavItem,
                  )}
                </div>
              ))}
            </>
          ) : (
            <>
              <strong className="mx-2 mb-[15px] mt-0 text-lg">Settings</strong>
              {NAV_ITEMS.map(renderNavItem)}
            </>
          )}
        </nav>
        {section === "usage" && open && !showOverview ? <UsageSettingsSection wisps={wisps} /> : null}
        {section === "storage" && open && !showOverview ? (
          <StorageSettingsSection
            key={initialStorageConversationId ?? "all"}
            initialConversationId={initialStorageConversationId}
          />
        ) : null}
        {section === "plugins" && open && !showOverview ? (
          <PluginSettingsSection
            wisps={wisps}
            initialPluginId={initialPluginId}
            onOpenMcpSettings={() => openSection("mcp")}
          />
        ) : null}
        {section === "mcp" && open && !showOverview ? <McpSettingsSection wisps={wisps} /> : null}
        {section === "connections" && open && !showOverview ? <ConnectionSettingsSection /> : null}
        <section
          className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5 [&>*]:max-w-[760px]"
          id="general-settings-panel"
          aria-labelledby="general-settings-title"
          hidden={section !== "general" || showOverview}
        >
          <h2 id="general-settings-title" className="mb-[22px] mt-0 text-lg font-semibold">
            General
          </h2>
          <div className="animate-tab-forward">
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
                    <small className="text-dim text-xs">Choose how Wisp looks on this device.</small>
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
                {browserApp ? null : <LaunchAtLoginSetting open={open} />}
              </SettingsCard>
            </SettingsGroup>
            <GeneralSettingsSections preferences={preferences} onPreferencesChange={onPreferencesChange} />
            <p className="mt-4 text-xs text-dim" role={persistenceError ? "alert" : "status"} aria-live="polite">
              {persistenceError ??
                (persistenceStatus === "saving"
                  ? "Saving preferences…"
                  : persistenceStatus === "saved"
                    ? "Preferences saved on this device."
                    : "Preferences are stored on this device.")}
            </p>
          </div>
        </section>
        {section === "notifications" && open && !showOverview ? (
          <NotificationSettingsSection
            preferences={preferences}
            onPreferencesChange={onPreferencesChange}
            persistenceStatus={persistenceStatus}
            persistenceError={persistenceError}
          />
        ) : null}
        <ModelSettingsSection active={section === "model" && !showOverview} />
        <VoiceSettingsSection
          active={open && section === "voice" && !showOverview}
          preferences={preferences}
          onPreferencesChange={onPreferencesChange}
        />
        <ShortcutSettingsSection
          active={section === "shortcuts" && !showOverview}
          preferences={preferences}
          onPreferencesChange={onPreferencesChange}
        />
        <section
          className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5 [&>*]:max-w-[760px]"
          id="about-settings-panel"
          aria-labelledby="about-settings-title"
          hidden={section !== "about" || showOverview}
        >
          <h2 id="about-settings-title" className="mb-[22px] mt-0 text-lg font-semibold">
            About
          </h2>
          <div className="animate-tab-forward">
            <p className="m-0 text-xs leading-relaxed text-dim">
              {appMetadata.displayName} is an open-source app for a squad of AI agents, your Wisps, that keep their
              memory, tools, and workspace across conversations. You bring your own model provider keys.
            </p>
            <SettingsGroup label="Version">
              <SettingsCard>
                <SettingsRow>
                  <SettingsRowCopy>
                    <strong className="text-sm">{appMetadata.displayName}</strong>
                    <small className="text-dim text-xs">Version {appMetadata.version}</small>
                  </SettingsRowCopy>
                  {browserApp ? null : (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      type="button"
                      className={cn(updateNeedsAction(updateState) && "text-blue hover:text-blue")}
                      aria-label={updateActionLabel(updateState)}
                      aria-busy={updateBusy(updateState)}
                      title={updateActionLabel(updateState)}
                      disabled={updateBusy(updateState)}
                      onClick={() => void handleUpdateAction()}
                    >
                      <UpdateActionIcon state={updateState} />
                    </Button>
                  )}
                </SettingsRow>
              </SettingsCard>
            </SettingsGroup>
            {browserApp ? (
              <p className="mt-3 text-xs text-dim">Served by your Wisp server, which updates this app with it.</p>
            ) : (
              <>
                <p className="mt-3 text-xs text-dim" role={updateState.phase === "error" ? "alert" : "status"}>
                  {updateStatusText(updateState)}
                </p>
                <p className="mt-2 text-xs text-faint">
                  Manual recovery:{" "}
                  <a
                    href={WISP_RELEASES_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="underline-offset-4 hover:underline"
                  >
                    github.com/gustmrg/wisp-bot/releases/latest
                  </a>
                </p>
              </>
            )}
            <SettingsGroup label="Project">
              <SettingsCard variant="stacked">
                <AboutLink
                  href={WISP_REPOSITORY_URL}
                  label="Source code"
                  description="Browse the code and documentation on GitHub."
                />
                <AboutLink
                  href={`${WISP_REPOSITORY_URL}/releases/tag/v${appMetadata.version}`}
                  label="Release notes"
                  description={`What changed in version ${appMetadata.version}.`}
                />
                <AboutLink
                  href={`${WISP_REPOSITORY_URL}/issues/new`}
                  label="Report an issue"
                  description="Tell us about a bug or suggest an improvement."
                />
                <AboutLink
                  href={`${WISP_REPOSITORY_URL}/blob/main/LICENSE`}
                  label="License"
                  description="Released under the MIT License."
                />
              </SettingsCard>
            </SettingsGroup>
          </div>
        </section>
        {mobile ? (
          <MobileNavigation
            current="settings"
            onConversations={onOpenConversations ?? (() => onOpenChange(false))}
            onApprovals={onOpenApprovals}
            onSettings={() => setMobileSectionOpen(false)}
            unreadCount={navigationCounts?.unread}
            approvalCount={navigationCounts?.approvals}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export { AppSettingsDialog };
export type { AppPreferences, AppSettingsDialogProps };

function updateBusy(state: UpdateState): boolean {
  return state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";
}

/** A found or downloaded update waits on the user, so the button stands out. */
function updateNeedsAction(state: UpdateState): boolean {
  return state.phase === "available" || state.phase === "manual-download" || state.phase === "downloaded";
}

/** A row in About that opens a project page in the browser. */
function AboutLink({ href, label, description }: { href: string; label: string; description: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="settings-row flex min-h-[58px] items-center gap-3 px-3.5 py-[11px] text-foreground no-underline outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <SettingsRowCopy>
        <strong>{label}</strong>
        <small>{description}</small>
      </SettingsRowCopy>
      <ExternalLinkIcon className="size-4 shrink-0 text-dim" aria-hidden="true" />
    </a>
  );
}

function UpdateActionIcon({ state }: { state: UpdateState }) {
  if (state.phase === "available") return <DownloadIcon aria-hidden="true" />;
  if (state.phase === "manual-download") return <ExternalLinkIcon aria-hidden="true" />;
  if (state.phase === "downloading" || state.phase === "installing")
    return <LoaderCircleIcon aria-hidden="true" className="animate-spin" />;
  if (state.phase === "downloaded") return <CircleFadingArrowUpIcon aria-hidden="true" />;
  return <RefreshCwIcon aria-hidden="true" className={cn(state.phase === "checking" && "animate-spin")} />;
}

function updateActionLabel(state: UpdateState): string {
  if (state.phase === "checking") return "Checking for updates";
  if (state.phase === "downloading") return "Downloading update";
  if (state.phase === "available") return "Download update";
  if (state.phase === "manual-download") return "Open the releases page to download the update";
  if (state.phase === "downloaded") return "Restart and install update";
  if (state.phase === "installing") return "Installing update";
  return "Check for updates";
}

function updateStatusText(state: UpdateState): string {
  if (state.phase === "checking") return "Checking for updates…";
  if (state.phase === "available") return `Version ${state.availableVersion ?? "new"} is available.`;
  if (state.phase === "manual-download")
    return `Version ${state.availableVersion ?? "new"} is available. This build can't install updates automatically — open the releases page and replace the app with the latest download.`;
  if (state.phase === "downloading") return `Downloading update… ${state.progress ?? 0}%`;
  if (state.phase === "downloaded") return `Version ${state.availableVersion ?? "new"} is ready to install.`;
  if (state.phase === "installing")
    return `Installing version ${state.availableVersion ?? "new"}… Wisp Bot will close and reopen on its own.`;
  if (state.phase === "up-to-date") return "Wisp Bot is up to date.";
  if (state.phase === "error") return state.message ?? "Could not check for updates.";
  return "Updates are checked only when you ask.";
}
