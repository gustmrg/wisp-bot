# Application settings and status

**Settings** (application-level) has panels for **General**, **AI Model**,
**Plugins**, **MCP servers**, **Token usage**, and **About**. The
**Notifications** and **Shortcuts** navigation entries are disabled and
marked **Soon** until their panels exist.

## General

- **Your profile** — preferred name, optional background, and response preferences. Saved locally in `user-profile.json` and shared with every Wisp (and its AI provider when chatting). Changes refresh existing Wisp context; busy Wisps apply the refresh after their current turn. Blank fields remove that profile context. The preferred name also supplies the sidebar name and initials.
- **Application** — theme, launch at login, and notification sounds.
- **System** — microphone selection and hardware acceleration preferences.
- **Wisp** — timezone and auto-review. Auto-review shows one Allow / Ask /
  Block choice for **Create files** and one for **Modify files**; turning
  auto-review off makes Wisp ask before every file change and disables the
  choices. **Always allow** and **Always block** on an approval card change
  the same choices. Integration blocks added from approval prompts are listed below them
  (see [security](security.md) for how rules are applied).

Settings that are saved but not wired to the desktop yet (launch at login,
microphone, hardware acceleration, timezone) are shown disabled with a
**Soon** badge.

**Plugins** and **MCP servers** open each connection in place, inside the
settings dialog. Removing a connection or a provider API key asks for an
inline confirmation first.

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
- Hardware acceleration and timezone (saved, but not read by the desktop or by
  Wisps).
- The Shortcuts settings panel (the `Cmd/Ctrl+K` search dialog itself works).
- **Circles** are feature-flagged (`VITE_FEATURE_CIRCLES`) and cannot run
  their own model sessions; the create dialog currently only creates Wisps.
