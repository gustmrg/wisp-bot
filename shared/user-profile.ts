export interface UserProfile {
  preferredName: string;
  aboutYou: string;
  responsePreferences: string;
}

export const EMPTY_USER_PROFILE: UserProfile = { preferredName: "", aboutYou: "", responsePreferences: "" };
export const PROFILE_LIMITS = { preferredName: 80, aboutYou: 2000, responsePreferences: 2000 } as const;

export function normalizeUserProfile(value: unknown): UserProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid user profile.");
  const raw = value as Record<string, unknown>;
  const profile = { ...EMPTY_USER_PROFILE };
  for (const key of Object.keys(PROFILE_LIMITS) as Array<keyof UserProfile>) {
    if (typeof raw[key] !== "string" || raw[key].length > PROFILE_LIMITS[key]) throw new Error("Invalid user profile.");
    profile[key] = raw[key].replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  }
  profile.preferredName = profile.preferredName.replace(/\s+/g, " ");
  return profile;
}
