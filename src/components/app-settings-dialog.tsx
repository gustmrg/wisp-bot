import { BellIcon, InfoIcon, KeyboardIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";

import { GeneralSettingsSections, PreferenceSwitch } from "@/components/general-settings-sections";
import type { AppPreferences } from "@/lib/app-preferences";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { normalizeTheme } from "@/lib/theme";

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

function AppSettingsDialog({ open, preferences, onOpenChange, onPreferencesChange }: AppSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="app-settings-dialog">
        <DialogHeader className="sr-only"><DialogTitle>Wisp settings</DialogTitle><DialogDescription>Manage your account and application preferences.</DialogDescription></DialogHeader>
        <nav aria-label="Settings sections">
          <strong>Settings</strong>
          <button className="selected" type="button"><SettingsIcon /><span>General</span></button>
          <button type="button"><BellIcon /><span>Notifications</span></button>
          <button type="button"><KeyboardIcon /><span>Shortcuts</span></button>
          <button type="button"><InfoIcon /><span>About</span></button>
        </nav>
        <section className="settings-content">
          <h2>General</h2>
          <span className="settings-group-label">Account</span>
          <div className="settings-card account-card">
            <span className="profile-avatar">GM</span>
            <span><strong>Gustavo Miranda</strong><small>gustmrg@gmail.com</small></span>
            <button type="button">Sign out</button>
          </div>
          <span className="settings-group-label">Application</span>
          <div className="settings-card">
            <div className="settings-row">
              <span><label htmlFor="app-theme"><strong>Theme</strong></label><small>Choose how Wisp looks on this device.</small></span>
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
            <div className="settings-row"><span><strong>Launch at login</strong><small>Open Wisp automatically when you sign in.</small></span><PreferenceSwitch label="Launch at login" checked={preferences.launchAtLogin} onChange={() => onPreferencesChange({ ...preferences, launchAtLogin: !preferences.launchAtLogin })} /></div>
            <div className="settings-row"><span><strong>Notification sounds</strong><small>Play a sound when a Wisp finishes or needs input.</small></span><PreferenceSwitch label="Notification sounds" checked={preferences.notificationSounds} onChange={() => onPreferencesChange({ ...preferences, notificationSounds: !preferences.notificationSounds })} /></div>
          </div>
          <GeneralSettingsSections preferences={preferences} onPreferencesChange={onPreferencesChange} />
          <span className="settings-group-label">Version</span>
          <div className="settings-card"><div className="settings-row"><span><strong>Wisp Bot</strong><small>Version 0.1.0</small></span><button className="icon-button" type="button" aria-label="Check for updates" title="Update checks are not available yet" disabled><RefreshCwIcon aria-hidden="true" /></button></div></div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

export { AppSettingsDialog };
export type { AppPreferences, AppSettingsDialogProps };
