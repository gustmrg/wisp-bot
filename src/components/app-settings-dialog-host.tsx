import { forwardRef, useImperativeHandle, useState } from "react";

import type { SettingsPluginId } from "@/lib/plugin-access";

import {
  AppSettingsDialog,
  type AppSettingsDialogProps,
  type SettingsEntrySection,
} from "@/components/app-settings-dialog";
import type { WispTemplateEntry } from "../../shared/wisp-template";

export interface AppSettingsDialogHandle {
  open(section: SettingsEntrySection, pluginId?: SettingsPluginId, storageConversationId?: string): void;
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
  function AppSettingsDialogHost({ onOpenConversations, onOpenApprovals, onCustomizeTemplate, ...dialogProps }, ref) {
    const [section, setSection] = useState<SettingsEntrySection | null>(null);
    const [pluginId, setPluginId] = useState<SettingsPluginId | undefined>();
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
        {...(onCustomizeTemplate
          ? {
              onCustomizeTemplate: (entry: WispTemplateEntry) => {
                // Settings closes so the creation dialog it opens is the one in front.
                setSection(null);
                onCustomizeTemplate(entry);
              },
            }
          : {})}
        onOpenConversations={() => {
          setSection(null);
          onOpenConversations?.();
        }}
        onOpenApprovals={
          onOpenApprovals
            ? () => {
                setSection(null);
                onOpenApprovals();
              }
            : undefined
        }
      />
    );
  },
);

export type { AppSettingsDialogProps };
