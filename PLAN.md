# Wisp Bot Improvement Plan

> **Executor instructions**: Read this file completely before changing code.
> Execute exactly one phase at a time. Run every validation command for that
> phase, update its status in the table below, and then stop for human review.
> Report what changed, files changed, validation results, caveats, and the
> suggested commit message. Explicitly state that no commit was made. Do not
> begin the next phase until the user approves it, and never commit unless the
> user explicitly asks for a commit.
>
> **Global drift check (run before every phase)**:
> `git diff --stat d6963fa..HEAD -- <the phase's in-scope paths>`
> and `git status --short -- <the phase's in-scope paths>`.
> Compare changed files with the current-state excerpts and phase assumptions
> below. If behavior or types have drifted materially, stop and revise this plan
> before implementing.

## Plan metadata

- **Planned at**: commit `d6963fa`, 2026-08-30
- **Repository**: Wisp Bot, a React 19 + TypeScript 7 + Vite 8 Electron 43 mock desktop UI
- **Package manager**: npm; Node.js 22.12 or later
- **Deployment target**: Electron desktop application
- **Current verification**: `npm run typecheck` and `npm run build`; no tests, lint, formatting check, CI, packaging, or installer workflow exists yet
- **Planning constraint**: this file is the only artifact created by the planning pass; no source implementation is part of this change

## Objective

Make the existing mock UI safer to evolve into a real desktop agent product by:

1. establishing executable regression and CI gates;
2. fixing confirmed lifecycle, search, clipboard, loading, and resize defects;
3. replacing scattered identity, version, layout, and shape literals with typed sources;
4. separating Wisp and circle types, domain actions, persistence, mock transport, and UI composition;
5. consolidating recurring settings structures and visual colors into semantic primitives;
6. hardening the Electron renderer boundary; and
7. delivering the roadmap items—editable circle membership, one real-agent vertical slice, enforceable auto-review, and signed installer/update delivery—behind explicit product and security decision gates.

## Execution order and status

| Phase | Title | Priority | Effort | Risk | Depends on | Status |
|---|---|---:|---:|---:|---|---|
| 01A | Apply the Biome formatting baseline | P0 | M | LOW | — | DONE |
| 01 | Establish tests, lint, formatting, and CI | P0 | M | LOW | 01A | DONE |
| 02 | Fix search, Wisp registry, and clipboard feedback | P1 | M | LOW | 01 | DONE |
| 03 | Centralize panel layout and resize lifecycle | P1 | S/M | LOW | 01 | DONE |
| 04 | Centralize current-user and release metadata | P1 | S | LOW | 01 | DONE |
| 05 | Model Wisps and circles as discriminated variants | P1 | L | HIGH | 01, 02, 04 | DONE |
| 06 | Make workspace mutations preserve entity integrity | P1 | M | MED | 05 | DONE |
| 07 | Add validated, failure-aware persistence | P1 | L | MED | 05, 06 | DONE |
| 08 | Extract the workspace controller and request runtime | P1 | M/L | MED | 03, 04, 06, 07 | DONE |
| 09 | Build semantic settings and surface primitives | P2 | L | MED | 01, 03, 05 | DONE |
| 10 | Harden Electron navigation, permissions, CSP, and loading | P1 | M | MED | 01, 04 | TODO |
| 11 | Refresh repository documentation and license | P2 | S | LOW | 01–10 | TODO |
| 12 | Make circle membership editable | P2 | M | LOW | 06, 08, 09 | TODO |
| 13 | Decide the real-agent runtime and IPC contract | P3 | S/M | LOW | 07, 08, 10 | TODO |
| 14 | Deliver one real-agent vertical slice | P3 | L | HIGH | 13 | TODO |
| 15 | Enforce auto-review authorization and audit logging | P3 | L | HIGH | 10, 14 | TODO |
| 16 | Decide packaging, signing, and update operations | P3 | S/M | LOW | 04, 07, 10, 11, 14, 15 | TODO |
| 17 | Produce signed installers and a staged update channel | P3 | L | HIGH | 16 | TODO |

Status values: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED: <reason>`, or `REJECTED: <reason>`.

### Phase 01A — Apply the Biome formatting baseline

**Goal**: Establish one mechanical formatting baseline without mixing functional changes into Phase 01.

**Scope**:

- Apply `npm run format` to the files selected by `biome.json`.
- Do not apply lint fixes or make intentional production behavior changes.
- Keep generated output, `.migration/`, `template/`, and dependencies excluded.

**Validation**:

- `npm run format:check`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, and `git diff --check` all exit 0.
- Review the diff as formatting-only and confirm no files outside the configured scope changed.

**Exit criteria**:

- Biome reports no formatting drift.
- Existing tests, typechecking, and production build still pass.

**Suggested commit message**: `style: apply Biome formatting baseline`

## Dependency notes

- Phase 01 must land first because every risky state, persistence, and type migration needs behavioral regression coverage.
- Phases 02–04 are intentionally small and precede the domain migration so their new utilities become stable inputs rather than being rewritten afterward.
- Phase 05 establishes the final entity shape. Phases 06–08 must target that shape to avoid migrating reducer and persistence code twice.
- Phase 06 fixes identity and referential integrity before Phase 07 persists the new graph.
- Phase 08 consumes the stable reducer and persistence interfaces; it must not invent a second state model.
- Phase 09 follows the entity split so Wisp- and circle-specific settings components are already distinct before visual primitives are extracted.
- Phase 10 must land before any preload, IPC, provider credential, or update surface is introduced.
- Phases 13 and 16 are decision phases. Their implementation phases must not start until a reviewer explicitly approves their ADRs.
- Phase 15 is required before autonomous actions are treated as production-capable. No renderer-only approval check counts as enforcement.

## Repository conventions to preserve

- Use `@/` imports for renderer code and `import type` for type-only imports.
- Keep TypeScript strict and compatible with `noUncheckedIndexedAccess`, `noUnusedLocals`, and `noUnusedParameters`.
- Prefer small named feature components under `src/components/`; keep shadcn/Base UI wrappers under `src/components/ui/` locally owned and avoid modifying generated wrappers unless a phase explicitly names them.
- Prefer pure helpers under `src/lib/`, application hooks under `src/hooks/` or `src/features/workspace/`, shared process contracts under `src/shared/`, and Electron-only code under `electron/`.
- Use controlled components, functional state updates, exhaustive discriminated switches, explicit async cleanup, and normal React text interpolation. Do not add `dangerouslySetInnerHTML`.
- Continue the repository's conventional commit style, for example `feat(ui): ...`, `fix(ui): ...`, `refactor(settings): ...`, and `chore: ...`.
- Keep `template/` as non-runtime reference material unless a reviewed phase explicitly decides otherwise.
- The completed Base UI migration in `.migration/` is a settled decision; do not reintroduce Radix APIs.

An existing cleanup exemplar is `src/lib/theme.ts`: it owns one concern, returns an explicit disposer, and keeps the component effect small. New resize, persistence, and runtime subscriptions should follow that lifecycle shape.

```ts
// src/lib/theme.ts:7-20
export function applyTheme(preference: ThemePreference): () => void {
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  // ...
  systemTheme.addEventListener("change", updateTheme);
  return () => systemTheme.removeEventListener("change", updateTheme);
}
```

## Current state that the phases must preserve or intentionally migrate

### Persistence accepts a cast rather than a decoded graph

```ts
// src/App.tsx:26-38
const saved = JSON.parse(raw) as Partial<PersistedState>;
if (saved.chats && Object.keys(saved.chats).length) {
  return {
    chats: migrateLegacyChats(saved.chats),
    preferences: normalizePreferences(saved.preferences),
  };
}
```

Rendering then assumes `chat.messages` is a valid array in `src/components/chat-panel.tsx:64-72`.

### Domain behavior and transient runtime state are concentrated in `App`

```ts
// src/App.tsx:84-99
const [chats, setChats] = useState<ChatCollection>(savedState.chats);
const [activeChatId, setActiveChatId] = useState<ChatId>(/* ... */);
const [draft, setDraft] = useState("");
const [workingChatId, setWorkingChatId] = useState<ChatId | null>(null);
const replyTimersRef = useRef<Set<number>>(new Set());
```

Deletion at `src/App.tsx:194-201` removes only the active record. Circle membership resolves raw IDs at `src/lib/circle-members.ts:24-29`, while `uniqueAgentId` at `src/App.tsx:55-60` can reuse a deleted slug.

### Wisp and circle states are mixed behind a boolean

```ts
// src/chat-data.ts:14-27
export interface AgentSettings {
  id: string;
  color?: string;
  avatarImage?: string;
  shape: WispShape;
  isCircle: boolean;
  memberIds?: ChatId[];
  // ...
}
```

`src/components/create-agent-dialog.tsx:44-181` and `src/components/details-panel.tsx:46-66` repeat Wisp-versus-circle branches and fabricate irrelevant fields to satisfy this type.

### Several sources of truth have already drifted

- `WispShape` includes `diamond` in `src/chat-data.ts:3-12`.
- `WispBody` renders `diamond` in `src/components/wisp.tsx:64-84`.
- `WISP_SHAPES` omits it in `src/components/wisp.tsx:27-36`, so users cannot select or randomize it.
- `package.json:3` is the release version, while `src/components/app-settings-dialog.tsx:77` renders a separate literal.
- The current-user name and initials are repeated in `src/App.tsx:177`, `src/components/sidebar.tsx:117-118`, and `src/components/app-settings-dialog.tsx:50-51`.

### Search, clipboard, resize, and Electron load errors have concrete gaps

```ts
// src/components/search-dialog.tsx:20-21
return chat.messages
  .map((message) => ("text" in message ? message.text : ""))
  .join(" ")
  .toLocaleLowerCase();
