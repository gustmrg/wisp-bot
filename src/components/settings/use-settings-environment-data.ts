import { useCallback, useEffect, useMemo, useState } from "react";

import type { ChatView } from "@/chat-data";
import type { UserProfileController } from "@/hooks/use-user-profile";
import { chatViews } from "@/lib/chat-schema";
import type { WispOption } from "@/lib/plugin-access";
import type { WispApi } from "../../../shared/contracts";
import type { ChatSummaryCollection, WispCollection } from "../../../shared/conversations";
import { EMPTY_USER_PROFILE, type UserProfile } from "../../../shared/user-profile";

export interface SettingsEnvironmentData {
  wisps: ReadonlyArray<WispOption> | undefined;
  conversations: ReadonlyArray<ChatView> | undefined;
  userProfile: UserProfileController;
}

function wispsToOptions(wisps: WispCollection): WispOption[] {
  return Object.values(wisps).map((wisp) => ({
    id: wisp.id,
    name: wisp.name,
    appearance: wisp.appearance,
    ...(wisp.color ? { color: wisp.color } : {}),
  }));
}

/**
 * Resolves the Wisps, conversations, and user profile for the environment currently
 * selected in Settings.
 *
 * When inspecting the active workspace environment, returns the props already loaded
 * by `App.tsx` with zero extra fetches. When inspecting another connected environment,
 * loads its state and profile through the scoped `api` and keeps Wisps live via
 * `api.subscribeToWisps`.
 */
export function useSettingsEnvironmentData({
  open,
  isActiveEnvironment,
  isSelectedConnected,
  selectedEnvironmentId,
  api,
  activeWisps,
  activeConversations,
  activeUserProfile,
}: {
  open: boolean;
  isActiveEnvironment: boolean;
  isSelectedConnected: boolean;
  selectedEnvironmentId: string;
  api: WispApi;
  activeWisps: ReadonlyArray<WispOption> | undefined;
  activeConversations: ReadonlyArray<ChatView> | undefined;
  activeUserProfile: UserProfileController;
}): SettingsEnvironmentData {
  const [remoteState, setRemoteState] = useState<{
    envId: string;
    chats: ChatSummaryCollection;
    wisps: WispCollection;
  } | null>(null);

  const [remoteProfile, setRemoteProfile] = useState<{
    envId: string;
    profile: UserProfile;
    loading: boolean;
    error: string | null;
  }>({
    envId: "",
    profile: EMPTY_USER_PROFILE,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!open || isActiveEnvironment || !isSelectedConnected) return;
    let cancelled = false;
    setRemoteState(null);
    setRemoteProfile({
      envId: selectedEnvironmentId,
      profile: EMPTY_USER_PROFILE,
      loading: true,
      error: null,
    });

    const unsubscribeWisps = api.subscribeToWisps((view) => {
      if (cancelled) return;
      setRemoteState((current) => ({
        envId: selectedEnvironmentId,
        chats: current?.envId === selectedEnvironmentId ? current.chats : {},
        wisps: view.wisps,
      }));
    });

    void api
      .getConversationState()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setRemoteState({
            envId: selectedEnvironmentId,
            chats: result.value.chats,
            wisps: result.value.wisps,
          });
        }
      })
      .catch(() => undefined);

    void api
      .getUserProfile()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setRemoteProfile({
            envId: selectedEnvironmentId,
            profile: result.value,
            loading: false,
            error: null,
          });
        } else {
          setRemoteProfile({
            envId: selectedEnvironmentId,
            profile: EMPTY_USER_PROFILE,
            loading: false,
            error: result.error.message,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRemoteProfile({
            envId: selectedEnvironmentId,
            profile: EMPTY_USER_PROFILE,
            loading: false,
            error: "Your profile could not be loaded. Try again.",
          });
        }
      });

    return () => {
      cancelled = true;
      unsubscribeWisps();
    };
  }, [open, isActiveEnvironment, isSelectedConnected, selectedEnvironmentId, api]);

  const saveRemoteProfile = useCallback(
    async (next: UserProfile): Promise<boolean> => {
      try {
        const result = await api.saveUserProfile(next);
        if (!result.ok) {
          setRemoteProfile((current) => ({ ...current, error: result.error.message }));
          return false;
        }
        setRemoteProfile({
          envId: selectedEnvironmentId,
          profile: result.value,
          loading: false,
          error: null,
        });
        return true;
      } catch {
        setRemoteProfile((current) => ({ ...current, error: "Your profile could not be saved. Please try again." }));
        return false;
      }
    },
    [api, selectedEnvironmentId],
  );

  const remoteWisps = useMemo(() => {
    if (!remoteState || remoteState.envId !== selectedEnvironmentId) return [];
    return wispsToOptions(remoteState.wisps);
  }, [remoteState, selectedEnvironmentId]);

  const remoteConversations = useMemo(() => {
    if (!remoteState || remoteState.envId !== selectedEnvironmentId) return [];
    return Object.values(chatViews(remoteState.chats, remoteState.wisps));
  }, [remoteState, selectedEnvironmentId]);

  const remoteProfileController = useMemo<UserProfileController>(() => {
    const matches = remoteProfile.envId === selectedEnvironmentId;
    return {
      profile: matches ? remoteProfile.profile : EMPTY_USER_PROFILE,
      loading: matches ? remoteProfile.loading : true,
      error: matches ? remoteProfile.error : null,
      save: saveRemoteProfile,
    };
  }, [remoteProfile, selectedEnvironmentId, saveRemoteProfile]);

  if (isActiveEnvironment) {
    return {
      wisps: activeWisps,
      conversations: activeConversations,
      userProfile: activeUserProfile,
    };
  }

  return {
    wisps: remoteWisps,
    conversations: remoteConversations,
    userProfile: remoteProfileController,
  };
}
