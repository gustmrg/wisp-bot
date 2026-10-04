# ADR 007: Unsigned macOS and Linux releases from one dispatch

- Status: Accepted
- Date: 2026-10-04
- Decision owners: Wisp maintainer
- Scope: Platform matrix, signing, update rollout, and the release workflow
- Supersedes: the platform matrix, signing, rollout, and release-gate sections of [ADR 002](002-distribution.md)

## Context

ADR 002 planned signed Windows and notarized macOS betas, staged rollouts, and an approval step for every draft. None of the credentials it needed exist. The real pipeline packaged ad-hoc-signed macOS builds and published them directly. Each version bump was a manual commit and tag, and a run that failed after tagging left an orphaned tag. Linux, the maintainer's other daily OS, had no build.

## Decision

| Platform | Architecture | Artifacts | Signing |
| --- | --- | --- | --- |
| macOS 14+ | arm64, x64 | DMG, ZIP | ad-hoc, not notarized |
| Linux | x64 | AppImage, `.deb` | unsigned; updates verified by SHA-512 |

Windows is deferred. Its electron-builder configuration stays unused until a Windows build is added.

One manual **Desktop release** dispatch from `main` takes a version (`patch`, `minor`, `major`, or an exact version). It runs every quality gate against the bumped tree and packages both platforms. Only then does it commit `chore(release): prepare vX.Y.Z`, push that commit and the tag atomically, and publish the GitHub release. The workflow pushes straight to `main` with `GITHUB_TOKEN`. It does not open a release pull request.

Releases go out to everyone at once, with no staged rollout. Prerelease versions are published as GitHub prereleases and feed only the `beta` channel. Downgrades stay disabled, and rollback means fixing forward, as ADR 002 already required.

The persistence compatibility rules in ADR 002 still apply.

## Consequences

- A failed release changes nothing in the repository. The version in `package.json` changes only together with a published release.
- macOS users must remove the quarantine attribute on every download and update by hand. Linux users get in-place updates.
- Because the workflow pushes to `main`, `main` must accept pushes from `github-actions[bot]`. A branch protection rule that blocks this has to exempt the workflow, for example through a GitHub App token as other projects do.
- Restoring signing for macOS or Windows needs a new ADR that sets up the credential custody ADR 002 described.

## Alternatives considered

- **release-please or Changesets:** these open a release pull request with the bump and changelog. That is more process than a single-maintainer project needs.
- **Bump and tag first, then build:** this was the old flow, and a failed build left a tag with no release.