```

This omits visible card and prompt fields. `src/components/details-panel.tsx:27-31` reports clipboard success before the promise resolves. `src/App.tsx:63-82` removes resize listeners only on `pointerup`. `electron/main.ts:33-50` does not observe `loadURL`, `loadFile`, or activation failures at a terminal boundary.

### Semantic tokens coexist with feature-local palettes and markup fragments

`styles.css:66-92` already defines semantic surfaces, text colors, panels, and bubbles, while `src/lib/ui-classes.ts` exports raw class strings and settings consumers reconstruct the same row/card markup. Avatar palette values are product data and must remain explicit; neutral UI surface colors should become semantic tokens.

## Commands and expected results

Before Phase 01, install and verify the existing baseline:

| Purpose | Command | Expected result |
|---|---|---|
| Runtime version | `node --version` | version is `v22.12.0` or newer |
| Install | `npm ci` | exits 0; lockfile is not unexpectedly rewritten |
| Typecheck | `npm run typecheck` | exits 0 with no TypeScript errors |
| Production build | `npm run build` | exits 0; renderer and Electron builds are produced |

After Phase 01, every implementation phase must end with:

| Purpose | Command | Expected result |
|---|---|---|
| Unit/component tests | `npm test` | exits 0; all tests pass |
| Lint | `npm run lint` | exits 0 with no warnings treated as errors |
| Format check | `npm run format:check` | exits 0; no files require formatting |
| Typecheck | `npm run typecheck` | exits 0 with no TypeScript errors |
| Production build | `npm run build` | exits 0 |

If Node/npm is unavailable, stop before implementation. The planning environment could not run these commands, so the first executor must establish whether commit `d6963fa` actually passes the documented baseline.

## Global scope boundaries

**In scope**:

- `src/`, `electron/`, root build/config files, tests, `.github/workflows/`, documentation, and packaging configuration explicitly named by each phase.
- `package.json` and `package-lock.json` only when a phase adds/removes tooling or runtime dependencies.
- Backward-compatible migration of the current `wisp-bot-ui-v3` local state.

**Out of scope unless a later roadmap phase explicitly says otherwise**:

- Rewriting or deleting `template/`.
- Replacing Base UI/shadcn with another component library.
- Changing the visual product concept, initial demo conversations, or avatar palette for aesthetic preference alone.
- Adding transcript virtualization, search indexing infrastructure, analytics, telemetry, cloud synchronization, billing, or multi-user collaboration.
- Persisting provider secrets, tokens, or credentials in renderer state, localStorage, logs, test fixtures, or this plan.
- Publishing, pushing, opening pull requests, creating releases, or committing without explicit user authorization.

## Global STOP conditions

Stop and report rather than improvising if:

- an in-scope file has materially drifted from the excerpts above;
- the baseline typecheck or build fails before Phase 01 changes;
- a phase requires changing an out-of-scope public behavior or stored-data contract not described here;
- a migration cannot preserve valid v3 state without destructive fallback;
- a validation command fails twice after a reasonable correction;
- an external provider, signing identity, supported platform, or credential-storage choice is required but has not been approved;
- a security change requires weakening context isolation, sandboxing, CSP, sender validation, or default-deny permission handling;
- a generated-wide formatting change obscures functional review—split it into its own reviewed phase instead.

---

## Phase 01 — Establish tests, lint, formatting, and CI

**Goal**: Create a one-command, continuously enforced verification baseline before production logic is refactored.

**Audit coverage**: finding 01.

**Scope**:

- Modify `package.json`, `package-lock.json`, and `.gitignore` if test artifacts require it.
- Create the Vitest/jsdom configuration and `src/test/setup.ts`.
- Create initial tests beside `src/lib/app-preferences.ts`, `src/lib/circle-members.ts`, and at the application boundary.
- Create lint/format configuration and `.github/workflows/ci.yml`.
- Do not change production behavior in this phase.

**Implementation steps**:

1. Run the pre-Phase 01 commands from “Commands and expected results.” If the current baseline fails, stop and report the exact pre-existing failure.
2. Extend the existing Vitest backend suite with jsdom, React Testing Library, and `@testing-library/user-event` as development dependencies. Add the missing `test:watch` script and preserve the existing `test` command.
3. Configure jsdom and stable test setup for `matchMedia`, browser timers, localStorage reset, and Base UI portals. Do not globally mock application modules.
4. Add characterization tests for:
   - valid/default/invalid preference normalization;
   - legacy `isGroup` to circle migration and explicit empty-circle preservation;
   - default application render from an empty initialized backend;
   - invalid legacy JSON falling back to an empty backend import without crashing;
   - one outgoing message being persisted and forwarded through the typed backend bridge;
   - streamed reply state through the existing conversation-stream characterization suite;
   - the current search behavior for ordinary incoming/outgoing text.
5. Add Biome lint and format-check scripts. Keep its recommended React Hooks rules enabled and exclude `dist/`, `dist-electron/`, `node_modules/`, `.migration/`, and the non-runtime `template/`. Biome replaces ESLint and Prettier because the current `typescript-eslint` peer range excludes TypeScript 7. Keep any initial mechanical formatting separate inside this phase; if it touches more than 20 source files, stop and request a dedicated formatting phase.
6. Create GitHub Actions CI using the Node version declared by `engines`. Run `npm ci`, lint, format check, typecheck, tests, and build. Enable npm caching keyed by `package-lock.json`.

**Validation**:

- `npm test` → exits 0 and the new characterization tests pass.
- `npm run lint` → exits 0.
- `npm run format:check` → exits 0.
- `npm run typecheck` → exits 0.
- `npm run build` → exits 0.
- `git diff --check` → exits 0.
- `git status --short` → only Phase 01 files are listed.

**Exit criteria**:

- A fresh clone can run all verification through documented npm scripts.
- CI runs the same gates, with no weaker CI-only command.
- Tests use fake timers and local browser mocks; they do not make network requests.
- No application behavior changed.

**Suggested commit message**: `test: establish automated quality gates`

**Phase-specific STOP conditions**:

- The currently pinned TypeScript 7 version is unsupported by the selected lint/test toolchain. Biome 2.5.11 was selected after `typescript-eslint` 8.69.0 rejected TypeScript 7.0.2.
- Existing formatting requires a broad functional-looking diff.
- Base UI cannot render in jsdom without mocking away the behavior under test.

---

## Phase 02 — Fix search, Wisp registry, and clipboard feedback

**Goal**: Land the independent low-risk UI correctness fixes and extract their reusable logic.

**Audit coverage**: findings 08, 10, and 11.

**Scope**:

- Create `src/lib/wisp-appearance.ts` and `src/lib/message-search.ts` with tests.
- Create `src/hooks/use-copy-feedback.ts` with tests.
- Modify `shared/conversations.ts`, `electron/backend/conversation-normalizer.ts`, `src/chat-data.ts`, `src/components/wisp.tsx`, `src/components/avatar-editor.tsx`, `src/components/create-agent-dialog.tsx`, `src/components/search-dialog.tsx`, and `src/components/details-panel.tsx`.
- Do not change chat persistence or entity types beyond deriving `WispShape` from the registry.

**Implementation steps**:

1. Move `WISP_SHAPES` and `AVATAR_COLORS` to `src/lib/wisp-appearance.ts`. Because the merged backend now consumes the shared conversation contract, derive `WispShape` from one shared `WISP_SHAPE_IDS` tuple and make both the renderer registry and backend validator consume it. Include `diamond` in the selectable registry. Keep SVG rendering in `wisp.tsx`, use an exhaustive switch with an `assertNever`-style guard, and preserve the current avatar palette values.
2. Add a pure exhaustive `messageSearchText(message)` helper. Index incoming/outgoing text, card labels and values, prompt question/options/answer, and intentionally exclude time separators. Add a helper that returns both match status and the display snippet so search does not rescan a matching chat.
3. Update `SearchDialog` to reuse those helpers for filtering and snippets. Preserve the existing All/Wisps/Messages behavior and empty-query behavior.
4. Extract clipboard request state into `use-copy-feedback.ts`. Await `navigator.clipboard.writeText`, report success only on resolution, provide an error state, associate status with the current chat ID, clear/restart one reset timer on repeated use, and clean it up on chat change/unmount.
5. Update the details button with an accessible success/error status. Do not implement template importing or protocol handling here.

**Validation**:

- `npm test -- src/lib/wisp-appearance.test.ts src/lib/message-search.test.ts src/hooks/use-copy-feedback.test.ts` → all tests pass.
- Add cases for every message discriminant, `diamond`, clipboard unavailable/rejected/resolved, repeated clicks, chat switch, and unmount.
- `rg -n 'type WispShape' shared/conversations.ts` → exactly one declaration derived from `WISP_SHAPE_IDS`; renderer and backend import it.
- `rg -n '"diamond"' shared/conversations.ts src/components/wisp.tsx` → shared registry and renderer both contain the shape; the appearance test proves `WISP_SHAPES` exactly matches the shared tuple.
- Run all global validation commands.

**Exit criteria**:

- Every visible non-time message variant can be found and produces a relevant snippet.
- The Wisp picker and randomizer can select every supported shape.
- Clipboard UI never announces a failed copy as successful and does not leak status across chats.

**Suggested commit message**: `fix(ui): align search, avatars, and clipboard feedback`

**Phase-specific STOP conditions**:

- Product intent says `diamond` was deliberately hidden; document that decision and remove it from the public type instead of exposing it.
- Template links need a real protocol/import contract; defer that to a separate approved feature rather than inventing it here.

---

## Phase 03 — Centralize panel layout and resize lifecycle

**Goal**: Give each resizable panel one named specification and guarantee cleanup for every pointer termination path.

**Audit coverage**: finding 07.

**Scope**:

- Create `src/lib/layout.ts` and `src/hooks/use-resizable-panel.ts` with tests.
- Modify `src/App.tsx`, `src/components/sidebar.tsx`, `src/components/details-panel.tsx`, `src/lib/ui-classes.ts`, and `styles.css` only as needed.
- Preserve current dimensions: sidebar default 280, min 220, max 400, collapsed 68, mobile expanded 220; details default 318, min 280, max 480.

**Implementation steps**:

1. Define typed, read-only `SIDEBAR_LAYOUT` and `DETAILS_LAYOUT` specifications. Separate responsive-only dimensions from draggable bounds so they are not conflated.
2. Implement `useResizablePanel` using pointer capture where available and one idempotent cleanup path for `pointerup`, `pointercancel`, `lostpointercapture`, `window.blur`, and unmount.
3. Make the hook clamp widths from the specification and manage the global `body.resizing` state. It must not leave document listeners or selection suppression behind.
4. Feed visual minimum/collapsed/mobile dimensions through inline CSS custom properties so Tailwind classes and JavaScript consume the same named values. Keep breakpoint values in CSS when they are purely responsive.
5. Replace both `startResize` call sites and delete the root-level helper.

**Validation**:

- Hook tests cover left/right direction, min/max clamping, pointer up, pointer cancel, lost capture, blur, and unmount.
- `rg -n 'startResize|setValue.*Math\.min|max\(min' src/App.tsx` → no matches.
- `rg -n '\b(220|280|318|400|480)\b' src/App.tsx src/components/sidebar.tsx src/components/details-panel.tsx` → no duplicated behavioral layout literals outside the approved layout module/CSS variable declarations.
- Run all global validation commands.
- Manual Electron smoke: resize both panels, release outside the window, switch chats mid-drag, collapse/expand the sidebar, and confirm cursor/selection behavior recovers.

**Exit criteria**:

- Logic and rendered constraints originate from named layout specifications.
- All pointer termination paths remove listeners and `body.resizing`.
- Current responsive behavior and bounds remain visually unchanged.

**Suggested commit message**: `refactor(ui): centralize resizable panel layout`

**Phase-specific STOP conditions**:

- Pointer capture behaves differently in Electron from jsdom assumptions; reproduce in the app and adjust the lifecycle without adding parallel document-global handlers.

---

## Phase 04 — Centralize current-user and release metadata

**Goal**: Remove identity and version literals from feature components while establishing explicit future integration boundaries.

**Audit coverage**: finding 09.

**Scope**:

- Create `src/config/app-metadata.ts` and `src/fixtures/demo-session.ts` with tests.
- Modify `vite.config.mts`, `vitest.config.mts`, `src/vite-env.d.ts`, `src/App.tsx`, `src/components/sidebar.tsx`, and `src/components/app-settings-dialog.tsx`.
- Do not add authentication or a preload bridge in this phase.

**Implementation steps**:

1. Define a typed `CurrentUser` contract and a clearly named `DEMO_CURRENT_USER` fixture containing the existing demo identity. Components must receive or import the typed fixture boundary rather than embed identity strings.
2. Do not reintroduce the per-user mock greeting removed when the `main` integration moved conversations into the backend. Keep `givenName` available on `CurrentUser` for a future reviewed greeting/runtime boundary.
3. Expose package name/version to renderer builds through typed Vite `define` constants sourced from `package.json`. Do not duplicate the version in source code.
4. Render About metadata from that build-time source. Record in a maintenance comment that a later preload bridge may replace it with `app.getVersion()` in packaged builds.
5. Add tests proving sidebar and settings use injected user metadata, the About view uses injected application metadata, and the build constants match `package.json`.

**Validation**:

- `rg -n 'John Doe|john\.doe@example\.com|Hey John|Version 0\.1\.0' src/App.tsx src/components` → no matches.
- `rg -n '0\.1\.0' src vite.config.mts` → no renderer literal matches; `package.json` remains authoritative.
- Run all global validation commands.

**Exit criteria**:

- Current-user data has one typed fixture source.
- Release metadata has one package-derived source.
- No auth, account, or Electron API is exposed prematurely.

**Suggested commit message**: `refactor(app): centralize user and release metadata`

**Phase-specific STOP conditions**:

- Loading `package.json` in `vite.config.mts` breaks config typechecking or Node 22 module semantics; choose a typed `createRequire`/build-define approach rather than importing metadata in renderer runtime.

---

## Phase 05 — Model Wisps and circles as discriminated variants

**Goal**: Make invalid Wisp/circle field combinations unrepresentable and split type-specific creation/editing UI.

**Audit coverage**: finding 14 and the identifier-policy portion of the hardcoded-value audit.

**Scope revision (2026-09-01)**: The shared Electron conversation boundary was added after
the planning baseline. `src/chat-data.ts` now re-exports the canonical types from
`shared/conversations.ts`, and Electron validates, normalizes, stores, and mutates those
records. This phase therefore migrates the shared contract and all of its renderer and
Electron consumers together. It does not redesign the transport, persistence adapter,
agent runtime, or mutation semantics assigned to later phases.

**Scope**:

- Modify the canonical domain and IPC request types in `shared/conversations.ts` and the
  affected API surface in `shared/contracts.ts`; keep `src/chat-data.ts` as the renderer
  re-export boundary.
- Modify `electron/ipc/validators.ts`, `electron/backend/conversation-normalizer.ts`,
  `electron/backend/conversation-repository.ts`, and
  `electron/backend/conversation-service.ts` so creation, partial updates, validation,
  normalization, and stored records preserve the discriminated variants. Update their
  existing tests and fixtures. Do not otherwise change IPC channels, repository storage
  location, agent execution, streaming, approval behavior, or deletion behavior.
- Modify `src/hooks/use-conversations.ts`, `src/App.tsx`,
  `src/lib/circle-members.ts`, and every feature component that reads `isCircle`,
  Wisp-only appearance, circle membership, or protected/default chat policy. Preserve
  the current backend-owned conversation state flow.
- Create `src/lib/chat-schema.ts`, `src/components/create-wisp-form.tsx`, `src/components/create-circle-form.tsx`, `src/components/wisp-details.tsx`, and `src/components/circle-details.tsx` with tests.
- Preserve valid `wisp-bot-ui-v3` state and existing backend conversation files through
  explicit legacy conversion at their current ingestion boundaries; do not replace or
  redesign either storage adapter.
- Update shared, Electron, renderer, and test fixtures that construct conversation
  records. Changes to message streaming are limited to narrowing on `chat.kind` where
  required by the new types.

**Target type shape**:

```ts
interface ChatBase {
  id: ChatId;
  name: string;
  label: string;
  description: string;
  notifyOnUpdatesEnabled: boolean;
  preview: string;
  timestamp: string;
  messages: ReadonlyArray<Message>;
  systemRole?: "chief";
  isActive?: boolean;
  unread?: boolean;
}

