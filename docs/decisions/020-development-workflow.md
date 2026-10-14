# ADR 020: Trunk-based development with betas from main

- Status: Accepted
- Date: 2026-10-14
- Decision owners: Wisp maintainer
- Scope: Branch strategy, and how betas and releases are cut from it
- Related: [ADR 007](007-release-automation.md), [release runbook](../release-runbook.md)

## Context

Every change already starts on a short `feat/` or `fix/` branch and reaches
`main` through a pull request. Releases are cut by hand from `main` every few
merges, often more than once a day.

Betas were cut from whichever branch held the change to try. A beta from a
feature branch carries that feature alone: none of the fixes already on `main`
and none of the other features in flight. Beta installs ran builds that no
release would ever match.

Betas take the next minor version (`0.18.0` leads to `0.19.0-beta.1`) so that
they sort above the latest release. Downgrades are disabled, so a patch
released while a beta is out (`0.18.1` under `0.19.0-beta.2`) never reaches
beta installs. They stayed on the beta until the next minor release.

The macOS builds stay ad-hoc signed, as [ADR 007](007-release-automation.md)
records. The branch strategy does not change that.

## Decision

`main` is the only integration branch. There is no `develop` and there are no
`release/*` branches.

1. **Branches stay short.** Work happens on `feat/` and `fix/` branches and
   reaches `main` through a pull request. A feature that is not ready stays on
   its branch, or reaches `main` hidden, so that `main` can always be cut as a
   beta.
2. **Betas come from `main`.** After a few merges, run **Desktop release** from
   `main` with `beta`. Each beta carries every change merged so far.
3. **A release promotes the beta line.** Once the betas hold up, run
   **Desktop release** from `main` with `minor`. `0.19.0` sorts above every
   `0.19.0-beta.N`, so beta installs update to it and return to the stable
   channel.
4. **A patch is for when no beta is out.** While a beta of the next minor
   version is out, the workflow refuses any version beta installs would not
   update to and names the version to release instead.
5. **A beta from a branch is an exception.** To try a risky change on its own,
   run the workflow from that branch with `preview_branch` checked.

The release notes of a beta list what changed since the version just before
it. Those of a release list everything since the previous release, betas
included.

## Consequences

- Beta installs run what the next release will be, and receive every fix.
- A fix that cannot wait for the next minor release goes out as that minor
  release, with whatever else `main` holds. Keeping `main` releasable is what
  makes this safe.
- Unfinished work on `main` ships in the next beta. It has to be hidden, or
  kept on its branch.
- Every published version sorts above the ones before it, so no install is
  ever stranded on an older version.

## Alternatives considered

- **A `develop` branch for betas, merged into `main` for releases:** two
  long-lived branches to keep in sync, for one maintainer. Fixes would land on
  one and need to reach the other.
- **`release/X.Y` branches cut for stabilization:** fixes on `main` would be
  cherry-picked to the release branch. That pays off for parallel supported
  versions, which Wisp does not have.
- **Betas from feature branches (the previous practice):** each beta tests one
  change in isolation, and patch releases strand beta installs.
