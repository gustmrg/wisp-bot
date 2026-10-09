export type ThemePreference = "system" | "light" | "dark";

export function normalizeTheme(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

// Only the last applied preference may follow the system theme.
let stopFollowingSystem = (): void => undefined;

export function applyTheme(preference: ThemePreference): () => void {
  stopFollowingSystem();
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

  function updateTheme() {
    const dark = preference === "dark" || (preference === "system" && systemTheme.matches);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    document.documentElement.classList.toggle("dark", dark);
  }

  updateTheme();
  if (preference !== "system") {
    stopFollowingSystem = () => undefined;
    return stopFollowingSystem;
  }

  systemTheme.addEventListener("change", updateTheme);
  const stop = (): void => systemTheme.removeEventListener("change", updateTheme);
  stopFollowingSystem = stop;
  return stop;
}