interface WispChat extends ChatBase {
  kind: "wisp";
  color?: string;
  avatarImage?: string;
  shape: WispShape;
}

interface CircleChat extends ChatBase {
  kind: "circle";
  memberIds: ReadonlyArray<ChatId>;
}

type Chat = WispChat | CircleChat;
```

Equivalent names are acceptable, but `kind` must be the discriminant, circle membership must not exist on Wisps, and Wisp appearance must not exist on circles.

**Implementation steps**:

1. Introduce the discriminated types plus `NewWisp`, `NewCircle`, and variant-safe
   partial update types in `shared/conversations.ts`. Keep shared fields in a base
   interface; do not retain `isCircle` as a parallel runtime flag. Ensure the shared
   request contracts cannot create or patch fields belonging to the other variant.
2. Add exhaustive type guards/helpers for `kind`, default-chat selection, and deletion
   eligibility. Represent the bundled/legacy chief policy through explicit metadata
   rather than `id === "chief"` comparisons; do not create a bundled chief when the
   current state is empty.
3. Convert the current empty-state producers, creation path, test fixtures, and any
   remaining demo or fallback conversation producers to the new shape. There is no
   longer an `initialChats` export to migrate.
4. Extend legacy conversion at both ingestion boundaries so `isGroup` and `isCircle`
   renderer state and backend conversation files become `kind` records. Preserve IDs,
   member order, messages and message metadata, user-customized appearance, and explicit
   empty circles. Keep decoding idempotent for records already using `kind`.
5. Update IPC parsing, backend normalization, repository/service creation and partial
   updates, and renderer API hooks to consume the shared variant-safe inputs without
   weakening runtime validation.
6. Split Wisp and circle creation bodies into explicit components under the existing
   dialog shell. Each form owns only fields valid for its type and submits a typed input.
7. Split details sections similarly. Update `ChatAvatar`, `ChatPanel`, `Sidebar`,
   `SearchDialog`, conversation streaming guards, and member helpers to narrow on
   `chat.kind`.
8. Add compile-time exhaustiveness and runtime characterization tests for both variants,
   both legacy record formats, IPC rejection of mixed variant fields, backend-file
   migration, and renderer creation/editing paths.

**Validation**:

- `rg -n 'isCircle' shared electron src --glob '!src/lib/chat-schema.ts' --glob '!src/lib/chat-schema.test.ts'` → no matches except explicitly named legacy decoder keys/tests.
- `rg -n 'AgentSettings' shared electron src` → no matches unless retained solely as a deprecated migration input type inside `chat-schema.ts`.
- Tests verify Wisp objects cannot carry `memberIds`, circle objects cannot carry
  `shape`/`avatarImage`/`color`, variant-specific patches cannot cross kinds, legacy
  renderer and backend records migrate, invalid mixed IPC payloads are rejected, chief
  policy is metadata-driven, and both create/edit paths render.
- Run the existing conversation migration, repository, service, stream, and application
  boundary suites in addition to the new schema/component tests.
- Run all global validation commands.

**Exit criteria**:

- All current behavior uses the discriminated union.
- Existing valid renderer and backend data migrates without silent loss.
- Creation and details UI are explicit variants, not a large boolean-mode component.
- Chat IDs are opaque identity, not policy flags.
- The shared IPC contract, Electron runtime, and renderer agree on the same canonical
  variants; mixed-kind payloads fail at the boundary.

**Suggested commit message**: `refactor(domain): separate Wisp and circle models`

**Phase-specific STOP conditions**:

- A valid legacy record cannot be mapped deterministically.
- A type change requires dropping messages, membership, or user-customized appearance.
- The migration would require resetting or relocating the backend conversation store.
- Variant safety would require weakening an IPC validator or accepting mixed-kind
  partial updates.
- A component begins duplicating shared form structure that belongs in an existing UI primitive; record it for Phase 09 rather than expanding this phase.

---

## Phase 06 — Make workspace mutations preserve entity integrity

**Goal**: Centralize chat mutations in pure actions, prevent ID reuse, and make deletion update every dependent reference atomically.

**Audit coverage**: finding 02.

**Scope revision (2026-09-01)**: The Electron conversation repository became the
authoritative graph and mutation boundary after the planning baseline. The renderer now
receives backend snapshots through `useConversations`; introducing the originally
planned renderer-owned `WorkspaceState` reducer would create a conflicting second state
model. This phase therefore extracts pure graph transitions behind the existing Electron
repository and keeps only deterministic active-selection policy in the renderer. It does
not change IPC channels, persistence format, agent runtime orchestration, or the
renderer's request queue.

**Scope**:

- Create `electron/backend/workspace-actions.ts` and tests containing pure, exhaustive
  transitions over the canonical conversation graph for create, update, delete,
  mark-read, append-message, and answer-prompt behavior.
- Modify `electron/backend/conversation-repository.ts` to apply those transitions inside
  its existing serialized, rollback-capable persistence transaction. Preserve record
  metadata, application-session identity, archive behavior, and message-ID injection at
  the repository boundary.
- Create renderer selection/identity helpers under `src/features/workspace/` with tests,
  and modify `src/App.tsx` plus creation/deletion consumers to use opaque IDs and
  deterministic active selection. Continue treating `useConversations` and backend
  snapshots as the renderer source of truth.
- Modify `src/lib/circle-members.ts` only if shared reference helpers are required.
- Do not move request queues, streaming state, agent timers/lifecycle, IPC transport, or
  persistence ownership; Phase 08 owns runtime request extraction.

**Implementation steps**:

1. Define an exhaustive pure backend action layer over conversation records for create,
   update, mark-read, delete, append-message, and answer-prompt. Keep filesystem/session
   side effects in the repository and agent lifecycle side effects in the service.
2. Replace name-derived, reusable IDs for new entities with opaque immutable IDs from an
   injected renderer ID factory. Preserve all existing persisted IDs and keep message,
   approval, and backend session ID factories unchanged.
3. Make delete one pure graph transition, applied within one repository transaction, that:
   - rejects deletion when explicit policy says the entity is protected;
   - removes the entity;
   - removes its ID from every circle;
   - leaves unrelated message and member order unchanged.
4. Make renderer selection helpers choose the next active chat deterministically from
   backend snapshots after selection, creation, or deletion, without mirroring the chat
   graph in renderer reducer state.
5. Move append-message, prompt-answer, update, and mark-read record mutation into the
   pure backend action layer. Missing/deleted targets remain repository `not_found`
   results at the IPC boundary, while the pure helpers themselves are no-ops.
6. Update `App` to use the opaque ID factory and selection helpers without deriving
   identity from names or nesting state updates.

**Validation**:

- Pure backend action tests cover delete member, delete circle, protected chat, empty
  result, duplicate/member pruning, update-kind mismatch, append to missing chat, and
  prompt answer. Repository tests verify rejection/rollback and archive behavior remain
  intact.
- Renderer selection tests cover deleting the active and non-active chat, selecting from
  an empty result, and preferring the metadata-defined chief.
- Regression test: delete a circle member, create another Wisp with the same display name, and confirm it is not added to the old circle.
- `rg -n 'uniqueAgentId|delete next\[' src/App.tsx electron/backend/conversation-repository.ts` → no matches.
- `rg -n 'setChats|useReducer' src/App.tsx src/hooks/use-conversations.ts` → no renderer-owned graph state.
- Run all global validation commands.

**Exit criteria**:

- Every entity mutation flows through one pure, tested action layer.
- New IDs are not derived from display names and are not reused.
- Deletion cannot leave live circle references or nested state-update side effects, and
  protected-entity policy is enforced in the authoritative backend boundary.
- The renderer does not duplicate the backend-owned conversation graph.

**Suggested commit message**: `fix(domain): preserve chat lifecycle integrity`

**Phase-specific STOP conditions**:

- Template-link compatibility requires stable human-readable IDs; stop and define a separate public template identifier rather than keeping mutable entity IDs.
- A pure graph transition cannot be applied inside the repository's current serialized
  rollback transaction without changing the persistence format; defer that redesign to
  Phase 07 rather than bypassing atomic persistence.

---

## Phase 07 — Add validated, failure-aware persistence

**Goal**: Harden the authoritative Electron conversation store and make the remaining renderer-preference persistence validated and failure-aware.

**Audit coverage**: finding 03.

**Scope revision (2026-09-02)**: The Electron conversation repository became the
authoritative graph and persistence boundary before this phase. It already serializes
mutations, writes atomically, rolls in-memory state back on write failure, migrates
schema versions 1–3 to version 4, preserves corrupt files, and exposes conversation
load/mutation failures through IPC and `useConversations`. Reintroducing the originally
planned full graph in renderer `localStorage` would create a second source of truth and
weaken the current boundary. This phase therefore hardens the existing main-process
repository and limits renderer persistence work to application preferences. The legacy
`wisp-bot-ui-v3` blob remains an import-only migration source.

**Scope**:

- Create typed storage-policy and preference-persistence helpers under
  `electron/backend/` and `src/features/persistence/`, with tests.
- Modify `electron/backend/conversation-normalizer.ts`,
  `electron/backend/conversation-repository.ts`, `electron/backend/atomic-file.ts`,
  `src/hooks/use-conversations.ts`, `src/App.tsx`, `src/lib/app-preferences.ts`, shared
  state/contracts when needed, and existing settings/status UI.
- Keep conversations in the Electron repository and preferences in renderer
  `localStorage`; do not introduce a renderer-owned conversation graph, IndexedDB, or
  another schema library unless the existing explicit decoders prove insufficient.
- Preserve all valid schema-v1 through schema-v4 repository files and valid legacy-v3
  renderer imports. Never delete the legacy blob until the main-process import and
  durable write have both succeeded.

**Implementation steps**:

1. Centralize named limits and policy constants for repository blob size, entity/message
   counts, per-field text, avatar data URLs, and legacy/preference storage keys. Document
   them as temporary local-desktop limits rather than scattering literals.
2. Continue decoding filesystem and legacy renderer JSON as `unknown`. Strengthen the
   existing explicit normalizers to validate record-key equality, discriminants, shape
   IDs, timestamps, message variants, unique and live circle-member references, and the
   exact allowed `data:image/webp;base64,` avatar form. Reject an invalid graph as a
   whole; never pass a partially typed graph to either process.
3. Reject oversized repository and legacy blobs before parsing. Preserve an untouched,
   recoverable source before any schema rewrite; write schema 4 only after complete
   validation, and do not silently discard a source file when backup creation fails.
4. Keep repository mutations serialized and durably awaited rather than debouncing
   authoritative conversation writes. Preserve atomic replacement and rollback, remove
   orphan temporary files when safe, and surface load/save failures through the existing
   typed IPC/controller error path.
5. Replace `App`'s direct preference `localStorage` reads/writes with a small adapter and
   hook. Normalize decoded preferences, return explicit load/save results, debounce
   ordinary writes, and provide an idempotent latest-snapshot `flush()` for
   `beforeunload` and effect cleanup.
6. Make preference `idle | saving | saved | error` state and repository recovery/save
   errors observable in an existing accessible settings/status surface without claiming
   success before durable completion.
7. Make legacy renderer conversation import delete `wisp-bot-ui-v3` only after a
   successful main-process initialization; retain it on validation or persistence
   failure as the rollback copy.

**Validation**:

- Repository/normalizer tests cover valid v4, schema-v1 through schema-v3 upgrades,
  malformed JSON, non-object input, missing fields, malformed message variants,
  key/ID mismatch, duplicate or missing circle-member references, unsafe avatar URLs,
  oversized payloads, failed backup, failed atomic save, and rollback.
- Preference/legacy-import tests cover malformed and oversized JSON, normalized partial
  preferences, quota errors, debounce replacement, close-before-delay flush, and legacy
  retention on initialize failure.
- `rg -n 'localStorage|STORAGE_KEY|JSON\.parse|JSON\.stringify' src/App.tsx` → no matches.
- `rg -n 'as \{ chats\?: ChatCollection \}|as ChatCollection' src/hooks src/features` →
  no unchecked persistence assertions.
- Run all global validation commands.

**Exit criteria**:

- No unvalidated persisted conversation or preference reaches components.
- Corrupt or oversized storage cannot crash the renderer or overwrite its only
  recoverable source.
- Conversation write failures and preference save/flush failures are observable and
  tested.
- Valid repository versions 1–3 and renderer v3 imports survive migration with a
  rollback copy.

**Suggested commit message**: `feat(persistence): validate and monitor local state`

**Phase-specific STOP conditions**:

- The existing explicit decoders cannot express the required validation without unsafe
  casts; stop and review a schema dependency rather than adding ad hoc assertions.
- The migration would overwrite, delete, or rename away the only copy of user state
  without first proving a recoverable backup exists.
- Product requirements demand unbounded messages/media; stop because localStorage is then the wrong backend and advance the main-process repository design first.

---

## Phase 08 — Extract the workspace controller and request runtime

**Goal**: Keep `App` as a composition root, consolidate renderer workspace orchestration, localize composer state, and accurately represent concurrent requests across the existing Electron agent boundary.

**Audit coverage**: findings 05 and 06.

**Scope revision (2026-09-02)**: The repository now has a provider-neutral
`ConversationAgent`/factory contract, a concurrency-limited `AgentRegistry`, a
deterministic `FakeConversationAgent`, a real Pi-backed adapter, typed IPC request/event
contracts, and a renderer stream reducer. `useConversations` already stages outgoing
messages, buffers sequenced startup events, reconciles durable snapshots, ignores stale
event sequences, and exposes cancellation. Adding the originally planned renderer
`AgentGateway` and `MockAgentGateway` would duplicate the authoritative Electron
runtime and regress the real-agent boundary. This phase therefore retains that backend
runtime, extracts the remaining renderer orchestration from `App`, localizes composer
state, and closes renderer concurrency/lifecycle gaps around the existing contracts.

**Scope**:

- Create `src/features/workspace/use-workspace-controller.ts` and
  `src/components/chat-composer.tsx` with focused tests.
- Modify `src/App.tsx`, `src/hooks/use-conversations.ts`,
  `src/lib/conversation-stream.ts`, `src/components/chat-panel.tsx`, and typed prop
  contracts for `Sidebar`, `SearchDialog`, `DetailsPanel`, and settings as needed.
- Modify the existing shared event/request contracts, Electron `AgentRegistry`,
  conversation service, or fake-agent tests only when required to make request identity,
  cancellation, or late-event behavior deterministic. Do not replace the existing
  `ConversationAgent` abstraction or Pi adapter.
- Consume the Phase 06 backend action boundary and Phase 07 persistence adapter; do not
  create a renderer conversation reducer/store or a second transport.

**Implementation steps**:

1. Treat immutable `requestId` plus `conversationId` as the end-to-end request identity.
   Make renderer acknowledgement/pending state request-aware so completion, failure, or
   persistence of one request cannot clear another request in the same or a different
   conversation. Derive per-chat queued/working presentation from those request-aware
   structures and backend status rather than a single mutable request slot.
2. Keep sequenced event reduction pure and exhaustive. Ignore stale events and events
   for conversations deleted from the latest backend snapshot; ensure a late completion,
   cancellation, or error cannot recreate transient state for a missing conversation or
   settle an unrelated request.
3. Preserve the backend lifecycle boundary: per-conversation FIFO work and cross-Wisp
   concurrency remain in `AgentRegistry`; deletion disposes/cancels the agent before the
   repository graph is removed; unmount only unsubscribes renderer listeners and does
   not pretend to cancel backend-owned work.
4. Implement `useWorkspaceController` to compose `useConversations`, persisted
   preferences, tool-policy synchronization, active selection, opaque creation IDs, and
   typed create/update/delete/message/prompt/approval actions. Do not expose raw graph or
   preference setters to `App`.
5. Keep deterministic active selection and close dependent UI after deletion. Await
   create/delete results before applying selection changes, and ensure failed mutations
   do not leave the UI pointing at a nonexistent optimistic entity.
6. Extract `ChatComposer` with draft and textarea focus state owned below `App`. Key or
   reset it by active conversation so chat switches clear the draft and focus the new
   composer without a root-level timer. Preserve Enter-to-send, Shift+Enter, disabled
   circle behavior, queue/stop controls, and accessible status text.
7. Reduce `App` to controller creation, resizable layout, dialog visibility, keyboard
   shortcuts, and component composition. Keep explicit props; do not add context merely
   to avoid a short parent/child prop chain.

**Validation**:

- Pure renderer/runtime tests cover two requests in one chat, requests in two chats,
  out-of-order and duplicate events, failure, cancellation, delete-before-reply, and
  late-event no-op. Existing backend tests continue to cover per-Wisp FIFO,
  cross-Wisp concurrency, queue limits, and deletion during active work.
- Hook/controller tests cover startup event buffering, mutation failure, create/delete
  selection, tool-policy synchronization, unmount listener cleanup, and independent
  acknowledgement of concurrent requests.
- Composer/component tests cover Enter, Shift+Enter, chat-switch reset/focus, circle
  disablement, queue/stop controls, and verify typing does not rerender a mocked
  unrelated sidebar.
- `rg -n 'localStorage|setTimeout|replyTimersRef|workingChatId|setChats|setPreferences' src/App.tsx` → no matches.
- `rg -n 'On it\.|Hey .*I.m here' src/App.tsx src/components` → no fixed runtime replies in UI/composition files.
- Run all global validation commands.

**Exit criteria**:

- `App` contains no domain mutation, persistence, policy synchronization, composer
  state, timer, or agent-event reconciliation logic.
- Request-aware pending state is correct for concurrent same-chat and cross-chat work,
  and late events cannot resurrect deleted state.
- The Electron `ConversationAgent` boundary remains replaceable without changing
  presentation components or the workspace controller contract.

**Suggested commit message**: `refactor(app): extract workspace controller and composer`

**Phase-specific STOP conditions**:

- The controller begins becoming a second persistence store or reducer.
- Context is introduced only to avoid a few explicit props; keep the smaller typed hook boundary.
- Deterministic request cancellation requires renderer timer ownership or a second
  transport; stop and revise the existing Electron request contract instead.
- Extracting the controller would move repository or agent ownership back into the
  renderer; keep those responsibilities behind IPC.

---

## Phase 09 — Build semantic settings and surface primitives

**Goal**: Replace repeated neutral color literals and settings markup with semantic tokens and composable, accessible primitives.

**Audit coverage**: finding 13.

**Scope**:

- Modify `styles.css`, `src/lib/ui-classes.ts`, and feature components containing repeated neutral surface colors or settings row/card/field structures.
- Create `src/components/settings/settings-primitives.tsx` and focused tests.
- Reuse existing shadcn/Base UI wrappers; do not bulk-edit unused generated wrappers.
- Preserve avatar palette values, SVG geometry, and intentional product colors.

**Implementation steps**:

1. Inventory literal colors by semantic role—base/raised surface, selected/hover surface, subtle/strong text, separators, controls, focus, and destructive feedback. Map to existing tokens first; add a token only when no existing semantic role fits.
2. Add light/dark tokens in `styles.css` and expose them through Tailwind theme names. Do not encode component names such as `--sidebar-search-gray`; use reusable semantic roles.
3. Create composable `SettingsGroup`, `SettingsCard`, `SettingsRow`, `SettingsRowCopy`, and `SettingsField` primitives using children rather than boolean customization props. Provide explicit variants only where DOM semantics genuinely differ.
4. Replace raw settings class exports and repeated markup in app settings, general settings, Wisp details, and circle details. Prefer the existing `Button`, `Input`, `Select`, and `ToggleSwitch` wrappers.
5. Consolidate recurring icon-button behavior through the existing `Button` variants or one explicit primitive; remove `iconButton` string use when behavior/semantics are identical.
6. Replace feature-local neutral hex pairs with semantic classes. Leave documented exceptions in `wisp-appearance.ts`, SVG masks, and initial chat avatar data.

**Validation**:

- Component tests cover group labeling, label/control association, switch accessible names, row actions, and destructive variant semantics.
- `rg -n '#[0-9a-fA-F]{3,8}' src/components --glob '!wisp.tsx'` → only reviewed, documented product/SVG exceptions remain.
- `rg -n 'settingsCard|settingsRow|settingsRowCopy|detailsField(Control)?' src/lib/ui-classes.ts` → no obsolete raw settings structure exports.
- Run all global validation commands.
- Manual visual QA in light/dark and reduced-motion modes at desktop, 900px, and 620px widths. Compare sidebar, messages, dialogs, selected states, destructive controls, and focus rings.

**Exit criteria**:

- Recurring settings DOM comes from components, not exported class-name fragments.
- Neutral UI colors use semantic tokens.
- Intentional hierarchy remains visually distinct in both themes.
- Product avatar colors and one-off SVG geometry remain explicit data.

**Suggested commit message**: `refactor(ui): add semantic settings primitives`

**Phase-specific STOP conditions**:

- A mechanical token replacement collapses visibly different semantic levels.
- A new primitive needs more than two boolean mode props; use explicit variants or composition instead.
- Visual QA cannot be performed; do not approve the phase based only on typechecking.

---

## Phase 10 — Harden Electron navigation, permissions, CSP, and loading

**Goal**: Make renderer trust decisions explicit, default-deny unexpected capabilities, and handle startup/navigation failures predictably.

**Audit coverage**: findings 04 and 12.

**Scope**:

- Modify `electron/main.ts`, `index.html`, `vite.config.mts`, and Electron test/config files.
- Create pure policy helpers under `electron/security-policy.ts` and tests under `tests/electron/`.
- Do not add preload/IPC APIs yet.

**Reference**: Follow the current official Electron security checklist at `https://www.electronjs.org/docs/latest/tutorial/security`, particularly CSP, permissions, navigation, new-window limits, context isolation, and sandboxing.

