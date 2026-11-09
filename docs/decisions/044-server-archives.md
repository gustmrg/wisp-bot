# ADR 044: Server archives with Node.js included

- Status: Accepted
- Date: 2026-11-09
- Decision owners: Wisp maintainer, release
- Scope: How the headless server is distributed for machines without Node.js
- Related: [ADR 009](009-headless-server.md), [ADR 007](007-release-automation.md),
  [remote server guide](../remote-server.md#from-a-server-archive),
  [release runbook](../release-runbook.md#server-archives), SWE-311

## Context

The server is published as the npm package `@gustmrg/wisp-server`
([ADR 009](009-headless-server.md)). Installing it needs Node.js 22.19 or
later and npm on the machine, and the desktop app needs both in the `PATH` of
non-interactive SSH commands, which nvm and similar tools often leave out.
Docker avoids that, but builds its image from a checkout.

What the server needs from the machine is small: `node:sqlite` is part of
Node.js, so the only native modules are the canvas that renders PDF pages and
a terminal helper of Pi. Both publish prebuilt binaries per processor and C
library.

## Decision

**Every release also publishes the server as a tar archive per processor,
with Node.js included: `wisp-server-<version>-linux-x64.tar.gz` and
`wisp-server-<version>-linux-arm64.tar.gz`.**

- An archive holds the npm package's files under `app/`, its production
  dependencies for that processor and glibc, Node.js under `runtime/`, and
  `bin/wisp-server` and `bin/wispctl`, which run the command line with that
  Node.js. `wisp-server-archive.json` names the version, processor, and
  Node.js version, and tells the server it runs from an archive.
- Node.js is the official build of the latest 22 LTS release, checked against
  the release's published checksums. A tar archive with the runtime beside the
  code is used instead of a single executable: native modules and the data
  files of pdf.js must be on disk anyway, and the archive runs the same code
  as the npm package.
- Linux with glibc 2.28 or later only, which is what the official Node.js
  build needs. musl (Alpine) and 32-bit ARM are not built; Docker serves them.
- Claude Code's own binaries are left out, as in the desktop app: the server
  runs the `claude` installed on its machine.
- `setup` run from an archive copies it to
  `~/.local/lib/wisp-server/versions/<version>`, through a staging folder and
  a completion marker, and points the `current` link at it. The systemd unit
  and `wispctl` run through `current`, so they stay the same across versions.
- The release workflow builds each archive on a runner of its processor and
  checks it in clean containers without Node.js before anything is released.
  The archives go into the draft release with the desktop files and their
  checksums, so they become public with the app that installs them.
- The npm package stays, unchanged, during the transition. The desktop app's
  own server for **This computer** keeps running on Electron's Node.js.

## Consequences

- A machine with systemd and glibc needs nothing else to run the server.
- Each archive is about 100 MB, most of it Node.js and the model provider
  SDKs that npm installs as well.
- A Node.js security release needs a Wisp release to reach servers installed
  from an archive.
- The desktop app installs and updates servers from these archives; see
  [Installing over SSH](#installing-over-ssh).

## Installing over SSH

The desktop app installs the archive of its own version on a machine over SSH
(SWE-312):

- The release builds the archives before the desktop packages and writes
  their SHA-256 into the app (`dist-electron/server-archives.json`). The
  machine downloads its archive from the release and checks it against that
  hash; no checksum file from the same place is trusted.
- One shell script, with only validated values in it, detects the processor
  and glibc, takes a lock directory holding its PID (taken over when that
  process is gone), removes interrupted downloads, downloads with `curl` or
  `wget`, verifies, runs `wispctl version --check`, and moves the extracted
  archive into `versions/<version>` with its completion marker. It then runs
  that archive's setup, which records the update
  ([ADR 045](045-confirming-server-updates.md)). Failures print one
  `wisp-install:` line, which the app explains.
- The setup moves a server installed from npm to the archive and removes the
  npm files once the service runs the archive. The key, settings, data and
  paired devices stay where they were. Archive versions other than the
  running one and the one before it are removed.
- The setup refuses to start the service while another server answers on the
  same data directory. The data directory's own lock already keeps a second
  server from opening it.
- A development build carries no hashes and installs the npm package.

## Rejected alternatives

- **A single executable (Node.js SEA or Bun).** The native modules and pdf.js
  data would still be files beside it, and bundling would run different code
  than the npm package and the desktop app.
- **Archives for musl and 32-bit ARM.** Node.js publishes no official build
  for them, and no installation uses them.
