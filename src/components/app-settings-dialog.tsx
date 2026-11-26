import { LaunchAtLoginSetting } from "@/components/launch-at-login-setting";
import { isBrowserApp } from "@/lib/platform";
import { UserProfileSettings } from "@/components/user-profile-settings";
import { UserMemorySettings } from "@/components/wisp-memory-settings";
import type { UserProfileController } from "@/hooks/use-user-profile";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BarChart3Icon,
  BellIcon,
  BotIcon,
  CableIcon,
  CalendarClockIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleFadingArrowUpIcon,
  DownloadIcon,
  HardDriveIcon,
  ExternalLinkIcon,
  InfoIcon,
  KeyboardIcon,
  KeyRoundIcon,
  LayoutTemplateIcon,
  LoaderCircleIcon,
  MicIcon,
  PlugIcon,
  RefreshCwIcon,
  ServerIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  UserIcon,
  type LucideIcon,
} from "lucide-react";

import { GeneralSettingsSections, PreferenceSwitch } from "@/components/general-settings-sections";
import { NotificationSettingsSection } from "@/components/notification-settings-section";
import { StorageSettingsSection } from "@/components/storage-settings-section";
import { TemplateSettingsSection } from "@/components/template-settings-section";
import { UsageSettingsSection } from "@/components/usage-settings-section";
import { JobsSettingsSection } from "@/components/jobs-settings-section";
import { PermissionSettingsSection } from "@/components/permission-settings-section";
import { ModelSettingsSection } from "@/components/model-settings-section";
import { ProviderSettingsSection } from "@/components/provider-settings-section";
import { PluginSettingsSection } from "@/components/plugin-settings-section";
import { McpSettingsSection } from "@/components/mcp-settings-section";
import { ShortcutSettingsSection } from "@/components/shortcut-settings-section";
import { VoiceSettingsSection } from "@/components/voice-settings-section";
import { ConnectionSettingsSection } from "@/components/connection-settings-section";
import { RemoteAccessSettingsSection } from "@/components/remote-access-settings-section";
import { MobileNavigation } from "@/components/mobile-navigation";
import { MobileSettingsProfile } from "@/components/mobile-settings-profile";
import { WispAvatar } from "@/components/chat-avatar";
import { wispAccentStyle, wispColor } from "@/lib/wisp-appearance";
import { DEFAULT_WISP_APPEARANCE } from "../../shared/wisp-appearance";
import {
  environmentPhase,
  isEnvironmentConnected,
  OfflineEnvironmentPanel,
  SettingsEnvironmentContext,
  type SettingsEnvironmentContextValue,
} from "@/components/settings/settings-environment-selector";
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
  SoonBadge,
} from "@/components/settings/settings-primitives";
import { SettingsPanelTitle } from "@/components/settings/settings-scope";
import { useSettingsEnvironmentData } from "@/components/settings/use-settings-environment-data";
import { Button } from "@/components/ui/button";
import type { AppMetadata, CurrentUser } from "@/config/app-metadata";
import { ActiveConnectionContext } from "@/features/connections/active-connection";
import type { AppPreferences, ChatListOrder, ReplyPace } from "@/lib/app-preferences";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { PersistenceStatus } from "@/features/persistence/storage-policy";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createWispFromTemplate, type TemplateUseResult } from "@/lib/create-wisp-from-template";
import { createEnvironmentApi, WispApiProvider } from "@/lib/environment-api";
import { normalizeTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { WISP_RELEASES_URL, WISP_REPOSITORY_URL, type UpdateState } from "../../shared/contracts";
import type { SettingsPluginId } from "@/lib/plugin-access";
import type { WispOption } from "@/lib/plugin-access";
import type { ChatView } from "@/chat-data";
import type { WispTemplateEntry } from "../../shared/wisp-template";

type SettingsSection =
  | "general"
  | "notifications"
  | "shortcuts"
  | "connections"
  | "remote-access"
  | "about"
  | "profile"
  | "model"
  | "providers"
  | "voice"
  | "plugins"
  | "mcp"
  | "permissions"
  | "templates"
  | "jobs"
  | "storage"
  | "usage";

/** Sections other parts of the app can open the dialog at. */
export type SettingsEntrySection =
  | "general"
  | "profile"
  | "connections"
  | "model"
  | "providers"
  | "voice"
  | "plugins"
  | "mcp"
  | "storage"
  | "jobs"
  | "usage"
  | "templates";

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
    description: "Appearance, conversation list, and date and time",
    icon: SettingsIcon,
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
    section: "connections",
    panelId: "connection-settings-panel",
    label: "Connections",
    description: "Where your Wisps run",
    icon: CableIcon,
  },
  {
    section: "remote-access",
    panelId: "remote-access-settings-panel",
    label: "Remote access",
    description: "Use this computer's Wisps from your phone",
    icon: SmartphoneIcon,
  },
  {
    section: "about",
    panelId: "about-settings-panel",
    label: "About",
    description: "Version, release notes, and support",
    icon: InfoIcon,
  },
  {
    section: "profile",
    panelId: "profile-settings-panel",
    label: "Profile & memory",
    description: "Your name and what every Wisp knows about you",
    icon: UserIcon,
  },
  {
    section: "model",
    panelId: "model-settings-panel",
    label: "AI Model",
    description: "Which model your Wisps use",
    icon: BotIcon,
  },
  {
    section: "providers",
    panelId: "provider-settings-panel",
    label: "Providers",
    description: "Connect model services and manage their keys",
    icon: KeyRoundIcon,
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
    section: "permissions",
    panelId: "permission-settings-panel",
    label: "Permissions",
    description: "What Wisps can do without asking",
    icon: ShieldCheckIcon,
  },
  {
    section: "templates",
    panelId: "template-settings-panel",
    label: "Templates",
    description: "Ready-made Wisps to start from",
    icon: LayoutTemplateIcon,
  },
  {
    section: "jobs",
    panelId: "jobs-settings-panel",
    label: "Jobs",
    description: "Tasks your Wisps run on a schedule",
    icon: CalendarClockIcon,
  },
  {
    section: "storage",
    panelId: "storage-settings-panel",
    label: "Storage",
    description: "See the space used and clean up Wisp files",
    icon: HardDriveIcon,
  },
  {
    section: "usage",
    panelId: "usage-settings-panel",
    label: "Token usage",
    description: "How many tokens each Wisp used",
    icon: BarChart3Icon,
  },
];