**Implementation steps**:

1. Accept `VITE_DEV_SERVER_URL` only when `app.isPackaged === false` and only when parsed URL origin exactly equals `http://127.0.0.1:5173`. Reject credentials, alternate hosts/ports, and malformed values. Packaged mode must always load bundled content.
2. Keep `contextIsolation: true`, `nodeIntegration: false`, and explicitly set `sandbox: true`.
3. Deny renderer-created windows with `webContents.setWindowOpenHandler`. Prevent navigation outside the loaded file origin or exact development origin using parsed URL/origin comparisons.
4. Install both permission-check and permission-request handlers. Default-deny everything; allow only the minimum clipboard-sanitized-write permission needed by the current local renderer. Do not allow microphone/media until a reviewed real feature requests it.
5. Add a restrictive production CSP covering self-hosted scripts/styles/fonts plus required `data:`/`blob:` images. Ensure development HMR uses a separately generated development policy rather than weakening production CSP.
6. Wrap initial and activation window creation in one observed error boundary. Log non-sensitive diagnostics and show a deterministic error/quit path without retry loops during shutdown.
7. Keep URL validation and policy decisions in pure functions with tests; Electron event wiring remains thin.

**Validation**:

- Tests cover packaged-with-env, exact dev origin, lookalike host, alternate port, credentials, malformed URL, allowed/blocked navigation, and permission allowlist.
- `rg -n 'void createWindow|void app\.whenReady\(\)\.then' electron/main.ts` → no discarded startup/load promises.
- `rg -n 'contextIsolation: true|nodeIntegration: false|sandbox: true' electron/main.ts` → all three explicit protections present.
- Production build output contains the restrictive CSP and no broad `default-src *`, `script-src *`, or unnecessary `unsafe-eval`.
- Run all global validation commands.
- Manual dev smoke confirms HMR still connects; packaged build loads local assets, clipboard feedback works, unexpected navigation/popups are denied, and a missing renderer asset produces the intended failure UX.

