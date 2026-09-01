import { useState } from "react";
import { BellIcon, BotIcon, InfoIcon, KeyboardIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";

import { GeneralSettingsSections, PreferenceSwitch } from "@/components/general-settings-sections";
import { ModelSettingsSection } from "@/components/model-settings-section";
import type { AppPreferences } from "@/lib/app-preferences";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { normalizeTheme } from "@/lib/theme";
import { iconButton, profileAvatar, settingsCard, settingsCardStack, settingsGroupLabel, settingsRow, settingsRowCopy } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

interface AppSettingsDialogProps {
  open: boolean;
  preferences: AppPreferences;
  onOpenChange: (open: boolean) => void;
  onPreferencesChange: (preferences: AppPreferences) => void;
}

const navButton =
  "flex items-center gap-2 rounded-[7px] border-0 bg-transparent px-[9px] py-[7px] text-left text-[#606060] hover:bg-[#e6e6e6] hover:text-[#222222] dark:text-[#aaaaaa] dark:hover:bg-[#2b2b2b] dark:hover:text-[#eeeeee] max-[620px]:justify-center [&_svg]:size-3.5 [&_span]:max-[620px]:hidden";

function AppSettingsDialog({ open, preferences, onOpenChange, onPreferencesChange }: AppSettingsDialogProps) {
  const [section, setSection] = useState<"general" | "model" | "about">("general");
  const selected = "bg-[#e6e6e6] text-[#222222] dark:bg-[#2b2b2b] dark:text-[#eeeeee]";

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      onOpenChange(nextOpen);
      if (!nextOpen) setSection("general");
    }}>
      <DialogContent className="grid h-[min(580px,calc(100vh-32px))] w-[min(760px,calc(100vw-32px))] max-w-[760px] grid-cols-[190px_1fr] gap-0 overflow-hidden p-0 max-[620px]:grid-cols-[64px_1fr]">
        <DialogHeader className="sr-only"><DialogTitle>Wisp settings</DialogTitle><DialogDescription>Manage your account and application preferences.</DialogDescription></DialogHeader>
        <nav className="flex flex-col gap-[3px] border-r border-black/[0.06] bg-[#f5f5f5] px-2.5 py-[18px] dark:border-white/[0.06] dark:bg-[#141414]" aria-label="Settings sections">
          <strong className="mx-2 mb-[15px] mt-0 text-[17px] max-[620px]:hidden">Settings</strong>
          <button className={cn(navButton, section === "general" && selected)} type="button" aria-label="General" aria-current={section === "general" ? "page" : undefined} aria-controls="general-settings-panel" onClick={() => setSection("general")}><SettingsIcon aria-hidden="true" /><span>General</span></button>
          <button className={cn(navButton, section === "model" && selected)} type="button" aria-label="AI Model" aria-current={section === "model" ? "page" : undefined} aria-controls="model-settings-panel" onClick={() => setSection("model")}><BotIcon aria-hidden="true" /><span>AI Model</span></button>
          <button className={navButton} type="button"><BellIcon /><span>Notifications</span></button>
          <button className={navButton} type="button"><KeyboardIcon /><span>Shortcuts</span></button>
          <button className={cn(navButton, section === "about" && selected)} type="button" aria-label="About" aria-current={section === "about" ? "page" : undefined} aria-controls="about-settings-panel" onClick={() => setSection("about")}><InfoIcon aria-hidden="true" /><span>About</span></button>
        </nav>
        <section className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5" id="general-settings-panel" aria-labelledby="general-settings-title" hidden={section !== "general"}>
          <h2 id="general-settings-title" className="mb-[22px] mt-0 text-[17px]">General</h2>
          <span className={settingsGroupLabel}>Account</span>
          <div className={cn(settingsCard, settingsRow)}>
            <span className={profileAvatar}>JD</span>
            <span className={cn(settingsRowCopy, "gap-[3px]")}><strong className="text-[12.5px]">John Doe</strong><small className="text-dim text-[11.5px]">john.doe@example.com</small></span>
            <button className="rounded-[7px] border-0 bg-[#e4e4e4] px-[9px] py-1.5 dark:bg-[#303030]" type="button">Sign out</button>
          </div>
          <span className={settingsGroupLabel}>Application</span>
          <div className={settingsCardStack}>
            <div className={settingsRow}>
              <span className={settingsRowCopy}><label htmlFor="app-theme"><strong>Theme</strong></label><small className="text-dim text-[11.5px]">Choose how Wisp looks on this device.</small></span>
              <Select items={THEME_OPTIONS} value={preferences.theme} onValueChange={(value) => {
                if (value !== null) onPreferencesChange({ ...preferences, theme: normalizeTheme(value) });
              }}>
                <SelectTrigger id="app-theme" className="w-28 shrink-0"><SelectValue /></SelectTrigger>
                <SelectContent align="end" alignItemWithTrigger={false}>
                  <SelectGroup>
                    {THEME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className={settingsRow}><span className={settingsRowCopy}><strong>Launch at login</strong><small className="text-dim text-[11.5px]">Open Wisp automatically when you sign in.</small></span><PreferenceSwitch label="Launch at login" checked={preferences.launchAtLogin} onChange={() => onPreferencesChange({ ...preferences, launchAtLogin: !preferences.launchAtLogin })} /></div>
            <div className={settingsRow}><span className={settingsRowCopy}><strong>Notification sounds</strong><small className="text-dim text-[11.5px]">Play a sound when a Wisp finishes or needs input.</small></span><PreferenceSwitch label="Notification sounds" checked={preferences.notificationSounds} onChange={() => onPreferencesChange({ ...preferences, notificationSounds: !preferences.notificationSounds })} /></div>
          </div>
          <GeneralSettingsSections preferences={preferences} onPreferencesChange={onPreferencesChange} />
        </section>
        <ModelSettingsSection active={section === "model"} />
        <section className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5" id="about-settings-panel" aria-labelledby="about-settings-title" hidden={section !== "about"}>
          <h2 id="about-settings-title" className="mb-[22px] mt-0 text-[17px]">About</h2>
          <span className={settingsGroupLabel}>Version</span>
          <div className={settingsCard}><div className={settingsRow}><span className={settingsRowCopy}><strong className="text-[12.5px]">Wisp Bot</strong><small className="text-dim text-[11.5px]">Version 0.1.0</small></span><button className={cn(iconButton, "disabled:opacity-50")} type="button" aria-label="Check for updates" title="Update checks are not available yet" disabled><RefreshCwIcon aria-hidden="true" /></button></div></div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

export { AppSettingsDialog };
export type { AppPreferences, AppSettingsDialogProps };
