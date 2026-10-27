# Desktop release runbook

Wisp Bot ships these artifacts from GitHub Releases, which also hosts the update feeds:

| Platform | Architecture | Artifacts | Update feed |
| --- | --- | --- | --- |
| macOS 14+ | arm64 | DMG, ZIP | `latest-mac.yml`, or `beta-mac.yml` for a beta |
| Linux | x64 | AppImage, `.deb` | `latest-linux.yml`, or `beta-linux.yml` for a beta |
| Windows 10 and 11 | x64 | NSIS installer (`.exe`) | `latest.yml`, or `beta.yml` for a beta |

[ADR 007](decisions/007-release-automation.md) records the platform matrix and release flow, [ADR 031](decisions/031-unsigned-windows-release.md) the Windows build, and [ADR 020](decisions/020-development-workflow.md) the branch strategy: changes reach `main` through pull requests, betas are cut from `main`, and a release promotes the beta line.

## Signing

macOS builds are ad-hoc signed (`CSC_IDENTITY_AUTO_DISCOVERY: false`) and not notarized, because there is no Apple Developer account. Gatekeeper blocks the first launch of a downloaded build and may report it as damaged. Point users to [installing on macOS](installing-on-macos.md). Right-click → Open does not fix the "damaged" error.

Linux packages are unsigned. The updater checks each download against the SHA-512 in `latest-linux.yml`. See [installing on Linux](installing-on-linux.md).

The Windows installer is not code-signed. SmartScreen warns on its first launch, and the updater checks each download against the SHA-512 in `latest.yml`. See [installing on Windows](installing-on-windows.md).

## Publish a release