**Exit criteria**:

- Packaged builds cannot load a runtime-provided remote dev URL.
- Navigation, windows, and permissions are explicit default-deny policies.
- Production CSP is restrictive without breaking the app.
- Every window-load promise terminates in success or handled failure.

**Suggested commit message**: `security(electron): enforce renderer trust boundaries`

**Phase-specific STOP conditions**:

- CSP requires `unsafe-eval` in production.
- Clipboard cannot work without granting a broader permission than needed.
- A proposed fix disables isolation, sandboxing, web security, or sender/origin checks.

---

## Phase 11 — Refresh repository documentation and license

**Goal**: Make contributor documentation match the implemented architecture and repair the broken license link.

**Audit coverage**: finding 15.

**Scope**:

- Modify `README.md`.
- Create `LICENSE` with the canonical MIT text.
- Update this plan's completed status rows only; do not rewrite historical migration notes.

**Implementation steps**:

1. Update prerequisites and commands to include test, lint, format, and build gates established in Phase 01.
2. Replace the stale project tree with the actual feature, domain, persistence, service, shared-contract, Electron, and test layout after Phases 02–10.
3. Document that `template/` is a non-runtime prototype/reference and identify the maintained runtime sources.
4. Document current mock versus connected behavior honestly, including which settings remain decorative or locally persisted.
5. Add the canonical MIT license. Recommended holder is `Gustavo Miranda` and year `2026`; stop for confirmation if legal ownership differs.
6. Add a concise architecture section describing renderer presentation, workspace controller/reducer, persistence adapter, mock gateway, and Electron trust boundary.

