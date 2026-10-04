import { useEffect, useState } from "react";

import { missingSetup, type SetupRequirement } from "../../shared/setup-status";
import type { UserProfileController } from "@/hooks/use-user-profile";

export type SetupGate =
  | { phase: "checking" }
  | { phase: "error"; message: string; retry: () => void }
  | { phase: "onboarding"; required: SetupRequirement[]; complete: () => void }
  | { phase: "ready" };

/**
 * Decides once per launch whether the minimum setup is in place. Settings
 * changed later in the session do not send the user back to onboarding; the
 * next launch checks again.
 */
export function useSetupGate(userProfile: UserProfileController): SetupGate {
  const [phase, setPhase] = useState<"checking" | "onboarding" | "ready">("checking");
  const [required, setRequired] = useState<SetupRequirement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const profileLoading = userProfile.loading;
  const profile = userProfile.profile;

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed load.
  useEffect(() => {
    if (phase !== "checking" || profileLoading) return;
    let cancelled = false;
    setError(null);
    void window.wisp
      .getAiSettings()
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        const missing = missingSetup(profile, result.value);
        setRequired(missing);
        setPhase(missing.length ? "onboarding" : "ready");
      })
      .catch(() => {
        if (!cancelled) setError("Could not load AI model settings.");
      });
    return () => {
      cancelled = true;
    };
  }, [phase, profileLoading, profile, attempt]);

  if (phase === "ready") return { phase };
  if (phase === "onboarding") return { phase, required, complete: () => setPhase("ready") };
  if (error) return { phase: "error", message: error, retry: () => setAttempt((value) => value + 1) };
  return { phase: "checking" };
}
