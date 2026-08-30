export type ThemePreference = "system" | "light" | "dark";

export function normalizeTheme(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function applyTheme(preference: ThemePreference): () => void {
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

  function updateTheme() {
    const dark = preference === "dark" || (preference === "system" && systemTheme.matches);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    document.documentElement.classList.toggle("dark", dark);
  }

  updateTheme();
  if (preference !== "system") return () => {};

  systemTheme.addEventListener("change", updateTheme);
  return () => systemTheme.removeEventListener("change", updateTheme);
}
