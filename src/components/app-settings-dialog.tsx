import { useBackend } from "@/features/backend/backend-provider";
import { useEffect, useState } from "react";
import {
  BarChart3Icon,
  BellIcon,
  BotIcon,
  DownloadIcon,
  InfoIcon,
  KeyboardIcon,
  RefreshCwIcon,
  SettingsIcon,
} from "lucide-react";

import { GeneralSettingsSections, PreferenceSwitch } from "@/components/general-settings-sections";
import { UsageSettingsSection } from "@/components/usage-settings-section";
import { ModelSettingsSection } from "@/components/model-settings-section";
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
  "flex items-center gap-2 rounded-[7px] border-0 bg-transparent px-[9px] py-[7px] text-left text-dim hover:bg-muted hover:text-foreground max-[620px]:justify-center [&_svg]:size-3.5 [&_span]:max-[620px]:hidden";

function AppSettingsDialog({
  appMetadata,
  initialSection = "general",
  currentUser,
  open,
  preferences,
  persistenceStatus,
  persistenceError,
  onOpenChange,
  onPreferencesChange,
}: AppSettingsDialogProps) {
  const { desktop, openAccount } = useBackend();
  const [section, setSection] = useState<"general" | "model" | "about" | "usage">(initialSection);
  const selected = "bg-accent text-accent-foreground";
  const [updateState, setUpdateState] = useState<UpdateState>({
    phase: "idle",
    currentVersion: appMetadata.version,
  });

  useEffect(() => {
    if (!open || !desktop) return;
    let active = true;
    const unsubscribe = desktop.subscribeToUpdateState((state) => {
      if (active) setUpdateState(state);
    });
    void desktop.getUpdateState().then((result) => {
      if (active && result.ok) setUpdateState(result.value);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [open, desktop]);

  async function handleUpdateAction(): Promise<void> {
    if (!desktop) return;
    const result =
      updateState.phase === "available"
        ? await desktop.downloadUpdate()
        : updateState.phase === "downloaded"
          ? await desktop.installUpdate()
          : await desktop.checkForUpdates();
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
      <DialogContent className="grid h-[min(580px,calc(100vh-32px))] w-[min(760px,calc(100vw-32px))] max-w-[760px] grid-cols-[190px_1fr] gap-0 overflow-hidden p-0 max-[620px]:grid-cols-[64px_1fr]">
        <DialogHeader className="sr-only">
          <DialogTitle>Wisp settings</DialogTitle>
          <DialogDescription>Manage your account and application preferences.</DialogDescription>
        </DialogHeader>
        <nav
          className="flex flex-col gap-[3px] border-r border-border bg-sidebar px-2.5 py-[18px]"
          aria-label="Settings sections"
        >
          <strong className="mx-2 mb-[15px] mt-0 text-[17px] max-[620px]:hidden">Settings</strong>
          <button
            className={cn(navButton, section === "general" && selected)}
            type="button"
            aria-label="General"
            aria-current={section === "general" ? "page" : undefined}
            aria-controls="general-settings-panel"
            onClick={() => setSection("general")}
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
            onClick={() => setSection("model")}
          >
            <BotIcon aria-hidden="true" />
            <span>AI Model</span>
          </button>
          <button
            className={cn(navButton, section === "usage" && selected)}
            type="button"
            aria-label="Token usage"
            aria-current={section === "usage" ? "page" : undefined}
            aria-controls="usage-settings-panel"
            onClick={() => setSection("usage")}
          >
            <BarChart3Icon aria-hidden="true" />
            <span>Token usage</span>
          </button>
          <button className={navButton} type="button">
            <BellIcon />
            <span>Notifications</span>
          </button>
          <button className={navButton} type="button">
            <KeyboardIcon />
            <span>Shortcuts</span>
          </button>
          <button
            className={cn(navButton, section === "about" && selected)}
            type="button"
            aria-label="About"
            aria-current={section === "about" ? "page" : undefined}
            aria-controls="about-settings-panel"
            onClick={() => setSection("about")}
          >
            <InfoIcon aria-hidden="true" />
            <span>About</span>
          </button>
        </nav>
        {section === "usage" && open ? <UsageSettingsSection /> : null}
        <section
          className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5"
          id="general-settings-panel"
          aria-labelledby="general-settings-title"
          hidden={section !== "general"}
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
                {openAccount ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      openAccount();
                    }}
                  >
                    Server connection
                  </Button>
                ) : null}
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
        <ModelSettingsSection active={section === "model"} />
        <section
          className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5"
          id="about-settings-panel"
          aria-labelledby="about-settings-title"
          hidden={section !== "about"}
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
                {desktop ? (
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
                    ) : (
                      <RefreshCwIcon aria-hidden="true" />
                    )}
                  </Button>
                ) : null}
              </SettingsRow>
            </SettingsCard>
          </SettingsGroup>
          <p className="mt-3 text-[11.5px] text-dim" role={updateState.phase === "error" ? "alert" : "status"}>
            {desktop ? updateStatusText(updateState) : "Updates are managed by this application’s host."}
          </p>
          {desktop ? (
            <p className="mt-2 text-[11px] text-faint">Manual recovery: github.com/gustmrg/wisp-bot/releases/latest</p>
          ) : null}
        </section>
      </DialogContent>
    </Dialog>
  );
}

export { AppSettingsDialog };
export type { AppPreferences, AppSettingsDialogProps };

function updateActionLabel(state: UpdateState): string {
  if (state.phase === "available") return "Download update";
  if (state.phase === "downloaded") return "Restart and install update";
  return "Check for updates";
}

function updateStatusText(state: UpdateState): string {
  if (state.phase === "checking") return "Checking for updates…";
  if (state.phase === "available") return `Version ${state.availableVersion ?? "new"} is available.`;
  if (state.phase === "downloading") return `Downloading update… ${state.progress ?? 0}%`;
  if (state.phase === "downloaded") return `Version ${state.availableVersion ?? "new"} is ready to install.`;
  if (state.phase === "up-to-date") return "Wisp Bot is up to date.";
  if (state.phase === "error") return state.message ?? "Could not check for updates.";
  return "Updates are checked only when you ask.";
}
