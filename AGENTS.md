# AGENTS.md

Rules for agents working in this repository. Wisp Bot is an Electron desktop
app, a headless server, and a browser app sharing one backend; see
[architecture](docs/architecture.md) and [security](docs/security.md) before
changing a boundary.

Everything in the repository is written in English: code, comments, commit
messages, PRs, and docs.

## Commits

- Use Conventional Commits with a scope: `type(scope): summary`.
  - Types: `feat`, `fix`, `refactor`, `test`, `docs`, `style`, `chore`, `ci`.
  - The scope names the product area, not a file: `chat`, `circles`,
    `settings`, `ui`, `sidebar`, `composer`, `connections`, `mcp`, `plugins`,
    `memory`, `jobs`, `claude-code`, `execution`, `storage`, `deps`, …
  - The summary is lowercase, imperative, without a final period, and says
    what changes for the user:
    `fix(chat): stop naming the Wisp above replies in its own conversation`.
- The body is prose wrapped at about 72 columns that explains why and what
  changed. Trivial commits, such as dependency bumps, may have none.
- No attribution: no `Co-Authored-By` trailers and no "Generated with …"
  lines in commits or PR bodies.
- `chore(release): prepare vX.Y.Z` commits come only from the release
  workflow. Never write one by hand or tag a release yourself.
- Stage explicit paths (`git add backend src tests shared docs …`), never
  `git add -A`: `.claude/worktrees/` is not ignored and would be committed as
  embedded repositories. Check `git status --short` before committing.

## Branches

- Conventional prefixes and short kebab-case names: `feat/circle-member-usage`,
  `fix/badge-cleared-on-read`, `docs/…`, `chore/…`, `refactor/…`.
- No personal prefix such as `gustmrg/`.
- Never commit to `main`; it only takes pull requests.

## Pull requests

- The title is the main commit's subject. A PR usually holds one commit, two
  at most, and is merged with a merge commit.
- Split a large feature into a stack with `gh stack` (`gh stack init`,
  `gh stack add`, then `gh stack submit --auto --open`; without `--open` the
  PRs are created as drafts). Each stacked PR's body starts with
  `Stacked on #N.`.
- Body:
  1. A paragraph with the problem and what changes for the user.
  2. Bullets with the technical details: types and functions in `code`, UI
     names in **bold**.
  3. `## Testing`: typecheck, lint, format, `npm test` with the test count,
     the new tests, and what was checked in the built app.
  4. `## Not in this PR`, when something is left for later.
  5. Linear references, such as `Refs SWE-153`.
- Docs and ADRs that the change affects are updated in the same PR.

## Quality gates

CI runs these, and so must you before opening a PR:

```sh
npm run lint
npm run format:check
npm run typecheck   # four tsconfigs: renderer, electron, server, vite
npm test
npm run build
```

- Format only with `npx biome format --write` (120 columns, two spaces).
  Prettier reformats to 80 columns and Biome keeps the result.
- `npm run audit:prod` must stay clean: the release fails on any
  high-severity production advisory.
- TypeScript is strict, including `noUnusedLocals`, `noUnusedParameters`, and
  `noUncheckedIndexedAccess`. Do not loosen it.

## Tests

- Vitest has two projects:
  - backend, Electron, server, and client tests in `tests/**/*.test.ts`
    (node environment);
  - renderer tests beside the code in `src/**/*.test.{ts,tsx}` (jsdom, setup
    in `src/test/setup.ts`).
- **Tests never reach real systems.** This machine has real SSH hosts (the
  fixture name `raspberrypi` is a real machine) and a real Tailscale node.
  - Every code path that spawns `ssh` gets `tests/fixtures/fake-ssh.cjs`
    injected in its test, and the test checks the fake was used.
  - Every code path that calls the Tailscale CLI gets
    `tests/helpers/fake-tailscale.ts`. Never run `tailscale serve` from a
    test or an automated check.
  - Plugins and providers use mocked HTTP responses.
  - Prefer host names that cannot resolve, such as `test-host.invalid`.
- jsdom lays nothing out. Check layout-dependent behavior (scrolling,
  centering, sizing) in the built app.

### Checking the built app

The real app runs without a window or API keys:

```sh
npm run build:renderer && npm run build:electron
env -u ELECTRON_RUN_AS_NODE -u VITE_DEV_SERVER_URL \
  WISP_DATA_DIR=<scratch dir> WISP_AGENT_MODE=fake \
  xvfb-run -a -s "-screen 0 1280x900x24" \
  npx electron . --remote-debugging-port=9333 --no-sandbox
```

Drive it over the DevTools protocol (`http://127.0.0.1:9333/json`,
`Runtime.evaluate`, `Page.captureScreenshot`). On a fresh data directory,
call `window.wisp.activateConnection({ id: "local" })`, save a profile with
`window.wisp.saveUserProfile(…)` and a model with `window.wisp.saveAiSettings(…)`,
then `location.reload()`. `tsc` never deletes stale output: after moving
files, remove `dist-electron` before building.

## Architecture rules

- `backend/` never imports Electron or `src/`, and uses only packages the
  server package installs. `backend/memory/` imports nothing from the rest of
  Wisp. `tests/backend-boundary.test.ts` enforces these rules.
- `shared/contracts.ts` is the canonical contract. Results cross the process
  boundary as `BackendResult<T>`; exceptions and SDK objects do not.
- Every client operation is a handler in `backend/handlers/` registered
  through `guarded-handlers.ts`, so it works the same over IPC and HTTP.
- The renderer never receives credentials, never supplies file paths, and
  never decides authorization. The backend validates every request.
- Each environment (the desktop's **This computer** and every Wisp server) is
  isolated. Never add a feature that copies conversations, settings, or
  credentials between environments.
- Database changes in `backend/conversation-store.ts`:
  - raise `STORE_VERSION`, and `MIN_READER_VERSION` only when older builds
    could not read the result;
  - prefer additive changes, which older builds can still read;
  - never change an upgrade that already shipped, even in a beta: a fix is a
    new upgrade.
- Pi's shell tools and its automatic discovery of project extensions,
  skills, prompts, and context files stay disabled. Commands run only in a
  Wisp's container ([ADR 017](docs/decisions/017-container-execution.md)).

## Code style

- File names are kebab-case.
- Comments are `/** … */` JSDoc sentences that explain why. Keep inline
  comments rare and match the surrounding density.
- Tool parameters are defined with zod.
- Add shadcn/ui components with `npm run ui:add`; they live in the repository
  and may be edited.
- UI text is sentence case and plain language. "Wisp" is always capitalized.

## Docs and decision records

- User-facing behavior is documented in `docs/`: short sentences, screen
  names in **bold** with their exact path (**Settings → AI Model**), and
  relative links with anchors. Keep `README.md`'s documentation table in sync
  when adding a page.
- Decisions go in `docs/decisions/NNN-short-title.md`, numbered in sequence:
  - header: Status, Date, Decision owners, Scope, Related;
  - sections: Context, Decision, Consequences, Deferred, Decisions taken with
    the user, Rejected alternatives.
- Set an ADR's status to Accepted when it ships, and update or mark as
  superseded the docs and ADRs that the change makes stale.

## Releases

Betas and releases are cut from `main` by the **Desktop release** workflow;
see the [release runbook](docs/release-runbook.md). While a beta is out, the
next release must be `minor` so it sorts above it.
