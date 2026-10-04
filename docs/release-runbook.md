# Desktop release runbook

Wisp Bot ships these artifacts from GitHub Releases, which also hosts the update feeds:

| Platform | Architecture | Artifacts | Update feed |
| --- | --- | --- | --- |
| macOS 14+ | arm64, x64 | DMG, ZIP | `latest-mac.yml` |
| Linux | x64 | AppImage, `.deb` | `latest-linux.yml` |

Windows is not built yet. [ADR 007](decisions/007-release-automation.md) records the platform matrix and release flow.

## Signing

macOS builds are ad-hoc signed (`CSC_IDENTITY_AUTO_DISCOVERY: false`) and not notarized, because there is no Apple Developer account. Gatekeeper blocks the first launch of a downloaded build and may report it as damaged. Point users to [installing on macOS](installing-on-macos.md). Right-click → Open does not fix the "damaged" error.

Linux packages are unsigned. The updater checks each download against the SHA-512 in `latest-linux.yml`. See [installing on Linux](installing-on-linux.md).

## Publish a release

1. Merge everything for the release into `main`. Make sure CI passes and `npm run audit:prod` is clean, because the release fails on any high-severity production advisory.
2. Run **Desktop release** from `main` under GitHub Actions → Desktop release → Run workflow. Set **version** to `patch`, `minor`, `major`, or an exact version such as `1.2.0`, or `1.3.0-beta.1` for a prerelease.
3. The workflow:
   1. resolves the version on top of `main` and fails if its tag already exists;
   2. runs lint, formatting, typecheck, tests, build, the production audit, and the SBOM against the bumped tree;
   3. packages macOS (on `macos-14`) and Linux (on `ubuntu-latest`) in parallel;
   4. commits `chore(release): prepare vX.Y.Z` to `main` and pushes it with the `vX.Y.Z` tag in one atomic push;
   5. publishes the GitHub release with generated notes, every artifact, both update feeds, the SBOM, and `SHA256SUMS.txt`.
4. Download the artifacts and check them against `SHA256SUMS.txt`.

Nothing is committed or tagged until all checks and both packaging jobs pass, so a failed run leaves the repository unchanged. Fix the cause on `main` and run the workflow again. If someone pushes to `main` during the run, the atomic push fails. Run the workflow again to release the newer commit.

Versions with a prerelease suffix (`-beta.1`) are published as GitHub prereleases. Builds that run a prerelease version read the `beta` channel. Stable builds never read it.

To package locally, `npm run dist` builds installers for the current OS and `npm run dist:dir` builds an unpacked app. Both write to `release/` and never publish anything.

## In-app updates

Settings → About checks GitHub Releases only when asked and never downloads on its own.

- **Linux:** the AppImage and the `.deb` download and install in place. The `.deb` asks for the administrator password through `pkexec`.
- **macOS:** Squirrel.Mac only installs updates signed with a Developer ID. Ad-hoc builds show the new version and open the releases page for a manual download instead.

A download that fails verification stays an error and never reaches the restart-to-install state.

## Rollback

Downgrades are disabled, so persisted data never meets an older reader. To roll back, fix forward with a higher version that restores the previous behavior. To pull a broken release, delete it or mark it as a prerelease so that `latest*.yml` stops pointing at it. Keep earlier installers until the replacement is confirmed.

Never paste credentials or raw provider responses into release notes or logs.
