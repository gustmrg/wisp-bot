/**
 * Links a Wisp can put in a reply to open a screen of the app, such as
 * `wisp://settings/model`. The app's guide uses them, and the renderer turns
 * them into buttons; anything else with the `wisp:` scheme is not a link.
 */

/** The panels of the application settings dialog, in its navigation order. */
export const APP_SETTINGS_SECTIONS = [
  "general",
  "connections",
  "remote-access",
  "model",
  "voice",
  "plugins",
  "mcp",
  "jobs",
  "usage",
  "storage",
  "notifications",
  "shortcuts",
  "about",
] as const;

export type AppSettingsSection = (typeof APP_SETTINGS_SECTIONS)[number];

/** The pages of one Wisp's own settings. */
export const WISP_SETTINGS_SECTIONS = [
  "profile",
  "model",
  "access",
  "usage",
  "memory",
  "skills",
  "workspace",
  "execution",
  "jobs",
] as const;

export type WispSettingsSection = (typeof WISP_SETTINGS_SECTIONS)[number];

/** A screen a link opens: a settings panel, or a page of the settings of the Wisp the link was sent in. */
export type AppLink =
  | { scope: "settings"; section: AppSettingsSection }
  | { scope: "wisp"; section: WispSettingsSection };

const APP_LINK_PATTERN = /^wisp:\/\/(settings|wisp)\/([a-z-]+)\/?$/;

export function parseAppLink(href: string): AppLink | null {
  const match = APP_LINK_PATTERN.exec(href.trim());
  if (!match) return null;
  const [, scope, section = ""] = match;
  if (scope === "settings" && (APP_SETTINGS_SECTIONS as ReadonlyArray<string>).includes(section)) {
    return { scope, section: section as AppSettingsSection };
  }
  if (scope === "wisp" && (WISP_SETTINGS_SECTIONS as ReadonlyArray<string>).includes(section)) {
    return { scope, section: section as WispSettingsSection };
  }
  return null;
}

export function appLinkHref(link: AppLink): string {
  return `wisp://${link.scope}/${link.section}`;
}
