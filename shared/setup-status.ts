import type { AiSettingsView } from "./contracts.js";
import type { UserProfile } from "./user-profile.js";

/** Minimum configuration the app needs before a user can work with Wisps. */
export type SetupRequirement = "profile-name" | "default-model" | "provider-credential";

/** Model requirements: a global default model whose provider has a saved API key. */
export function missingModelSetup(view: AiSettingsView): SetupRequirement[] {
  const selection = view.selection;
  if (!selection) return ["default-model"];
  const provider = view.providers.find(({ id }) => id === selection.providerId);
  if (!provider) return ["default-model"];
  return provider.credentialConfigured ? [] : ["provider-credential"];
}

export function missingSetup(profile: UserProfile, view: AiSettingsView): SetupRequirement[] {
  const missing: SetupRequirement[] = profile.preferredName.trim() ? [] : ["profile-name"];
  return [...missing, ...missingModelSetup(view)];
}
