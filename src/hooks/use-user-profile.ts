import { useEffect, useState } from "react";
import { EMPTY_USER_PROFILE, type UserProfile } from "../../shared/user-profile";

export function useUserProfile() {
  const [profile, setProfile] = useState<UserProfile>(EMPTY_USER_PROFILE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.wisp
      .getUserProfile()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setProfile(result.value);
        else setError(result.error.message);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setError("Your profile could not be loaded. Reopen the app to try again.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function save(next: UserProfile): Promise<boolean> {
    try {
      const result = await window.wisp.saveUserProfile(next);
      if (!result.ok) {
        setError(result.error.message);
        return false;
      }
      setProfile(result.value);
      setError(null);
      return true;
    } catch {
      setError("Your profile could not be saved. Please try again.");
      return false;
    }
  }
  return { profile, loading, error, save };
}

export type UserProfileController = ReturnType<typeof useUserProfile>;