**Validation**:

- `test -f LICENSE` → exits 0.
- `rg -n '\[MIT\]\(LICENSE\)' README.md` → one valid link.
- Every documented npm command exists in `package.json` and exits as documented.
- Every path shown in the project tree exists.
- Run all global validation commands.

**Exit criteria**:

- README no longer claims `App.tsx` contains UI components or omits the primary architecture.
- `template/` cannot be mistaken for runtime source.
- License metadata and the repository file agree.

**Suggested commit message**: `docs: refresh architecture and license`

**Phase-specific STOP conditions**:

- The legal copyright holder/year is not confirmed.

---

## Phase 12 — Make circle membership editable

**Goal**: Complete the create/edit symmetry for circles using the integrity rules already established by the reducer.

**Roadmap coverage**: editable circle membership direction.

**Scope**:

- Extract or reuse `src/components/circle-member-picker.tsx`.
- Modify `src/components/create-circle-form.tsx`, `src/components/circle-details.tsx`, workspace actions/reducer, and tests.
- Do not add circles as members or introduce nested circles.

**Implementation steps**:

1. Extract the existing create-time member selection UI into a controlled `CircleMemberPicker` that accepts available Wisps, selected IDs, and a typed change callback.
2. Add a reducer action to replace a circle's membership atomically. Deduplicate IDs, preserve selected order, and reject missing IDs or circles.
3. Use the picker in both creation and details editing. Existing participant display may remain as the collapsed/read-only summary.
4. Ensure delete/member-pruning behavior from Phase 06 continues to hold while the editor is open.
5. Add accessible live feedback for member additions/removals and preserve keyboard operation.