1. Merge everything for the release into `main`. Make sure CI passes and `npm run audit:prod` is clean, because the release fails on any high-severity production advisory.
2. Run **Desktop release** from `main` under GitHub Actions → Desktop release → Run workflow. Set **version** to `minor` to promote the betas, or to `patch`, `major`, or an exact version such as `1.2.0`. For a beta, see [Publish a beta](#publish-a-beta).

   While a beta is out, a release must sort above it, or beta installs would never update to it. With `0.19.0-beta.2` out, `patch` (`0.18.1`) fails and names `0.19.0` instead, so release `minor`.
3. The workflow:
   1. resolves the version on top of `main`, and fails if its tag already exists or if any install already runs a higher version;
   2. runs lint, formatting, typecheck, tests, build, the production audit, and the SBOM against the bumped tree, while it packages macOS (on `macos-14`), Linux (on `ubuntu-latest`), and Windows (on `windows-latest`) at the same time;
   3. commits `chore(release): prepare vX.Y.Z` to `main` and pushes it with the `vX.Y.Z` tag in one atomic push;
   4. drafts the GitHub release with notes generated since the previous release, every artifact, every update feed, the SBOM, and `SHA256SUMS.txt`;
   5. publishes the server to npm and waits until npm serves it (see [The server package on npm](#the-server-package-on-npm));
   6. publishes the draft, which is when installs can see the update.
4. Download the artifacts and check them against `SHA256SUMS.txt`.

`main` only takes pull requests. The release job pushes with the write deploy key stored in the `RELEASE_DEPLOY_KEY` secret, and **Deploy keys** are the only bypass actor of the `main` ruleset. If that secret or the bypass is missing, the push is rejected with `GH013: Repository rule violations` and nothing is committed or tagged. To rotate the key, add a new write deploy key, replace the secret, then delete the old key.

Nothing is committed or tagged until all checks and every packaging job pass, so a failed run leaves the repository unchanged. Fix the cause on `main` and run the workflow again. If someone pushes to `main` during the run, the atomic push fails. Run the workflow again to release the newer commit.

## Publish a beta

A beta puts what `main` holds in front of real installs before it becomes a release.

1. Merge the changes into `main` and make sure CI passes.
2. Run **Desktop release** from `main` with **version** set to `beta`. The workflow picks the next minor version's next beta: with `main` at `0.18.0`, that is `0.19.0-beta.1`, then `0.19.0-beta.2`. An exact version such as `0.19.0-beta.5` works too. Only `-beta.N` versions are accepted.
3. The workflow runs the same gates and packaging as a release. It then commits the version on top of `main`, tags it, and pushes only the tag, so `main` does not take the beta's version. The GitHub release is marked as a prerelease, its notes list what changed since the version before it, and the server goes to npm under the `beta` dist-tag.
4. Repeat as more changes land. When the betas hold up, [publish a release](#publish-a-release) with `minor`.

To try one branch on its own, run the workflow from that branch with `beta` and **preview_branch** checked. Without it, a beta from a branch other than `main` fails. Such a beta carries none of the fixes on `main` that the branch lacks, so keep it for changes too risky to merge first.

Builds that run a beta read the `beta` channel and update to newer betas. Stable builds never read it. When the next release ships, its version is higher than every beta before it, so beta installs update to it and return to the stable channel.

Betas share their data with stable installs on the same computer and server. Before a build upgrades a database, it copies the old one beside it as `conversations.sqlite.v<N>.backup` (and `server.sqlite.v<N>.backup` on a server), keeping the newest three. A beta that ships an upgrade must never change it in a later beta: a fix is a new upgrade with a new version. Prefer additive upgrades, which older builds can still read.

To package locally, `npm run dist` builds installers for the current OS and `npm run dist:dir` builds an unpacked app. Both write to `release/` and never publish anything.

## The server package on npm

`@gustmrg/wisp-server` is the headless server that `npx @gustmrg/wisp-server setup` installs, and that the desktop app installs on a machine over SSH. The app always installs its own version, so every release publishes the matching one; a version missing from npm makes **Install the Wisp server** fail with "is not published on npm".

The **publish-server** job builds `npm run package:server` from the release tag, updates npm to 11.5.1 or later, and runs `npm publish --provenance`. Prereleases (`-beta.1`) get the `beta` dist-tag, so `npx @gustmrg/wisp-server` never runs one. The package's page on npm shows `server/README.md`.

npm takes a few minutes to process a new version, and until then installing it fails with `ETARGET`. So the job then waits, for up to 10 minutes, until npm serves the version and its dist-tag points to it. The release is done only when that step passes; until then, do not update servers from the app.

The job runs while the GitHub release is still a draft, which the updater does not see, and the last job, **publish-release**, publishes the draft only after it passes. So no install updates to a version whose server npm cannot serve yet. If the job fails, the tag and the draft stay as they are: fix the cause and re-run the failed jobs. A re-run skips the publish when the version is already on npm, since npm refuses a version published twice, and only waits for it.

### Authentication

npm authenticates the job with **trusted publishing**: an OIDC identity of this repository's `release.yml`, with no secret to store or renew. npm only lets a package that already exists use it, so the first version is published with a token:

1. The account `gustmrg` owns the `@gustmrg` scope. Turn on two-factor authentication for it.
2. **First release only:** on npmjs.com, create a granular access token (**Access Tokens → Generate New Token**) with read and write access to packages, **Bypass 2FA** checked (CI cannot answer a 2FA prompt), and a short expiration. Store it as the repository secret `NPM_TOKEN`, then run the release.
3. Once the version is on npm, open the package's **Settings → Trusted Publisher**, choose GitHub Actions, and enter the repository `gustmrg/wisp-bot` and the workflow `release.yml`. Then delete the `NPM_TOKEN` secret and revoke the token on npm.

Later releases need nothing else. npm prefers the OIDC identity when it is available, so a token left behind is unused, but it remains a credential that can publish; revoke it.

## In-app updates

Settings → About checks GitHub Releases only when asked and never downloads on its own.

- **Linux:** the AppImage and the `.deb` download and install in place. The `.deb` asks for the administrator password through `pkexec`.
- **Windows:** the installer downloads and installs in place when the app restarts, without administrator rights.
- **macOS:** Squirrel.Mac only installs updates signed with a Developer ID. Ad-hoc builds show the new version and open the releases page for a manual download instead.

A download that fails verification stays an error and never reaches the restart-to-install state.

## Rollback

Downgrades are disabled, so persisted data never meets an older reader through an update. Someone who installs an older build by hand over data a newer one upgraded either keeps working, after an additive upgrade, or gets an error that names the backup to restore, which brings the data back as it was before the upgrade. To roll back, fix forward with a higher version that restores the previous behavior. To pull a broken release, delete it or mark it as a prerelease so that `latest*.yml` stops pointing at it. Keep earlier installers until the replacement is confirmed.

Never paste credentials or raw provider responses into release notes or logs.
