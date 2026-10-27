# ADR 031: Unsigned Windows x64 releases

- Status: Accepted
- Date: 2026-10-27
- Decision owners: Wisp maintainer
- Scope: The Windows platform in the release matrix, its installer, signing,
  and updates
- Related: [ADR 002](002-distribution.md), [ADR 007](007-release-automation.md),
  [ADR 013](013-ssh-questions.md)

## Context

[ADR 007](007-release-automation.md) deferred Windows and removed its
electron-builder and Azure Trusted Signing configuration, because no signing
credentials existed. The app itself already runs on Windows: credentials are
encrypted with DPAPI through `safeStorage`, notifications use the installer's
AppUserModelID, and the Tailscale, Claude Code, and atomic-file code paths
handle `win32`. Only the packaging was missing.

The maintainer does not want to pay for or manage a code-signing certificate.

## Decision

| Platform | Architecture | Artifacts | Signing |
| --- | --- | --- | --- |
| Windows 10 and 11 | x64 | NSIS installer (`.exe`) | unsigned; updates verified by SHA-512 |

- The installer is per-user (`perMachine: false`), installs to
  `%LOCALAPPDATA%\Programs`, and needs no administrator rights. It is assisted
  (`oneClick: false`) and keeps the default installation folder.
- The **Desktop release** workflow packages it on `windows-latest`, beside
  macOS and Linux, from the same version and with the same gates. Its steps
  run in bash, as on the other runners.
- Betas wear the amber dev icon, as on the other platforms.
- In-app updates install in place through `electron-updater`. Without a
  `publisherName`, it does not check an Authenticode signature, so it checks
  the download against the SHA-512 in `latest.yml` (or `beta.yml`) only.
- arm64 is not built.

## Consequences

- SmartScreen warns on the first launch of every downloaded installer
  ("Windows protected your PC"), and browsers may warn on download. Users
  choose **More info → Run anyway**; see
  [installing on Windows](../installing-on-windows.md).
- Updates replace the app without a new warning, because they run from the
  installed app rather than from a download.
- A compromised release or update feed would not be caught by a signature
  check. The SHA-512 in the feed and `SHA256SUMS.txt` come from the same
  release, so they protect against corrupted downloads, not a tampered release.
- Features that are Linux-only stay unavailable: launch at login shows a
  disabled toggle. SSH keeps `BatchMode`, so a server needs key authentication
  that works without a prompt ([ADR 013](013-ssh-questions.md)).
- Running commands in a Wisp's container needs Docker Desktop or Podman on the
  Windows computer ([ADR 017](017-container-execution.md)).
- CI tests still run on Linux only. A Windows regression shows up in the
  packaged app, not in a test run.

## Deferred

- Code signing. Adding it needs a new ADR that sets up credential custody, as
  ADR 007 requires.
- Windows arm64.
- Launch at login on Windows, through `app.setLoginItemSettings`.
- An SSH askpass helper for Windows.
- A Windows test job in CI.

## Decisions taken with the user

- Ship Windows without code signing.
- Build x64 only; leave arm64 out.

## Rejected alternatives

- **Azure Trusted Signing:** removes the SmartScreen warning sooner, but
  costs a monthly fee and needs identity validation. Rejected by the
  maintainer.
- **A portable `.exe` or a ZIP:** neither updates in place through
  `electron-updater`, and both would leave data and shortcuts to the user.
- **Squirrel.Windows:** rejected in [ADR 002](002-distribution.md) in favor of
  NSIS, and nothing has changed.