**Validation**:

- Tests cover add/remove, duplicate prevention, missing member, circle-as-member rejection, member deletion while open, empty circle, order preservation, and persistence round-trip.
- Component tests cover keyboard selection and accessible removal labels.
- Run all global validation commands and manually verify circle avatars update immediately.

**Exit criteria**:

- Users can modify circle membership after creation.
- Invalid or stale member IDs cannot be introduced.
- Create and edit flows share one member-selection component.

**Suggested commit message**: `feat(circles): support editing membership`

**Phase-specific STOP conditions**:

- Product intent requires nested circles or role-based membership; stop and define that domain model before extending the picker.

---

## Phase 13 — Decide the real-agent runtime and IPC contract

**Goal**: Resolve provider, process, credential, event, cancellation, and failure semantics before privileged code is written.

**Roadmap coverage**: real-agent vertical slice design gate.

**Scope**:

- Create `docs/decisions/001-agent-runtime.md` and, if useful, `src/shared/agent-contract.ts` containing types only.
- No live provider call, credential storage, preload API, or IPC handler in this phase.

**Implementation steps**:

1. Document the selected first provider/runtime and why it is appropriate for one vertical slice. Record supported authentication, streaming, cancellation, retry, rate-limit, and error behavior.
2. Define a renderer-to-main request envelope and main-to-renderer event union with request ID, chat ID, event sequence, progress, reply, cancellation, and safe error variants.
3. Define ownership: renderer requests actions; Electron main owns credentials, provider clients, validation, cancellation, and audit hooks.
4. Specify contextBridge API names, IPC channel allowlist, sender/frame validation, request size limits, timeouts, idempotency, and redaction rules.
5. Define acceptance scenarios: send → progress → reply; cancel; provider rejection; network failure; rate limit; app close; deleted chat; renderer reload.
6. Identify exact credential storage for each supported OS. Plaintext files, renderer storage, environment values embedded in bundles, and logs are prohibited.

**Validation**:

- `docs/decisions/001-agent-runtime.md` contains sections for provider, trust boundaries, credentials, schemas, streaming, cancellation, errors, retries/idempotency, observability/redaction, tests, and rejected alternatives.
- Shared contract types, if created, pass typecheck and contain no provider SDK import.
- A security reviewer and product owner explicitly approve the ADR before Phase 14.

**Exit criteria**:

- A weaker executor can implement Phase 14 without choosing architecture or inventing security policy.
- Every privileged action and secret has one documented owner.

**Suggested commit message**: `docs(architecture): define agent runtime boundary`

**Phase-specific STOP conditions**:

- No provider or credential-storage mechanism has been selected.
- The proposed provider requires secrets in renderer code.
- Cancellation, streaming order, or sender validation remains ambiguous.

---

## Phase 14 — Deliver one real-agent vertical slice

**Goal**: Implement one send → progress → reply workflow through a typed, secure Electron boundary while retaining the mock gateway for development/tests.

**Roadmap coverage**: real-agent vertical slice implementation.

**Scope**:

- Follow the approved Phase 13 ADR exactly.
- Expected files include `electron/preload.ts`, `electron/agent-service.ts`, `electron/main.ts`, `src/shared/agent-contract.ts`, a renderer `ElectronAgentGateway`, the workspace controller, and focused tests/configuration.
- Implement one provider only; no provider marketplace, multi-model routing, or background scheduler.

**Implementation steps**:

1. Compile and register a sandbox-compatible preload exposing one narrow frozen API through `contextBridge`. Do not expose raw `ipcRenderer`, filesystem, shell, environment, or Electron modules.
2. Validate every request in main against the approved schema, sender/frame/origin, size limits, and known chat/request IDs.
3. Implement the selected provider behind the existing `AgentGateway` contract. Keep provider SDK/types out of presentation components.
4. Stream progress/reply/error events with monotonic request sequencing. Implement cancellation and ignore late provider events after cancel/delete/shutdown.
5. Store credentials only through the approved OS-safe mechanism. Redact secrets, prompt content, and sensitive tool outputs from ordinary logs.
6. Add renderer error/retry/cancel UI using the request runtime from Phase 08. Preserve the mock gateway as the default for tests and an explicit development mode.

**Validation**:

- Contract tests run the same success/failure/cancel scenarios against mock and Electron gateways.
- Main-process tests reject malformed payloads, unknown channels, wrong sender/origin, oversized input, duplicate request IDs, and late events.
- No secret values appear in source, fixtures, snapshots, console output, or persisted renderer state.
- Run all global validation commands.
- Manual Electron test verifies success, progress, cancellation, offline failure, provider rejection, app close, and renderer reload.

**Exit criteria**:

- One real request completes through renderer → preload → main → provider → renderer.
- Presentation components are provider-neutral.
- Mock and real gateways satisfy the same contract.
- Security boundaries approved in Phase 13 remain intact.

**Suggested commit message**: `feat(agent): add first secure execution flow`

**Phase-specific STOP conditions**:

- The approved ADR has drifted or is incomplete.
- Provider SDK behavior cannot satisfy cancellation/redaction requirements.
- Testing requires live credentials in CI; replace with a fake provider, never store credentials.

---

## Phase 15 — Enforce auto-review authorization and audit logging

**Goal**: Convert decorative allow/ask/block preferences into main-process enforcement with explicit approvals and a redacted decision trail.

**Roadmap coverage**: enforceable auto-review direction.

**Scope**:

- Create shared capability/action types, main-process policy evaluation and audit storage, typed approval IPC/events, renderer approval UI, migration logic, and tests.
- Modify `src/lib/app-preferences.ts`, general settings, agent service, preload contract, workspace controller, and persistence schemas.
- Do not authorize actions solely by matching free-form natural-language strings.

**Implementation steps**:

1. Define a finite capability vocabulary based on the first provider's actual actions. Each request must carry a structured capability and bounded resource scope.
2. Define deterministic precedence: explicit `block` wins; then `ask`; explicit `allow` applies only to its exact scope; unmatched actions require approval. No action executes without an allow result or an approved ask.
3. Migrate existing natural-language rules to disabled legacy labels or `ask` entries requiring user confirmation. Never silently translate them to `allow`.
4. Evaluate policy in Electron main immediately before the privileged sink. Renderer decisions are UI hints only and cannot bypass main enforcement.
5. Add an approval queue with request summary, capability, scope, requesting Wisp, expiration, approve-once/deny controls, and safe cancellation.
6. Add an append-only audit record for request, matched policy, decision, actor, timestamp, and outcome. Redact credentials, message bodies, and sensitive outputs according to the Phase 13 policy.
7. Update settings copy to describe real precedence and enforcement accurately.

**Validation**:

- Table-driven policy tests cover exact allow, scoped mismatch, ask, block, conflicts, unmatched action, expired approval, duplicate approval, cancellation, and renderer bypass attempts.
- IPC tests prove execution cannot reach the provider/tool sink before main-process authorization.
- Migration tests prove no legacy free-text rule becomes automatic allow.
- Audit tests verify order, outcome, and redaction without secret values.
- Run all global validation commands and a manual approval-flow smoke test.

