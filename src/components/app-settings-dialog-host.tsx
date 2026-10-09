import { forwardRef, useImperativeHandle, useState } from "react";

import type { PluginId } from "../../shared/plugins";

import {
  AppSettingsDialog,
  type AppSettingsDialogProps,
  type SettingsEntrySection,
} from "@/components/app-settings-dialog";

export interface AppSettingsDialogHandle {
  open(section: SettingsEntrySection, pluginId?: PluginId, storageConversationId?: string): void;
}

type AppSettingsDialogHostProps = Omit<
  AppSettingsDialogProps,
  "open" | "initialSection" | "initialPluginId" | "initialStorageConversationId" | "onOpenChange"
>;

/**
 * Owns the open state for the settings dialog so that opening or closing it does
 * not re-render the workspace tree the dialog is hosted beside (App state changes
 * there would re-render Sidebar and ChatPanel on every open).
 */
export const AppSettingsDialogHost = forwardRef<AppSettingsDialogHandle, AppSettingsDialogHostProps>(
  function AppSettingsDialogHost({ onOpenConversations, ...dialogProps }, ref) {
    const [section, setSection] = useState<SettingsEntrySection | null>(null);
    const [pluginId, setPluginId] = useState<PluginId | undefined>();
    const [storageConversationId, setStorageConversationId] = useState<string | undefined>();
    useImperativeHandle(
      ref,
      () => ({
        open: (next, nextPluginId, nextStorageConversationId) => {
          setSection(next);
          setPluginId(nextPluginId);
          setStorageConversationId(nextStorageConversationId);
        },
      }),
      [],
    );
    return (
      <AppSettingsDialog
        {...dialogProps}
        open={section !== null}
        initialSection={section ?? "general"}
        initialPluginId={pluginId}
        initialStorageConversationId={storageConversationId}
        onOpenChange={(nextOpen) => {
          setSection(nextOpen ? "general" : null);
          setPluginId(undefined);
          setStorageConversationId(undefined);
        }}
        onOpenConversations={() => {
          setSection(null);
          onOpenConversations?.();
        }}
      />
    );
  },
);

export type { AppSettingsDialogProps };
