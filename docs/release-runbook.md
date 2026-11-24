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
   2. runs lint, formatting, typecheck, tests, build, the production audit, and the SBOM against the bumped tree, while it builds and smoke-tests both Linux server archives and packages macOS (on `macos-15`), Linux (on `ubuntu-latest`), and Windows (on `windows-latest`);
   3. commits `chore(release): prepare vX.Y.Z` to `main` and pushes it with the `vX.Y.Z` tag in one atomic push;
   4. creates the GitHub release as a draft, uploads every artifact, update feed, server archive, SBOM, and `SHA256SUMS.txt`, and publishes it immediately so installs never see a partial release;
   5. pushing the `vX.Y.Z` tag triggers the separate **Publish server** workflow to publish `@gustmrg/wisp-server` to npm without blocking the desktop release (see [The server package on npm](#the-server-package-on-npm)).
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

`@gustmrg/wisp-server` is the headless server that `npx @gustmrg/wisp-server setup` installs by hand, and that development desktop builds install over SSH. Packaged desktop releases install the matching [server archive](#server-archives) from GitHub Releases instead, so publishing to npm does not block the desktop release.

The separate **Publish server** workflow (`.github/workflows/publish-server.yml`) runs automatically whenever **Desktop release** pushes a `vX.Y.Z` or `vX.Y.Z-beta.N` tag, and can also be run manually with a tag input. It verifies that `package.json` matches the tag, builds `npm run package:server`, updates npm to 11.5.1 or later, and runs `npm publish --provenance`. Prereleases (`-beta.1`) get the `beta` dist-tag, so `npx @gustmrg/wisp-server` never runs one. The package's page on npm shows `server/README.md`.

If the workflow fails, the desktop release and server archives are already live: fix the cause and re-run **Publish server** (or dispatch it with the release tag). A re-run exits cleanly when the version is already on npm, since npm refuses a version published twice.

### Authentication

npm authenticates the job with **trusted publishing**: an OIDC identity of this repository's `publish-server.yml`, with no secret to store or renew. npm only lets a package that already exists use it, so the first version is published with a token:

1. The account `gustmrg` owns the `@gustmrg` scope. Turn on two-factor authentication for it.
2. **First release only:** on npmjs.com, create a granular access token (**Access Tokens → Generate New Token**) with read and write access to packages, **Bypass 2FA** checked (CI cannot answer a 2FA prompt), and a short expiration. Store it as the repository secret `NPM_TOKEN`, then run the release.
3. Once the version is on npm, open the package's **Settings → Trusted Publisher**, choose GitHub Actions, and enter the repository `gustmrg/wisp-bot` and the workflow `publish-server.yml`. Then delete the `NPM_TOKEN` secret and revoke the token on npm.

Later releases need nothing else. npm prefers the OIDC identity when it is available, so a token left behind is unused, but it remains a credential that can publish; revoke it.

## Server archives

The **server-archive** job builds `wisp-server-<version>-linux-x64.tar.gz` and
`wisp-server-<version>-linux-arm64.tar.gz` on a runner of each processor, with
`npm run package:server` and `scripts/package-server-archive.mjs`. Each
archive holds the server package, its production dependencies for that
processor and glibc, and Node.js 22 LTS, whose download is checked against the
Node.js release's checksums. The script fails when a native module was built
for another processor or C library.

Before anything is released, the job runs `scripts/smoke-server-archive.sh`
in clean containers without Node.js, from Debian 10 (glibc 2.28) to Ubuntu
24.04: the runtime check, `setup --no-service`, the server with fake agents,
its health check, the browser app, `wispctl status` and `wispctl pair`.

The desktop packaging jobs wait for both archives' `.sha256` files and write their SHA-256 into the app (`scripts/server-archive-hashes.mjs` → `dist-electron/server-archives.json`). The app checks the archive a server downloads against these hashes, so an archive must never be rebuilt or replaced after its app was packaged: re-run the whole release instead.

The archives go into the GitHub release with the desktop files and are listed in `SHA256SUMS.txt`, so they become public together with the app. A beta's archives are part of its prerelease. To check one by hand, build it with `npm run package:server-archive` and run the smoke script as its header says. Raise the version in `.node-version` with each Node.js 22 security release; CI, release workflows, and the archive script all read it.

## In-app updates

Settings → About checks GitHub Releases only when asked and never downloads on its own.

- **Linux:** the AppImage and the `.deb` download and install in place. The `.deb` asks for the administrator password through `pkexec`.
- **Windows:** the installer downloads and installs in place when the app restarts, without administrator rights.
- **macOS:** Squirrel.Mac only installs updates signed with a Developer ID. Ad-hoc builds show the new version and open the releases page for a manual download instead.

A download that fails verification stays an error and never reaches the restart-to-install state.

## Rollback

Downgrades are disabled, so persisted data never meets an older reader through an update. Someone who installs an older build by hand over data a newer one upgraded either keeps working, after an additive upgrade, or gets an error that names the backup to restore, which brings the data back as it was before the upgrade. To roll back, fix forward with a higher version that restores the previous behavior. To pull a broken release, delete it or mark it as a prerelease so that `latest*.yml` stops pointing at it. Keep earlier installers until the replacement is confirmed.

Never paste credentials or raw provider responses into release notes or logs.
