# ADR 002: Desktop distribution, signing, and updates

- Status: Partially superseded by [ADR 007](007-release-automation.md). The platform matrix, signing, rollout, and release gates below were never put in place; ADR 007 records what ships. The persistence compatibility rules still apply.
- Date: 2026-09-02
- Owners: Wisp product, release operations, and security

## Platform matrix

The initial beta supports:

| Platform | Architecture | Minimum | Installer |
|---|---|---|---|
| Windows | x64 | Windows 11 23H2 | signed NSIS per-user installer |
| macOS | arm64, x64 | macOS 14 | signed and notarized DMG plus ZIP update payload |

Linux is a development/test platform, not a supported beta distribution target. Windows arm64 and macOS universal binaries are deferred until usage justifies their build and smoke-test cost. Each artifact is built on its native GitHub-hosted runner; no cross-signed release artifact is accepted.

## Tool choice

Use `electron-builder` for packaging/signing configuration and `electron-updater` for in-app updates. It supports the selected NSIS, DMG, and ZIP artifacts, native signing/notarization hooks, generated update metadata, GitHub Releases, channels, and staged rollout metadata without coupling the Vite renderer build to a second application framework.

Pin both packages exactly and commit the lockfile. Builds use `npm ci`, the package version, native runners, and checked-in configuration. Byte-for-byte installer reproducibility is not promised because native signatures and notarization timestamps vary; the unsigned application inputs, dependency graph, configuration, checksums, and source tag must be reproducible.

Rejected alternatives:

- Electron Forge: capable, but adopting its lifecycle and makers would add a second build abstraction to an already-working Vite/TypeScript pipeline; staged generic update metadata would still need custom operations.
- Electron Packager alone: too low-level; signing, DMG/NSIS production, metadata, publishing, and updates would be assembled separately.
- Squirrel.Windows: rejected in favor of NSIS because Wisp needs a straightforward per-user installer and electron-builder's supported update path.
- A custom updater: rejected because signature, downgrade, partial-download, and atomic-replacement mistakes are high impact.

## Identity, versions, and artifacts

- Application ID: `com.gustavomiranda.wispbot`
- Product name: `Wisp Bot`
- Version source: the exact `package.json` version; release tag must equal `v<version>`.
- Artifact pattern: `Wisp-Bot-${version}-${os}-${arch}.${ext}`.
- Icons: checked-in `build/icon.icns` and `build/icon.ico`, derived from the same source artwork; installer defaults are forbidden for releases.
- Channels: `beta` and `stable`. Prerelease versions such as `0.2.0-beta.1` publish only to beta. Stable versions never consume beta metadata.
- Downgrades are disabled in the updater.

## Update feed and rollout

GitHub Releases in `gustmrg/wisp-bot` owns signed artifacts, SHA-512 metadata, checksums, and channel manifests. Draft releases receive artifacts first. Promotion publishes the draft after verification; the updater reads only published releases over HTTPS.

Beta begins at 10% using electron-updater's staged rollout metadata, advances to 50%, then 100% after at least 24 hours at each step with no confirmed blocker. Stable begins at 5%, then 25%, 50%, and 100% with at least 48 hours at each step. Changing a rollout percentage requires an approved release-environment deployment and preserves the signed artifact and version.

Rollback means halting the current rollout, marking the release unavailable to new clients, and publishing a higher patch version containing the prior known-good code. The system never replaces a channel manifest with a lower version and never enables updater downgrades. A compromised signing identity stops all publishing until rotation is complete.

Clients more than two minor versions behind must update through the newest compatible release or download the current installer. Update metadata may declare a minimum supported application version; the UI links to the installer when an in-place path is unsafe.

## Signing and notarization

Windows release jobs use Azure Trusted Signing through GitHub OIDC. The GitHub `release` environment stores only non-secret account/profile identifiers; the job receives `id-token: write` and no long-lived certificate private key. The signing account limits access to the Wisp certificate profile and release workflow identity.

macOS release jobs import a Developer ID Application certificate from environment-protected GitHub Actions secrets into an ephemeral keychain. Notarization uses an App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) scoped to the Wisp team. The certificate archive password and API key are never printed or checked in. The keychain and temporary files are removed even on failure.

Only required release jobs receive credentials. Pull requests, forks, ordinary CI, renderer builds, and tests receive none. The `release` GitHub environment requires an operations reviewer; workflow permissions default to `contents: read`, with `contents: write` only for the publish job and `id-token: write` only for Windows signing.

Operations reviews signing access quarterly and after personnel changes. Rotation creates and validates a replacement, updates environment secrets/profile references, publishes a signed canary, then revokes the old identity. Suspected exposure immediately disables the environment and revokes the affected identity.

## Release gates

Release automation must fail unless all gates pass:

1. clean checkout; annotated tag, `package.json`, built application, and update metadata versions agree;
2. `npm ci`, lint, formatting, typecheck, tests, production build, and high-severity production dependency audit pass;
3. native unsigned package smoke passes before credential access;
4. signed installer installs, launches, preserves CSP/sandbox protections, runs a fake-agent request, and uninstalls on a clean native runner/VM;
5. Windows Authenticode and macOS codesign, Gatekeeper assessment, notarization, and stapling verify independently;
6. SHA-256 checksum files and electron-updater SHA-512 metadata are generated and retained with the artifacts;
7. an update from the previous channel version preserves conversations, encrypted credential readability, policy, audit log, and agent workspaces;
8. a rollback drill installs the higher-version rollback build over the candidate data directory;
9. artifacts upload to a draft release, receive operations approval, and only then become published/staged.

Artifacts and build logs are retained in Actions for 30 days; published installers, update metadata, checksums, and source tags are retained indefinitely. Logs must follow ADR 001 redaction and never upload user-data directories or keychains.

## Persistence compatibility and rollback

Every persisted format has an explicit schema version. Readers must accept the current and previous two released schemas; migrations are additive where possible, validate before replacement, and preserve a timestamped source backup. New readers ignore unknown optional fields. A release may not delete or irreversibly rewrite user data until all supported rollback builds can safely read it.

Installer/update tests copy a fixture containing conversations, Pi session identity, preferences, tool policy, encrypted-credential metadata, and audit history through upgrade and higher-version rollback. Secret test values use a fake encryption service and never production credentials. If a migration cannot remain backward-readable, the update is installer-only and creates a user-visible export/backup before migration.

## CI and operational approval

Product approval fixes the platform matrix, channels, rollout percentages, minimum-version policy, and GitHub Releases ownership in this ADR. Security approval fixes OIDC-based Windows signing, environment-gated macOS custody, least-privilege workflow permissions, native verification, and rotation. Changes to any of those decisions require a superseding ADR before release workflow mutation.