/** Clean App vs Environment navigation split, shared on desktop and mobile. */
const NAV_GROUPS: ReadonlyArray<{ label: string; sections: ReadonlyArray<SettingsSection> }> = [
  { label: "App", sections: ["general", "notifications", "shortcuts", "connections", "remote-access", "about"] },
  {
    label: "Environment",
    sections: [
      "profile",
      "model",
      "providers",
      "voice",
      "plugins",
      "mcp",
      "permissions",
      "templates",
      "jobs",
      "storage",
      "usage",
    ],
  },
];

const REPLY_PACE_OPTIONS: ReadonlyArray<{ value: ReplyPace; label: string }> = [
  { value: "instant", label: "Instant" },
  { value: "smooth", label: "Smooth" },
  { value: "natural", label: "Natural" },
];

const REPLY_PACE_DESCRIPTIONS: Record<ReplyPace, string> = {
  instant: "Replies appear as fast as the model writes them.",
  smooth: "Replies flow in evenly, keeping up with the model.",
  natural: "Replies appear at a slower, steady pace, even from fast models. Click a reply to show the rest.",
};

const CHAT_LIST_ORDER_OPTIONS: ReadonlyArray<{ value: ChatListOrder; label: string }> = [
  { value: "recent", label: "Latest activity" },
  { value: "created", label: "Creation" },
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
  /** Creates a Wisp from a template; without it Templates offers no Use button. */
  onUseTemplate?: (entry: WispTemplateEntry) => Promise<TemplateUseResult>;
  /** Opens the creation dialog filled in from a template. */
  onCustomizeTemplate?: (entry: WispTemplateEntry) => void;
  /** Counts for the mobile bar's badges. */
  navigationCounts?: { unread: number; approvals: number };
  appMetadata: AppMetadata;
  currentUser: CurrentUser;
  userProfile: UserProfileController;
  open: boolean;
  initialSection?: SettingsEntrySection;
  /** Plugin to open directly when the dialog starts at Plugins. */
  initialPluginId?: SettingsPluginId;
  /** Workspace to show when the dialog starts at Storage. */
  initialStorageConversationId?: string;
  /** Wisps that Plugins can give access to. */
  wisps?: ReadonlyArray<WispOption>;
  /** Conversations whose pictures Storage shows beside their workspaces. */
  conversations?: ReadonlyArray<ChatView>;
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
  conversations,
  mobile = false,
  onOpenConversations,
  onOpenApprovals,
  onUseTemplate,
  onCustomizeTemplate,
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
  const [chosenEnvId, setChosenEnvId] = useState<string | null>(null);
  const connectionsView = useContext(ActiveConnectionContext);
  const activeId = connectionsView?.activeId ?? "";

  useEffect(() => {
    if (!open) {
      setChosenEnvId(null);
      return;
    }
    setSection(initialSection);
    setMobileSectionOpen(initialSection !== "general");
    setChosenEnvId(null);
  }, [open, initialSection]);

  const openSection = useCallback((nextSection: SettingsSection) => {
    setSection(nextSection);
    setMobileSectionOpen(true);
  }, []);

  const hasChosenProfile =
    chosenEnvId !== null && Boolean(connectionsView?.profiles.some(({ id }) => id === chosenEnvId));
  const selectedEnvironmentId = hasChosenProfile ? chosenEnvId : activeId;
  const selectedProfile = connectionsView?.profiles.find(({ id }) => id === selectedEnvironmentId);
  const selectedPhase = connectionsView ? environmentPhase(connectionsView, selectedEnvironmentId) : "local";
  const isSelectedConnected = !connectionsView || isEnvironmentConnected(selectedPhase);
  const isActiveEnvironment = !connectionsView || selectedEnvironmentId === activeId;

  const selectedEnvApi = useMemo(
    () => createEnvironmentApi(selectedEnvironmentId || undefined, activeId || undefined),
    [selectedEnvironmentId, activeId],
  );

  const settingsEnvContext = useMemo<SettingsEnvironmentContextValue | null>(
    () =>
      connectionsView
        ? {
            connectionsView,
            selectedEnvironmentId,
            activeEnvironmentId: activeId,
            selectedProfile,
            selectedPhase,
            isSelectedConnected,
            isActiveEnvironment,
            onSelectEnvironment: setChosenEnvId,
            onOpenConnections: () => openSection("connections"),
          }
        : null,
    [
      connectionsView,
      selectedEnvironmentId,
      activeId,
      selectedProfile,
      selectedPhase,
      isSelectedConnected,
      isActiveEnvironment,
      openSection,
    ],
  );

  const envData = useSettingsEnvironmentData({
    open,
    isActiveEnvironment,
    isSelectedConnected,
    selectedEnvironmentId,
    api: selectedEnvApi,
    activeWisps: wisps,
    activeConversations: conversations,
    activeUserProfile: userProfile,
  });

  const handleUseTemplate = useCallback(
    async (entry: WispTemplateEntry): Promise<TemplateUseResult> => {
      if (isActiveEnvironment && onUseTemplate) return onUseTemplate(entry);
      const takenNames = (envData.wisps ?? []).map(({ name }) => name);
      return createWispFromTemplate(
        entry.template,
        takenNames,
        async (wisp, options) => {
          const id = crypto.randomUUID();
          const result = await selectedEnvApi.createWisp({
            wisp: { id, ...wisp },
            notifyOnUpdatesEnabled: options.notifyOnUpdatesEnabled,
            model: options.model ?? null,
          });
          return result.ok ? id : null;
        },
        selectedEnvApi,
      );
    },
    [isActiveEnvironment, onUseTemplate, envData.wisps, selectedEnvApi],
  );

  const showOverview = mobile && !mobileSectionOpen;
  const mobileHeadingRef = useRef<HTMLHeadingElement>(null);
  // Updates, launch at login, and remote access belong to the desktop app.
  const browserApp = isBrowserApp();
  const navItems = browserApp
    ? NAV_ITEMS.filter((item) => !("section" in item) || item.section !== "remote-access")
    : NAV_ITEMS;
  const sectionTitles: Record<SettingsSection, string> = {
    general: "General",
    notifications: "Notifications",
    shortcuts: "Shortcuts",
    connections: "Connections",
    "remote-access": "Remote access",
    about: "About",
    profile: "Profile & memory",
    model: "AI Model",
    providers: "Providers",
    voice: "Voice input",
    plugins: "Plugins",
    mcp: "MCP servers",
    permissions: "Permissions",
    templates: "Templates",
    jobs: "Jobs",
    storage: "Storage",
    usage: "Token usage",
  };
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

  const envKey = selectedEnvironmentId || "active";
  function renderEnvironmentPanel(panelId: string, titleId: string, title: string, content: ReactNode) {
    if (!isSelectedConnected) {
      return <OfflineEnvironmentPanel key={envKey} panelId={panelId} titleId={titleId} title={title} />;
    }
    return (
      <WispApiProvider key={envKey} api={selectedEnvApi}>
        {content}
      </WispApiProvider>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          setSection("general");
          setChosenEnvId(null);
        }
      }}
    >
      <DialogContent
        mobileFullscreen
        showCloseButton={!mobile}
        className="app-settings-dialog grid h-[min(760px,calc(100dvh-64px))] w-[min(1080px,calc(100vw-32px))] max-w-[1080px] grid-cols-[190px_1fr] lg:grid-cols-[220px_1fr] gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Wisp settings</DialogTitle>
          <DialogDescription>Manage your profile and application preferences.</DialogDescription>
        </DialogHeader>
        {mobile ? (
          <header className="mobile-settings-header" data-overview={showOverview || undefined}>
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
            "settings-navigation flex flex-col gap-[3px] overflow-y-auto border-r border-border bg-sidebar px-2.5 py-[18px]",
            mobile && !showOverview && "hidden",
          )}
          aria-label="Settings sections"
        >
          {mobile ? (
            <>
              <MobileSettingsProfile
                currentUser={currentUser}
                appVersion={appMetadata.version}
                onOpenProfile={() => openSection("profile")}
                onOpenConnection={() => openSection("connections")}
              />
              {wisps?.length ? (
                <button
                  type="button"
                  className="mobile-settings-wisps"
                  onClick={onOpenConversations ?? (() => onOpenChange(false))}
                >
                  <span className="mobile-settings-wisps-row" aria-hidden="true">
                    {wisps.slice(0, 5).map((wisp) => (
                      <span
                        key={wisp.id}
                        className="wisp-halo"
                        style={wispAccentStyle(wispColor(wisp.name, wisp.color))}
                      >
                        <WispAvatar
                          wisp={{ ...wisp, appearance: wisp.appearance ?? DEFAULT_WISP_APPEARANCE }}
                          size="sm"
                        />
                      </span>
                    ))}
                  </span>
                  <span className="mobile-settings-wisps-count">
                    {`${wisps.length} ${wisps.length === 1 ? "Wisp" : "Wisps"}`}
                  </span>
                  <ChevronRightIcon aria-hidden="true" className="mobile-settings-chevron" />
                </button>
              ) : null}
            </>
          ) : (
            <strong className="mx-2 mb-[15px] mt-0 text-lg">Settings</strong>
          )}
          {NAV_GROUPS.map((group) => (
            <div
              key={group.label}
              className={
                mobile ? "mobile-settings-group" : "flex flex-none flex-col gap-[3px] not-first-of-type:mt-2.5"
              }
              role="group"
              aria-labelledby={`settings-group-${group.sections[0]}`}
            >
              <h3
                id={`settings-group-${group.sections[0]}`}
                className={mobile ? undefined : "mx-[9px] mt-0 mb-1 text-2xs font-normal text-faint"}
              >
                {group.label}
              </h3>
              {navItems.filter((item) => "section" in item && group.sections.includes(item.section)).map(renderNavItem)}
            </div>
          ))}
        </nav>
        <SettingsEnvironmentContext.Provider value={settingsEnvContext}>
          {section === "profile" && open && !showOverview
            ? renderEnvironmentPanel(
                "profile-settings-panel",
                "profile-settings-title",
                "Profile & memory",
                <section
                  className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5 [&>*]:max-w-[760px]"
                  id="profile-settings-panel"
                  aria-labelledby="profile-settings-title"
                >
                  <SettingsPanelTitle id="profile-settings-title" scope="environment" className="mb-[22px]">
                    Profile &amp; memory
                  </SettingsPanelTitle>
                  <div className="animate-panel-in">
                    {envData.userProfile.loading ? (
                      <p role="status">Loading profile…</p>
                    ) : (
                      <UserProfileSettings key={envKey} controller={envData.userProfile}>
                        <UserMemorySettings />
                      </UserProfileSettings>
                    )}
                  </div>
                </section>,
              )
            : null}
          {section === "usage" && open && !showOverview
            ? renderEnvironmentPanel(
                "usage-settings-panel",
                "usage-settings-title",
                "Token usage",
                <UsageSettingsSection wisps={envData.wisps} />,
              )
            : null}
          {section === "jobs" && open && !showOverview
            ? renderEnvironmentPanel(
                "jobs-settings-panel",
                "jobs-settings-title",
                "Jobs",
                <JobsSettingsSection wisps={envData.wisps} />,
              )
            : null}
          {section === "templates" && open && !showOverview
            ? renderEnvironmentPanel(
                "template-settings-panel",
                "template-settings-title",
                "Templates",
                <TemplateSettingsSection
                  onUseTemplate={onUseTemplate ? handleUseTemplate : undefined}
                  onCustomizeTemplate={isActiveEnvironment ? onCustomizeTemplate : undefined}
                  onOpenModelSettings={() => openSection("model")}
                  onClose={() => onOpenChange(false)}
                />,
              )
            : null}
          {section === "storage" && open && !showOverview
            ? renderEnvironmentPanel(
                "storage-settings-panel",
                "storage-settings-title",
                "Storage",
                <StorageSettingsSection
                  key={`${envKey}:${isActiveEnvironment ? (initialStorageConversationId ?? "all") : "all"}`}
                  initialConversationId={isActiveEnvironment ? initialStorageConversationId : undefined}
                  conversations={envData.conversations}
                />,
              )
            : null}
          {section === "plugins" && open && !showOverview
            ? renderEnvironmentPanel(
                "plugin-settings-panel",
                "plugin-settings-title",
                "Plugins",
                <PluginSettingsSection
                  wisps={envData.wisps}
                  initialPluginId={isActiveEnvironment ? initialPluginId : undefined}
                  onOpenMcpSettings={() => openSection("mcp")}
                />,
              )
            : null}
          {section === "mcp" && open && !showOverview
            ? renderEnvironmentPanel(
                "mcp-settings-panel",
                "mcp-settings-title",
                "MCP servers",
                <McpSettingsSection wisps={envData.wisps} />,
              )
            : null}
          {section === "permissions" && open && !showOverview
            ? renderEnvironmentPanel(
                "permission-settings-panel",
                "permission-settings-title",
                "Permissions",
                isActiveEnvironment ? (
                  <PermissionSettingsSection preferences={preferences} onPreferencesChange={onPreferencesChange} />
                ) : (
                  <PermissionSettingsSection />
                ),
              )
            : null}
          {section === "model" && open && !showOverview
            ? renderEnvironmentPanel(
                "model-settings-panel",
                "model-settings-title",
                "AI Model",
                <ModelSettingsSection onOpenProviders={() => openSection("providers")} />,
              )
            : null}
          {section === "providers" && open && !showOverview
            ? renderEnvironmentPanel(
                "provider-settings-panel",
                "provider-settings-title",
                "Providers",
                <ProviderSettingsSection />,
              )
            : null}
          {section === "voice" && open && !showOverview
            ? renderEnvironmentPanel(
                "voice-settings-panel",
                "voice-settings-title",
                "Voice input",
                <VoiceSettingsSection
                  active
                  preferences={preferences}
                  onPreferencesChange={onPreferencesChange}
                  onOpenProviders={() => openSection("providers")}
                />,
              )
            : null}
        </SettingsEnvironmentContext.Provider>
        {section === "connections" && open && !showOverview ? <ConnectionSettingsSection /> : null}
        {section === "remote-access" && open && !showOverview && !browserApp ? <RemoteAccessSettingsSection /> : null}
        <section
          className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5 [&>*]:max-w-[760px]"
          id="general-settings-panel"
          aria-labelledby="general-settings-title"
          hidden={section !== "general" || showOverview}
        >
          <h2 id="general-settings-title" className="mb-[22px] mt-0 text-lg font-semibold">
            General
          </h2>
          <div className="animate-panel-in">
            <SettingsGroup label="Application">
              <SettingsCard variant="stacked">
                <SettingsRow>
                  <SettingsRowCopy>
                    <SettingsRowTitle htmlFor="app-theme">Theme</SettingsRowTitle>
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
                    <SettingsRowTitle>Wisp colors</SettingsRowTitle>
                    <SettingsRowDescription>
                      Tint replies, the send button and the selected conversation with each Wisp's color.
                    </SettingsRowDescription>
                  </SettingsRowCopy>
                  <PreferenceSwitch
                    label="Wisp colors"
                    checked={preferences.wispColors}
                    onChange={() => onPreferencesChange({ ...preferences, wispColors: !preferences.wispColors })}
                  />
                </SettingsRow>
                <SettingsRow>
                  <SettingsRowCopy>
                    <SettingsRowTitle>Conversation order</SettingsRowTitle>
                    <SettingsRowDescription>Pinned conversations always come first.</SettingsRowDescription>
                  </SettingsRowCopy>
                  <SegmentedControl<ChatListOrder>
                    label="Conversation order"
                    value={preferences.chatListOrder}
                    options={CHAT_LIST_ORDER_OPTIONS}
                    onChange={(chatListOrder) => onPreferencesChange({ ...preferences, chatListOrder })}
                  />
                </SettingsRow>
                <SettingsRow>
                  <SettingsRowCopy>
                    <SettingsRowTitle>Reply speed</SettingsRowTitle>
                    <SettingsRowDescription>{REPLY_PACE_DESCRIPTIONS[preferences.replyPace]}</SettingsRowDescription>
                  </SettingsRowCopy>
                  <SegmentedControl<ReplyPace>
                    label="Reply speed"
                    value={preferences.replyPace}
                    options={REPLY_PACE_OPTIONS}
                    onChange={(replyPace) => onPreferencesChange({ ...preferences, replyPace })}
                  />
                </SettingsRow>
                <SettingsRow>
                  <SettingsRowCopy>
                    <SettingsRowTitle>Tools in circles</SettingsRowTitle>
                    <SettingsRowDescription>
                      Show or hide tool steps in circles. Approval requests and reply errors stay visible.
                    </SettingsRowDescription>
                  </SettingsRowCopy>
                  <SegmentedControl
                    label="Tools in circles"
                    value={preferences.circleToolCalls}
                    options={[
                      { value: "show", label: "Show" },
                      { value: "hide", label: "Hide" },
                    ]}
                    onChange={(circleToolCalls) => onPreferencesChange({ ...preferences, circleToolCalls })}
                  />
                </SettingsRow>
                {browserApp ? null : <LaunchAtLoginSetting open={open} />}
              </SettingsCard>
            </SettingsGroup>
            <GeneralSettingsSections preferences={preferences} onPreferencesChange={onPreferencesChange} />
            <p className="mt-4 text-xs text-dim" role={persistenceError ? "alert" : "status"} aria-live="polite">
              {persistenceError ?? (persistenceStatus === "saving" ? "Saving preferences…" : null)}
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
          <div className="animate-panel-in">
            <p className="m-0 text-xs leading-relaxed text-dim">
              {appMetadata.displayName} is an open-source app for a squad of AI agents, your Wisps, that keep their
              memory, tools, and workspace across conversations. You bring your own model provider keys.
            </p>
            <SettingsGroup label="Version">
              <SettingsCard>
                <SettingsRow>
                  <SettingsRowCopy>
                    <SettingsRowTitle>{appMetadata.displayName}</SettingsRowTitle>
                    <SettingsRowDescription>Version {appMetadata.version}</SettingsRowDescription>
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
        <SettingsRowTitle>{label}</SettingsRowTitle>
        <SettingsRowDescription>{description}</SettingsRowDescription>
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
