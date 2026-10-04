import { forwardRef, useImperativeHandle, useState } from "react";

import {
  AppSettingsDialog,
  type AppSettingsDialogProps,
  type SettingsEntrySection,
} from "@/components/app-settings-dialog";

export interface AppSettingsDialogHandle {
  open(section: SettingsEntrySection): void;
}

type AppSettingsDialogHostProps = Omit<AppSettingsDialogProps, "open" | "initialSection" | "onOpenChange">;

/**
 * Owns the open state for the settings dialog so that opening or closing it does
 * not re-render the workspace tree the dialog is hosted beside (App state changes
 * there would re-render Sidebar and ChatPanel on every open).
 */
export const AppSettingsDialogHost = forwardRef<AppSettingsDialogHandle, AppSettingsDialogHostProps>(
  function AppSettingsDialogHost({ onOpenConversations, ...dialogProps }, ref) {
    const [section, setSection] = useState<SettingsEntrySection | null>(null);
    useImperativeHandle(ref, () => ({ open: (next) => setSection(next) }), []);
    return (
      <AppSettingsDialog
        {...dialogProps}
        open={section !== null}
        initialSection={section ?? "general"}
        onOpenChange={(nextOpen) => setSection(nextOpen ? "general" : null)}
        onOpenConversations={() => {
          setSection(null);
          onOpenConversations?.();
        }}
      />
    );
  },
);

export type { AppSettingsDialogProps };
