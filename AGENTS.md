# AGENTS.md

Wisp Bot has desktop (Electron) and browser clients sharing one backend,
which runs locally or on a headless server. Read [architecture](docs/architecture.md)
and [security](docs/security.md) before changing a boundary.

Write code, comments, commits, PRs, and docs in English.

## Glossary

- **Wisp:** a persistent agent with its own identity, settings, and permissions.
  **Circle:** a conversation with existing Wisps and a shared workspace.
- **Conversation:** the user-visible transcript. **Session:** runtime context
  and history. **Turn:** one agent execution, including tools and its reply.
- **Runtime:** Pi or Claude Code. **Provider:** a configured model source;
  Claude Code is also exposed as a provider. **Model:** the selected model.
- **Environment:** one Wisp server and its data, credentials, and tools.
  **Connection:** a client's route to it. **Workspace:** a Wisp's or circle's
  files, not this repository checkout.
- **Plugin / MCP server:** an integration with access granted per Wisp.
  **Skill:** saved instructions, never a tool grant.
- **Job:** a scheduled task with its own background session. **Scheduled
  message:** a user-authored message sent later.

## Architecture

- `backend/` never imports Electron or `src/` and uses only dependencies
  installed by the server package. `backend/memory/` imports nothing from
  the rest of Wisp. `tests/backend-boundary.test.ts` enforces this.
- `shared/contracts.ts` is canonical. Cross-process results use
  `BackendResult<T>`, never exceptions or SDK objects. Client operations go
  through `backend/handlers/` and `guarded-handlers.ts`; keep business rules
  in services shared by IPC and HTTP.
- The backend validates requests and authorizes actions. The renderer never
  receives credentials, supplies file paths, or decides authorization.
- Environments stay isolated: no copying conversations, settings, or
  credentials between **This computer** and other servers.
- For database changes, raise `STORE_VERSION`; raise `MIN_READER_VERSION`
  only if older builds cannot read the result. Prefer additive changes.
  Never edit a shipped upgrade, including betas; add a new upgrade.
- Keep Pi's shell tools and automatic discovery of extensions, skills,
  prompts, and context files disabled. Commands run only in Wisp containers
  ([ADR 017](docs/decisions/017-container-execution.md)).

## Change coverage

Check the paths affected by the change: desktop and browser (including phone
layouts), IPC and HTTP, local/SSH/HTTPS connections, Pi and Claude Code,
Wisp chats and circles, jobs and scheduled messages. Cover alternate entry
points, cancellation, reverse actions, and failures where applicable. Report
verification gaps and unsupported behavior.

## Development and tests

- Stop only processes whose PIDs you captured when starting them; never use
  `pkill -f` or kill by name/path matching. Do not stop another server to free
  a port. Keep scratch artifacts outside the worktree.
- Use a fresh scratch `WISP_DATA_DIR`, synthetic data, and
  `WISP_AGENT_MODE=fake` for automated app checks. Never run development,
  migrations, or cleanup against live data, or copy/symlink live credentials,
  pairing sessions, or scheduled work into tests.
- **Tests never reach real systems.** Inject `tests/fixtures/fake-ssh.cjs`
  into every SSH path and assert it was used. Use
  `tests/helpers/fake-tailscale.ts` for Tailscale; never run `tailscale serve`
  in automated checks. Mock provider/plugin HTTP. Use `test-host.invalid`,
  not `raspberrypi` (a real host on this machine).
- Node tests live in `tests/**/*.test.ts`; renderer tests in
  `src/**/*.test.{ts,tsx}` use jsdom and `src/test/setup.ts`.
- Reproduce logic bugs with a failing test before fixing them. Backend
  behavior changes need focused tests. Extend existing cases and test shared
  logic at the lowest relevant layer; avoid redundant tests and assertions
  that only mirror types, copy, or mock wiring.
- Await events/promises or use controlled clocks; do not hide races with
  sleeps, retries, or larger timeouts. Run focused tests during iteration:
  `npm test -- <test-file> -t "<case>"`.
- jsdom cannot verify layout. Check UI changes in the built app; use
  before/after captures for visual fixes and recordings for motion or timing.
  Attach evidence to the PR without committing review-only assets.

### Built app

Run without API keys in an isolated data directory:

```sh
npm run build:renderer && npm run build:electron
env -u ELECTRON_RUN_AS_NODE -u VITE_DEV_SERVER_URL \
  WISP_DATA_DIR=<scratch-dir> WISP_AGENT_MODE=fake \
  xvfb-run -a -s "-screen 0 1280x900x24" \
  npx electron . --remote-debugging-port=9333 --no-sandbox
```

Drive DevTools at `http://127.0.0.1:9333/json`. On fresh data, call
`window.wisp.activateConnection({ id: "local" })`,
`window.wisp.saveUserProfile(…)`, and `window.wisp.saveAiSettings(…)`, then
reload. After moving files, remove `dist-electron` before building; `tsc`
does not delete stale output.

## Quality gates

Before opening a PR, run:

```sh
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
```

Format only with `npx biome format --write` (120 columns, two spaces).
Do not loosen strict TypeScript settings. Keep `npm run audit:prod` free of
high-severity production advisories.

## Code and docs

- Use kebab-case filenames, zod tool parameters, and `npm run ui:add` for
  shadcn components. Comments use `/** … */` JSDoc to explain non-obvious
  reasons; keep inline comments rare. UI text is plain sentence case;
  capitalize "Wisp".
- Update affected guides and ADRs in the same PR. In `docs/`, use short
  sentences, exact bold screen paths (**Settings → AI Model**), and relative
  links with anchors. Add new pages to README's documentation table.
- Number ADRs sequentially in `docs/decisions/NNN-short-title.md` and follow
  the existing header and section structure. Mark shipped decisions Accepted
  and rewrite or supersede stale guidance.

## Git and pull requests

- Never commit to `main`. Use short branches such as `fix/chat-scroll`,
  without personal prefixes.
- Follow Conventional Commits for commit messages and PR titles, with a
  scope naming the product area.
- Merge PRs with a merge commit. Use GitHub Stack whenever possible when
  submitting related or large features.
- PR bodies explain the problem and user-visible result, then technical
  details (`code`, **UI names**). Include `## Testing` with quality-gate
  results, test count, new tests, and built-app checks; `## Not in this PR`
  if needed; and relevant Linear references (`Refs SWE-153`).
- Only the **Desktop release** workflow on `main` creates release-preparation
  commits and tags. While a beta is out, the next release must be `minor`.
  Follow the [release runbook](docs/release-runbook.md).
