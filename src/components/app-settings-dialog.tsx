import { BellIcon, CircleUserRoundIcon, InfoIcon, KeyboardIcon, SettingsIcon } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface AppPreferences {
  launchAtLogin: boolean;
  notificationSounds: boolean;
}

interface AppSettingsDialogProps {
  open: boolean;
  preferences: AppPreferences;
  onOpenChange: (open: boolean) => void;
  onPreferencesChange: (preferences: AppPreferences) => void;
}

function PreferenceSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return <button className="switch" data-on={checked} type="button" role="switch" aria-checked={checked} aria-label={label} onClick={onChange}><span /></button>;
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
            <div className="settings-row"><span><strong>Launch at login</strong><small>Open Wisp automatically when you sign in.</small></span><PreferenceSwitch label="Launch at login" checked={preferences.launchAtLogin} onChange={() => onPreferencesChange({ ...preferences, launchAtLogin: !preferences.launchAtLogin })} /></div>
            <div className="settings-row"><span><strong>Notification sounds</strong><small>Play a sound when a Wisp finishes or needs input.</small></span><PreferenceSwitch label="Notification sounds" checked={preferences.notificationSounds} onChange={() => onPreferencesChange({ ...preferences, notificationSounds: !preferences.notificationSounds })} /></div>
          </div>
          <span className="settings-group-label">Version</span>
          <div className="settings-card"><div className="settings-row"><span><strong>Wisp Bot</strong><small>Version 0.1.0 · You are up to date.</small></span><CircleUserRoundIcon /></div></div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

export { AppSettingsDialog };
export type { AppPreferences, AppSettingsDialogProps };
