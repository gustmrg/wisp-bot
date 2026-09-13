# Application settings and status

**Settings** (application-level) has panels for **General**, **AI Model**,
**Plugins**, **MCP servers**, **Token usage**, and **About**. The
**Notifications** and **Shortcuts** navigation entries are placeholders
without panels yet.

## General

- **Account** — shows a demo identity; sign-out is not connected yet.
- **Application** — theme, launch at login, and notification sounds.
- **System** — microphone selection and hardware acceleration preferences.
- **Wisp** — timezone and auto-review rules (see
  [security](security.md) for how rules are applied).

Preferences are stored locally in the renderer. Desktop integration for some
of them is not wired up yet — see "Not connected yet" below.

## Notification sounds

The renderer plays a synthesized two-note chime when a Wisp finishes its turn
and a second, falling tone when one awaits a tool approval. Sounds are gated
by the app-level **Notification sounds** setting and the per-Wisp notification
toggle.

## Updates (About)

Installed releases expose explicit check, download, and restart-to-install
update states; checking is manual only and nothing downloads automatically.
The update feed is disabled in development ("Updates are available only in an
installed release"). macOS artifacts are currently ad-hoc signed rather than
notarized, so updates there fall back to a manual-download state that opens
the releases page — see [installing on macOS](installing-on-macos.md).

## Not connected yet

- Microphone capture and voice input.
- Launch at login (the preference is saved, nothing is registered).
- Sign-out.
- The Shortcuts settings panel (the `Cmd/Ctrl+K` search dialog itself works).
- **Circles** are feature-flagged (`VITE_FEATURE_CIRCLES`) and cannot run
  their own model sessions; the create dialog currently only creates Wisps.