**Exit criteria**:

- Main process is the sole authorization authority.
- Every privileged action is allowed, explicitly approved, or blocked before execution.
- Decisions are reviewable without logging sensitive payloads.

**Suggested commit message**: `feat(security): enforce agent action approvals`

**Phase-specific STOP conditions**:

- The provider emits actions that cannot map to a structured capability.
- Product requests free-text rules as the sole enforcement mechanism.
- Audit requirements would store secrets or sensitive message content without an approved retention/redaction policy.

---

## Phase 16 — Decide packaging, signing, and update operations

**Goal**: Produce an approved distribution ADR before adding release tooling or credentials.

**Roadmap coverage**: installer/update beta design gate.

**Scope**:

- Create `docs/decisions/002-distribution.md`.
- No signing credentials, release upload, installer build, or update endpoint mutation in this phase.

**Implementation steps**:

1. Identify supported OS/architecture matrix and minimum versions. Do not assume macOS/Windows/Linux parity.
2. Evaluate current maintained Electron packaging options against those targets, signing/notarization support, auto-update support, Vite integration, artifact reproducibility, and maintenance burden. Record the selected tool and rejected alternatives.
3. Define application ID, artifact names, icons, version source, release channel names, update-feed ownership, rollout percentage, rollback behavior, and minimum supported version policy.
4. Define signing/notarization credential custody in CI secrets or an approved signing service. Document rotation and access; never put values in the repository.
5. Define release gates: CI green, clean tree, version/tag agreement, dependency audit, installer smoke, signature verification, checksum generation, staged promotion, and rollback drill.
6. Define data-migration compatibility requirements so updater rollback does not destroy newer persistence data.

**Validation**:

- ADR contains platform matrix, tool choice, signing, notarization, update feed, channels, rollback, persistence compatibility, credential custody, CI permissions, artifact retention, and rejected alternatives.
- Product/operations owner approves targets and channel policy.
- Security owner approves signing credential custody and CI permissions.

**Exit criteria**:

- Phase 17 has no unresolved tool, platform, credential, update-host, or rollback decision.

**Suggested commit message**: `docs(release): define desktop distribution strategy`

**Phase-specific STOP conditions**:

- Signing identities, supported platforms, or update hosting are unspecified.
- The chosen updater cannot safely coordinate with the persistence migration policy.

---

## Phase 17 — Produce signed installers and a staged update channel

**Goal**: Build reproducible platform installers, verify their signatures, and deliver updates through the approved staged channel.

**Roadmap coverage**: installer/update beta implementation.

**Scope**:

- Follow the approved Phase 16 ADR exactly.
- Modify packaging configuration, `package.json`, lockfile, CI release workflows, app icons/metadata, Electron update integration, About/update UI, and release documentation.
- Do not publish a public release until the user explicitly authorizes it.

**Implementation steps**:

1. Add the selected packager and configuration with package metadata sourced from Phase 04. Move build-only CLI/Tailwind tooling to development dependencies if the chosen packager otherwise includes it in shipped production modules; verify with artifact inspection.
2. Produce per-platform artifacts in CI from clean installs. Pin action/tool major versions and apply least-privilege workflow permissions.
3. Add signing/notarization from secret references only. Never echo secret values; mask tool output and upload only intended artifacts.
4. Generate checksums/SBOM if required by the ADR, verify signatures, and run installer launch/uninstall smoke tests on each target.
5. Implement the staged update client using the approved channel/feed. Make check/download/install states explicit, verify signatures, handle offline/error states, and never install untrusted artifacts.
6. Connect the existing About update control to real status and package version. Preserve a manual recovery/download path.
7. Exercise staged rollout and rollback in a non-public test channel before requesting public-release authorization.

**Validation**:

- `npm ci && npm run build && npm test && npm run lint && npm run format:check` → all exit 0 in release CI.
- Packaging command from the ADR produces the expected artifact matrix.
- Platform-native signature verification commands exit 0 for every artifact.
- Installed app reports the same version as `package.json`, launches local bundled content, loads/migrates persisted state, and passes one mock plus one real-agent smoke test.
- Update test covers check, download, signature verification, install/restart, offline failure, bad-signature rejection, staged promotion, and rollback.
- `npm audit --omit=dev --audit-level=high` → no unreviewed high/critical reachable runtime advisories.
- `git status --short` → no generated credentials or unintended artifacts are tracked.

**Exit criteria**:

- Reproducible, signed installers exist for every approved target.
- Update artifacts are authenticated, staged, observable, and rollback-capable.
- About metadata/update UI reports real package state.
- No release is published without explicit user approval.

**Suggested commit message**: `feat(release): add signed desktop distribution`

**Phase-specific STOP conditions**:

- A signing secret appears in logs, files, artifacts, or command arguments visible to untrusted jobs.
- Signature/notarization verification fails.
- The update test cannot reject a bad signature or cannot roll back safely.
- Publishing or promoting a channel would be required without explicit user authorization.

---

## Cross-phase test matrix

| Risk | Required coverage before completion |
|---|---|
| Legacy data | valid v3 migration, invalid/corrupt blobs, explicit empty circles, preserved messages/members |
| Entity lifecycle | opaque IDs, delete/recreate, member pruning, protected/default policy, deleted-target no-op |
| Async work | concurrent same/cross-chat, out-of-order completion, failure, cancellation, delete, unmount, app close |
| Search | incoming, outgoing, card, prompt question/options/answer, excluded time separators, snippets |
| Clipboard | unavailable, reject, resolve, repeat, chat switch, unmount |
| Resize | both directions, clamping, pointer up/cancel/lost capture, blur, unmount |
| Themes/UI | light, dark, system change, reduced motion, 1040px, 900px, 620px, keyboard/focus |
| Electron | dev/package URL resolution, navigation, popup, permissions, CSP, missing renderer, activation failure |
| Agent IPC | schema, sender/origin, size, sequence, stream, cancel, retry, rate limit, renderer reload |
| Authorization | allow/ask/block precedence, default ask, scope mismatch, bypass, approval expiry, audit redaction |
| Distribution | clean build, artifact matrix, signatures, install/uninstall, update, bad signature, rollback |

## Final done criteria

All boxes must be satisfied before this master plan is complete:

- [ ] Every phase is `DONE` or explicitly `REJECTED` with rationale.
- [ ] `npm test`, `npm run lint`, `npm run format:check`, `npm run typecheck`, and `npm run build` all exit 0.
- [ ] CI enforces the same commands from a clean `npm ci` install.
- [ ] No feature component contains current-user or release-version literals.
- [ ] No runtime feature logic uses `isCircle`; Wisp/circle types are discriminated.
- [ ] No direct localStorage, timer-based mock response, or raw chat mutation remains in `App.tsx`.
- [ ] Chat deletion prunes memberships, cancels work, and cannot retarget a recreated entity.
- [ ] Persistence fully decodes untrusted data and reports/flushes save failures.
- [ ] Search covers every visible content-bearing message type.
- [ ] Panel resize cleans up on every cancellation path.
- [ ] Repeated settings structures and neutral colors use semantic primitives/tokens.
- [ ] Electron production content, navigation, windows, permissions, CSP, preload, and IPC are default-deny and tested.
- [ ] Real-agent execution and auto-review enforcement follow approved ADRs.
- [ ] Signed installer/update delivery follows the approved distribution ADR.
- [ ] README and LICENSE accurately describe the final repository.
- [ ] No secret value is present in source, tests, logs, artifacts, documentation, or git diff.
- [ ] No phase was committed, pushed, released, or published without explicit user authorization.

## Maintenance notes

- Keep migrations additive and reversible. New schema versions must read the immediately previous version and preserve an untouched rollback copy until adoption is proven.
- Keep the renderer presentation-only for privileged operations. New agent tools must extend the typed main-process contract and authorization vocabulary before execution.
- Treat request IDs, entity IDs, and public template IDs as different concepts; do not make display names or mutable slugs identity again.
- Add new Wisp shapes/colors through the registry and exhaustive renderer tests. Avatar colors remain product data, not theme tokens.
- New settings surfaces should compose Phase 09 primitives. Do not restart a parallel set of class-string constants.
- Revisit transcript pagination/windowing and incremental search indexing only after real histories demonstrate measurable scale; the current mock dataset does not justify that complexity.
- Audit runtime dependencies and Electron advisories in release CI. The planning environment lacked Node/npm, so no current audit result is asserted here.
- After each completed phase, update its status row, stop for review, and suggest—not create—the listed commit.
