export interface UserProfile {
  preferredName: string;
}

export const EMPTY_USER_PROFILE: UserProfile = { preferredName: "" };
export const PROFILE_LIMITS = { preferredName: 80 } as const;

/** The profile in a request or in `user-profile.json`. Keys it does not know are left out. */
export function normalizeUserProfile(value: unknown): UserProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid user profile.");
  const { preferredName } = value as Record<string, unknown>;
  if (typeof preferredName !== "string" || preferredName.length > PROFILE_LIMITS.preferredName)
    throw new Error("Invalid user profile.");
  return {
    preferredName: preferredName
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .trim()
      .replace(/\s+/g, " "),
  };
}
