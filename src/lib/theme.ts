export type ThemePreference = "system" | "light" | "dark";

export function normalizeTheme(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/** Keep equal to `--background` in styles.css and the theme-color tags in web/index.html. */
const THEME_COLORS = { light: "#ffffff", dark: "#0a0a0a" } as const;

// Only the last applied preference may follow the system theme.
let stopFollowingSystem = (): void => undefined;

export function applyTheme(preference: ThemePreference): () => void {
  stopFollowingSystem();
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

  function updateTheme() {
    const dark = preference === "dark" || (preference === "system" && systemTheme.matches);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    document.documentElement.classList.toggle("dark", dark);
    // The tags choose by the system theme, which a preference may contradict, so both take the app's color.
    for (const tag of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      tag.content = dark ? THEME_COLORS.dark : THEME_COLORS.light;
    }
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

/** Without Wisp colors, conversations keep the neutral look; the styles that tint them check this. */
export function applyWispColors(enabled: boolean): void {
  if (enabled) delete document.documentElement.dataset.wispColors;
  else document.documentElement.dataset.wispColors = "off";
}
